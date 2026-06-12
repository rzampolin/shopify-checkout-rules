/**
 * app.rules.$id.tsx — Rule builder
 *
 * Handles both "new" (id === "new") and editing an existing rule.
 * Supports:
 *  - Conditions: cartSubtotal, customerTag, productInCollection, quantity
 *  - Actions: percentageOff, fixedOff, tiered (simple 3-tier), bogo
 *  - enabled + stopIfApplied toggles
 *  - Drag-to-reorder rule priority within the full ruleset
 *  - Saves serialized ruleset to discount.server.ts
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  Button,
  TextField,
  Select,
  Checkbox,
  Banner,
  BlockStack,
  InlineStack,
  Text,
  Box,
  Badge,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect, useRef, useState } from "react";
import shopify from "../shopify.server";
import {
  loadRuleset,
  saveRuleset,
} from "../server/discount.server";
import type {
  Action,
  BogoAction,
  Condition,
  FixedOffAction,
  PercentageOffAction,
  Rule,
  Ruleset,
  TieredAction,
} from "~/lib/rule-engine/types.js";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const record = await loadRuleset(admin);
  const ruleset: Ruleset = record?.ruleset ?? { version: 1, rules: [] };
  const { id } = params;

  let rule: Rule | null = null;
  if (id !== "new") {
    rule = ruleset.rules.find((r) => r.id === id) ?? null;
  }

  return json({
    rule,
    ruleset,
    discountNodeId: record?.discountNodeId ?? null,
    isNew: id === "new",
  });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const formData = await request.formData();
  const { id } = params;

  const intent = formData.get("intent") as string;

  if (intent === "delete") {
    const record = await loadRuleset(admin);
    if (!record?.ruleset) return redirect("/app");
    const newRules = record.ruleset.rules.filter((r) => r.id !== id);
    const newRuleset: Ruleset = { version: 1, rules: newRules };
    await saveRuleset(admin, newRuleset, record.discountNodeId);
    return redirect("/app");
  }

  if (intent === "reorder") {
    const reorderedJson = formData.get("reordered") as string;
    const record = await loadRuleset(admin);
    if (!record?.ruleset) return json({ ok: false, error: "No ruleset" });
    try {
      const orderedIds: string[] = JSON.parse(reorderedJson);
      const ruleMap = new Map(record.ruleset.rules.map((r) => [r.id, r]));
      const newRules = orderedIds
        .map((rid) => ruleMap.get(rid))
        .filter(Boolean) as Rule[];
      const newRuleset: Ruleset = { version: 1, rules: newRules };
      await saveRuleset(admin, newRuleset, record.discountNodeId);
      return json({ ok: true, error: null });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  // "save" intent — parse the submitted rule and upsert into the ruleset
  const ruleJson = formData.get("rule") as string;
  const existingDiscountNodeId = formData.get("discountNodeId") as string | null;
  const existingRulesetJson = formData.get("ruleset") as string;

  let incomingRule: Rule;
  let existingRuleset: Ruleset;
  try {
    incomingRule = JSON.parse(ruleJson);
    existingRuleset = JSON.parse(existingRulesetJson);
  } catch {
    return json({ ok: false, error: "Invalid rule JSON" });
  }

  const existingIndex = existingRuleset.rules.findIndex(
    (r) => r.id === incomingRule.id
  );
  let newRules: Rule[];
  if (existingIndex >= 0) {
    newRules = [...existingRuleset.rules];
    newRules[existingIndex] = incomingRule;
  } else {
    newRules = [...existingRuleset.rules, incomingRule];
  }

  const newRuleset: Ruleset = { version: 1, rules: newRules };

  try {
    await saveRuleset(
      admin,
      newRuleset,
      existingDiscountNodeId || null
    );
  } catch (e) {
    return json({ ok: false, error: String(e) });
  }

  return redirect("/app");
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type ActionType = Action["type"];
type ConditionType = Condition["type"];

function newRule(): Rule {
  return {
    id: `r_${Date.now()}`,
    name: "New rule",
    enabled: true,
    stopIfApplied: false,
    conditions: [],
    action: { type: "percentageOff", scope: "order", value: 10 },
  };
}

function defaultCondition(type: ConditionType): Condition {
  switch (type) {
    case "cartSubtotal":
      return { type: "cartSubtotal", operator: "gte", value: 100 };
    case "customerTag":
      return { type: "customerTag", operator: "hasAny", value: ["vip"] };
    case "productInCollection":
      return {
        type: "productInCollection",
        operator: "anyOf",
        value: [],
      };
    case "quantity":
      return { type: "quantity", operator: "gte", value: 3 };
  }
}

function defaultAction(type: ActionType): Action {
  switch (type) {
    case "percentageOff":
      return { type: "percentageOff", scope: "order", value: 10 };
    case "fixedOff":
      return { type: "fixedOff", scope: "order", value: 5 };
    case "tiered":
      return {
        type: "tiered",
        scope: "order",
        tiers: [
          { minSubtotal: 50, percentageOff: 5 },
          { minSubtotal: 100, percentageOff: 10 },
          { minSubtotal: 200, percentageOff: 15 },
        ],
      };
    case "bogo":
      return {
        type: "bogo",
        buy: 2,
        get: 1,
        getDiscountPercent: 100,
      };
  }
}

// ---------------------------------------------------------------------------
// CollectionDisplay — cached title/image for a collection GID
// ---------------------------------------------------------------------------

interface CollectionMeta {
  title: string;
  imageUrl?: string;
}

// ---------------------------------------------------------------------------
// CollectionPicker — single-select reusable component
//
// value:    the stored GID string (or null when unset)
// onChange: receives the new GID string (or null to clear)
// meta:     cached title/image for the current GID (if available)
// onMeta:   callback to update the title/image cache in the parent
// emptyLabel: text shown when nothing is selected (defaults to "All products")
// ---------------------------------------------------------------------------

interface CollectionPickerProps {
  value: string | null;
  onChange: (gid: string | null) => void;
  meta: CollectionMeta | null;
  onMeta: (gid: string, meta: CollectionMeta) => void;
  emptyLabel?: string;
}

function CollectionPicker({
  value,
  onChange,
  meta,
  onMeta,
  emptyLabel = "All products",
}: CollectionPickerProps) {
  const shopifyBridge = useAppBridge();

  async function openPicker() {
    const selectionIds = value ? [{ id: value }] : [];
    const selected = await shopifyBridge.resourcePicker({
      type: "collection",
      multiple: false,
      action: "select",
      selectionIds,
    });
    if (!selected || selected.length === 0) return;
    const col = selected[0];
    const gid = col.id;
    // Defensively handle both image field shapes App Bridge may return
    const imgSrc =
      (col as unknown as { image?: { originalSrc?: string; url?: string } })
        ?.image?.originalSrc ??
      (col as unknown as { image?: { url?: string } })?.image?.url ??
      undefined;
    onMeta(gid, { title: col.title, imageUrl: imgSrc });
    onChange(gid);
  }

  function handleRemove() {
    onChange(null);
  }

  if (!value) {
    return (
      <InlineStack gap="200" blockAlign="center">
        <Text as="span" tone="subdued">
          {emptyLabel}
        </Text>
        <Button variant="plain" onClick={openPicker}>
          Choose collection
        </Button>
      </InlineStack>
    );
  }

  const displayTitle = meta?.title ?? "Selected collection";

  return (
    <InlineStack gap="300" blockAlign="center">
      {meta?.imageUrl ? (
        <Thumbnail
          source={meta.imageUrl}
          alt={displayTitle}
          size="small"
        />
      ) : null}
      <BlockStack gap="0">
        <Text as="span" fontWeight="semibold">
          {displayTitle}
        </Text>
      </BlockStack>
      <Button variant="plain" onClick={openPicker}>
        Change
      </Button>
      <Button variant="plain" tone="critical" onClick={handleRemove}>
        Remove
      </Button>
    </InlineStack>
  );
}

// ---------------------------------------------------------------------------
// CollectionConditionPicker — single-select for conditions
//
// The condition stores a string[] (one GID). This wraps CollectionPicker,
// converting between string|null (picker) and string[] (condition.value).
// ---------------------------------------------------------------------------

interface CollectionConditionPickerProps {
  value: string[];
  onChange: (gids: string[]) => void;
  meta: CollectionMeta | null;
  onMeta: (gid: string, meta: CollectionMeta) => void;
}

function CollectionConditionPicker({
  value,
  onChange,
  meta,
  onMeta,
}: CollectionConditionPickerProps) {
  const currentGid = value.length > 0 ? value[0] : null;

  return (
    <CollectionPicker
      value={currentGid}
      onChange={(gid) => onChange(gid ? [gid] : [])}
      meta={meta}
      onMeta={onMeta}
      emptyLabel="No collection selected"
    />
  );
}

export default function RuleBuilderPage() {
  const { rule: loadedRule, ruleset, discountNodeId, isNew } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSaving = navigation.state !== "idle";

  // Initialize rule state
  const [rule, setRule] = useState<Rule>(() => loadedRule ?? newRule());

  // Drag-to-reorder state for the full priority list
  const [orderedRules, setOrderedRules] = useState<Rule[]>(ruleset.rules);
  const dragItem = useRef<number | null>(null);
  const dragOver = useRef<number | null>(null);

  // Collection metadata cache: gid -> { title, imageUrl }
  // Used to show names instead of raw GIDs. Keyed by GID so it survives
  // condition/action index changes.
  const [collectionMetaCache, setCollectionMetaCache] = useState<
    Map<string, CollectionMeta>
  >(new Map());

  function updateCollectionMeta(gid: string, meta: CollectionMeta) {
    setCollectionMetaCache((prev) => new Map(prev).set(gid, meta));
  }

  useEffect(() => {
    setOrderedRules(ruleset.rules);
  }, [ruleset.rules]);

  // ---- Condition helpers ----
  const addCondition = useCallback((type: ConditionType) => {
    setRule((r) => ({
      ...r,
      conditions: [...r.conditions, defaultCondition(type)],
    }));
  }, []);

  const removeCondition = useCallback((idx: number) => {
    setRule((r) => ({
      ...r,
      conditions: r.conditions.filter((_, i) => i !== idx),
    }));
  }, []);

  const updateCondition = useCallback(
    (idx: number, updated: Condition) => {
      setRule((r) => {
        const next = [...r.conditions];
        next[idx] = updated;
        return { ...r, conditions: next };
      });
    },
    []
  );

  // ---- Action helpers ----
  const changeActionType = useCallback((type: ActionType) => {
    setRule((r) => ({ ...r, action: defaultAction(type) }));
  }, []);

  // ---- Drag-to-reorder ----
  function handleDragStart(idx: number) {
    dragItem.current = idx;
  }
  function handleDragEnter(idx: number) {
    dragOver.current = idx;
  }
  function handleDragEnd() {
    const from = dragItem.current;
    const to = dragOver.current;
    if (from === null || to === null || from === to) return;
    const next = [...orderedRules];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrderedRules(next);
    dragItem.current = null;
    dragOver.current = null;
    // Persist the new order
    submit(
      {
        intent: "reorder",
        reordered: JSON.stringify(next.map((r) => r.id)),
      },
      { method: "post" }
    );
  }

  // ---- Save ----
  function handleSave() {
    submit(
      {
        intent: "save",
        rule: JSON.stringify(rule),
        ruleset: JSON.stringify(ruleset),
        discountNodeId: discountNodeId ?? "",
      },
      { method: "post" }
    );
  }

  function handleDelete() {
    if (!confirm("Delete this rule?")) return;
    submit({ intent: "delete" }, { method: "post" });
  }

  const conditionTypeOptions = [
    { label: "Cart subtotal", value: "cartSubtotal" },
    { label: "Customer tag", value: "customerTag" },
    { label: "Product in collection", value: "productInCollection" },
    { label: "Total quantity", value: "quantity" },
  ];

  const actionTypeOptions = [
    { label: "Percentage off", value: "percentageOff" },
    { label: "Fixed amount off", value: "fixedOff" },
    { label: "Tiered discount", value: "tiered" },
    { label: "Buy X Get Y (BOGO)", value: "bogo" },
  ];

  return (
    <Page
      title={isNew ? "New rule" : `Edit rule: ${rule.name}`}
      backAction={{ content: "Rules", url: "/app" }}
      primaryAction={{
        content: "Save rule",
        loading: isSaving,
        onAction: handleSave,
      }}
      secondaryActions={
        !isNew
          ? [{ content: "Delete rule", destructive: true, onAction: handleDelete }]
          : []
      }
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical" title="Save failed">
              <p>{actionData.error}</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Rule metadata */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Rule details
              </Text>
              <TextField
                label="Rule name"
                value={rule.name}
                onChange={(v) => setRule((r) => ({ ...r, name: v }))}
                autoComplete="off"
              />
              <InlineStack gap="400">
                <Checkbox
                  label="Enabled"
                  checked={rule.enabled}
                  onChange={(v) => setRule((r) => ({ ...r, enabled: v }))}
                />
                <Checkbox
                  label="Stop if applied (exclusive)"
                  helpText="If this rule fires, no later rules will be evaluated."
                  checked={rule.stopIfApplied}
                  onChange={(v) =>
                    setRule((r) => ({ ...r, stopIfApplied: v }))
                  }
                />
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Conditions */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text variant="headingMd" as="h2">
                  Conditions
                </Text>
                <Text as="p" tone="subdued">
                  All conditions must pass (AND logic). Empty = always matches.
                </Text>
              </InlineStack>

              {rule.conditions.length === 0 && (
                <Banner tone="info">
                  <p>No conditions — this rule applies to every cart.</p>
                </Banner>
              )}

              {rule.conditions.map((cond, idx) => (
                <Box key={idx} padding="300" background="bg-surface-secondary" borderRadius="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between" blockAlign="start">
                      <Text as="span" fontWeight="semibold">
                        Condition {idx + 1}
                      </Text>
                      <Button
                        variant="plain"
                        tone="critical"
                        onClick={() => removeCondition(idx)}
                      >
                        Remove
                      </Button>
                    </InlineStack>
                    <ConditionEditor
                      condition={cond}
                      onChange={(updated) => updateCondition(idx, updated)}
                      collectionMetaCache={collectionMetaCache}
                      onCollectionMeta={updateCollectionMeta}
                    />
                  </BlockStack>
                </Box>
              ))}

              <Select
                label="Add condition"
                labelHidden
                placeholder="Add condition..."
                options={conditionTypeOptions}
                onChange={(v) => addCondition(v as ConditionType)}
                value=""
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Action */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Action
              </Text>
              <Select
                label="Discount type"
                options={actionTypeOptions}
                value={rule.action.type}
                onChange={(v) => changeActionType(v as ActionType)}
              />
              <ActionEditor
                action={rule.action}
                onChange={(a) => setRule((r) => ({ ...r, action: a }))}
                collectionMetaCache={collectionMetaCache}
                onCollectionMeta={updateCollectionMeta}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Priority / drag-to-reorder */}
        {ruleset.rules.length > 1 && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text variant="headingMd" as="h2">
                  Rule priority order
                </Text>
                <Text as="p" tone="subdued">
                  Drag rules to change the order in which they are evaluated.
                  Rule at position 1 runs first.
                </Text>
                {orderedRules.map((r, idx) => (
                  <Box
                    key={r.id}
                    padding="300"
                    background={
                      r.id === rule.id ? "bg-surface-selected" : "bg-surface"
                    }
                    borderRadius="200"
                    borderWidth="025"
                    borderColor="border"
                  >
                    <div
                      draggable
                      onDragStart={() => handleDragStart(idx)}
                      onDragEnter={() => handleDragEnter(idx)}
                      onDragEnd={handleDragEnd}
                      onDragOver={(e) => e.preventDefault()}
                      style={{ cursor: "grab" }}
                    >
                      <InlineStack gap="200" blockAlign="center">
                          <Text as="span" tone="subdued" aria-hidden="true">&#8923;</Text>
                        <Text as="span" tone="subdued">
                          {idx + 1}.
                        </Text>
                        <Text as="span">{r.name}</Text>
                        {r.id === rule.id && (
                          <Badge tone="info">Current</Badge>
                        )}
                        {!r.enabled && (
                          <Badge tone="new">Disabled</Badge>
                        )}
                        {r.stopIfApplied && (
                          <Badge tone="attention">Exclusive</Badge>
                        )}
                      </InlineStack>
                    </div>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Sub-components — condition editors
// ---------------------------------------------------------------------------

interface ConditionEditorProps {
  condition: Condition;
  onChange: (c: Condition) => void;
  collectionMetaCache: Map<string, CollectionMeta>;
  onCollectionMeta: (gid: string, meta: CollectionMeta) => void;
}

function ConditionEditor({
  condition,
  onChange,
  collectionMetaCache,
  onCollectionMeta,
}: ConditionEditorProps) {
  switch (condition.type) {
    case "cartSubtotal":
      return (
        <InlineStack gap="200">
          <Select
            label="Operator"
            options={[
              { label: ">=", value: "gte" },
              { label: "<=", value: "lte" },
              { label: ">", value: "gt" },
              { label: "<", value: "lt" },
              { label: "=", value: "eq" },
            ]}
            value={condition.operator}
            onChange={(v) =>
              onChange({ ...condition, operator: v as typeof condition.operator })
            }
          />
          <TextField
            label="Amount ($)"
            type="number"
            value={String(condition.value)}
            onChange={(v) => onChange({ ...condition, value: parseFloat(v) || 0 })}
            autoComplete="off"
          />
        </InlineStack>
      );

    case "customerTag":
      return (
        <InlineStack gap="200">
          <Select
            label="Match"
            options={[
              { label: "Has any tag", value: "hasAny" },
              { label: "Has all tags", value: "hasAll" },
            ]}
            value={condition.operator}
            onChange={(v) =>
              onChange({ ...condition, operator: v as typeof condition.operator })
            }
          />
          <TextField
            label="Tags (comma-separated)"
            value={condition.value.join(", ")}
            onChange={(v) =>
              onChange({
                ...condition,
                value: v.split(",").map((t) => t.trim()).filter(Boolean),
              })
            }
            autoComplete="off"
            placeholder="vip, loyalty"
          />
        </InlineStack>
      );

    case "productInCollection": {
      const currentGid = condition.value.length > 0 ? condition.value[0] : null;
      const meta = currentGid ? (collectionMetaCache.get(currentGid) ?? null) : null;
      return (
        <BlockStack gap="300">
          <Select
            label="Match"
            options={[
              { label: "In any of these collections", value: "anyOf" },
              { label: "In all of these collections", value: "allOf" },
            ]}
            value={condition.operator}
            onChange={(v) =>
              onChange({ ...condition, operator: v as typeof condition.operator })
            }
          />
          <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">
              Collection
            </Text>
            {currentGid ? (
              <CollectionPicker
                value={currentGid}
                onChange={(gid) =>
                  onChange({ ...condition, value: gid ? [gid] : [] })
                }
                meta={meta}
                onMeta={onCollectionMeta}
                emptyLabel="No collection selected"
              />
            ) : (
              <CollectionConditionPicker
                value={condition.value}
                onChange={(gids) => onChange({ ...condition, value: gids })}
                meta={null}
                onMeta={onCollectionMeta}
              />
            )}
          </BlockStack>
        </BlockStack>
      );
    }

    case "quantity":
      return (
        <InlineStack gap="200">
          <Select
            label="Operator"
            options={[
              { label: ">=", value: "gte" },
              { label: "<=", value: "lte" },
              { label: ">", value: "gt" },
              { label: "<", value: "lt" },
              { label: "=", value: "eq" },
            ]}
            value={condition.operator}
            onChange={(v) =>
              onChange({ ...condition, operator: v as typeof condition.operator })
            }
          />
          <TextField
            label="Total quantity"
            type="number"
            value={String(condition.value)}
            onChange={(v) => onChange({ ...condition, value: parseInt(v) || 0 })}
            autoComplete="off"
          />
        </InlineStack>
      );
  }
}

// ---------------------------------------------------------------------------
// Sub-components — action editor
// ---------------------------------------------------------------------------

interface ActionEditorProps {
  action: Action;
  onChange: (a: Action) => void;
  collectionMetaCache: Map<string, CollectionMeta>;
  onCollectionMeta: (gid: string, meta: CollectionMeta) => void;
}

function ActionEditor({
  action,
  onChange,
  collectionMetaCache,
  onCollectionMeta,
}: ActionEditorProps) {
  const scopeOptions = [
    { label: "Entire order", value: "order" },
    { label: "Matching products", value: "product" },
  ];

  switch (action.type) {
    case "percentageOff": {
      const a = action as PercentageOffAction;
      const colMeta = a.collectionId
        ? (collectionMetaCache.get(a.collectionId) ?? null)
        : null;
      return (
        <BlockStack gap="300">
          <InlineStack gap="300">
            <TextField
              label="Percentage off"
              type="number"
              min={0}
              max={100}
              value={String(a.value)}
              onChange={(v) => onChange({ ...a, value: parseFloat(v) || 0 })}
              suffix="%"
              autoComplete="off"
            />
            <Select
              label="Applies to"
              options={scopeOptions}
              value={a.scope}
              onChange={(v) => onChange({ ...a, scope: v as "order" | "product" })}
            />
          </InlineStack>
          {a.scope === "product" && (
            <BlockStack gap="100">
              <Text as="span" variant="bodySm" tone="subdued">
                Restrict to collection (leave unset to apply to all products)
              </Text>
              <CollectionPicker
                value={a.collectionId ?? null}
                onChange={(gid) => onChange({ ...a, collectionId: gid })}
                meta={colMeta}
                onMeta={onCollectionMeta}
                emptyLabel="All products"
              />
            </BlockStack>
          )}
        </BlockStack>
      );
    }

    case "fixedOff": {
      const a = action as FixedOffAction;
      const colMeta = a.collectionId
        ? (collectionMetaCache.get(a.collectionId) ?? null)
        : null;
      return (
        <BlockStack gap="300">
          <InlineStack gap="300">
            <TextField
              label="Amount off"
              type="number"
              min={0}
              value={String(a.value)}
              onChange={(v) => onChange({ ...a, value: parseFloat(v) || 0 })}
              prefix="$"
              autoComplete="off"
            />
            <Select
              label="Applies to"
              options={scopeOptions}
              value={a.scope}
              onChange={(v) => onChange({ ...a, scope: v as "order" | "product" })}
            />
          </InlineStack>
          {a.scope === "product" && (
            <BlockStack gap="100">
              <Text as="span" variant="bodySm" tone="subdued">
                Restrict to collection (leave unset to apply to all products)
              </Text>
              <CollectionPicker
                value={a.collectionId ?? null}
                onChange={(gid) => onChange({ ...a, collectionId: gid })}
                meta={colMeta}
                onMeta={onCollectionMeta}
                emptyLabel="All products"
              />
            </BlockStack>
          )}
        </BlockStack>
      );
    }

    case "tiered": {
      const a = action as TieredAction;
      return (
        <BlockStack gap="300">
          <Select
            label="Applies to"
            options={scopeOptions}
            value={a.scope}
            onChange={(v) => onChange({ ...a, scope: v as "order" | "product" })}
          />
          <Text as="p" tone="subdued">
            Tiers are evaluated in order; the last matching tier wins.
          </Text>
          {a.tiers.map((tier, tidx) => (
            <Box key={tidx} padding="200" background="bg-surface-secondary" borderRadius="200">
              <InlineStack gap="200">
                <TextField
                  label="Min subtotal ($)"
                  type="number"
                  value={String(tier.minSubtotal ?? "")}
                  onChange={(v) => {
                    const next = [...a.tiers];
                    next[tidx] = {
                      ...tier,
                      minSubtotal: parseFloat(v) || undefined,
                    };
                    onChange({ ...a, tiers: next });
                  }}
                  autoComplete="off"
                />
                <TextField
                  label="Min quantity"
                  type="number"
                  value={String(tier.minQuantity ?? "")}
                  onChange={(v) => {
                    const next = [...a.tiers];
                    next[tidx] = {
                      ...tier,
                      minQuantity: parseInt(v) || undefined,
                    };
                    onChange({ ...a, tiers: next });
                  }}
                  autoComplete="off"
                />
                <TextField
                  label="% off"
                  type="number"
                  min={0}
                  max={100}
                  value={String(tier.percentageOff)}
                  onChange={(v) => {
                    const next = [...a.tiers];
                    next[tidx] = {
                      ...tier,
                      percentageOff: parseFloat(v) || 0,
                    };
                    onChange({ ...a, tiers: next });
                  }}
                  suffix="%"
                  autoComplete="off"
                />
                <Box paddingBlockStart="600">
                  <Button
                    variant="plain"
                    tone="critical"
                    onClick={() => {
                      const next = a.tiers.filter((_, i) => i !== tidx);
                      onChange({ ...a, tiers: next });
                    }}
                  >
                    Remove
                  </Button>
                </Box>
              </InlineStack>
            </Box>
          ))}
          <Button
            onClick={() =>
              onChange({
                ...a,
                tiers: [...a.tiers, { percentageOff: 5 }],
              })
            }
          >
            Add tier
          </Button>
        </BlockStack>
      );
    }

    case "bogo": {
      const a = action as BogoAction;
      const colMeta = a.collectionId
        ? (collectionMetaCache.get(a.collectionId) ?? null)
        : null;
      return (
        <BlockStack gap="300">
          <InlineStack gap="300">
            <TextField
              label="Buy quantity"
              type="number"
              min={1}
              value={String(a.buy)}
              onChange={(v) => onChange({ ...a, buy: parseInt(v) || 1 })}
              autoComplete="off"
            />
            <TextField
              label="Get quantity"
              type="number"
              min={1}
              value={String(a.get)}
              onChange={(v) => onChange({ ...a, get: parseInt(v) || 1 })}
              autoComplete="off"
            />
            <TextField
              label="Discount on 'Get' items"
              type="number"
              min={0}
              max={100}
              value={String(a.getDiscountPercent)}
              onChange={(v) =>
                onChange({ ...a, getDiscountPercent: parseFloat(v) || 100 })
              }
              suffix="%"
              helpText="100 = free"
              autoComplete="off"
            />
          </InlineStack>
          <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">
              Restrict to collection (leave unset to apply to all products)
            </Text>
            <CollectionPicker
              value={a.collectionId ?? null}
              onChange={(gid) => onChange({ ...a, collectionId: gid })}
              meta={colMeta}
              onMeta={onCollectionMeta}
              emptyLabel="All products"
            />
          </BlockStack>
        </BlockStack>
      );
    }
  }
}
