/**
 * app.preview.tsx — Test-cart preview
 *
 * The merchant builds a test cart using the App Bridge product resource picker,
 * selects customer tags, and sees which rules fire (the trace) plus the final
 * computed price.
 *
 * IMPORTANT: This route imports the SAME evaluate() function used by the
 * Discount Function — no reimplementation.  Import path uses the Remix "~"
 * alias which resolves to app/lib (the canonical single source of truth per
 * SCHEMA.md §4).
 *
 * Collection membership for productInCollection conditions is resolved
 * server-side in the action via resolveCollectionMemberships() so the merchant
 * never needs to enter GIDs manually.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
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
  BlockStack,
  InlineStack,
  Text,
  Banner,
  Badge,
  Box,
  Divider,
  Checkbox,
  Thumbnail,
} from "@shopify/polaris";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useState } from "react";
import shopify from "../shopify.server";
import { loadRuleset, resolveCollectionMemberships } from "../server/discount.server";
// Shared engine — single source of truth, no copy, no reimplementation
import { evaluate } from "~/lib/rule-engine/engine.js";
import { buildEngineCart } from "~/lib/preview-adapter.js";
import type { EngineResult, Ruleset, TraceStatus } from "~/lib/rule-engine/types.js";
import type { PreviewLineInput } from "~/lib/preview-adapter.js";

// ---------------------------------------------------------------------------
// Loader — fetch saved ruleset
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const record = await loadRuleset(admin);
  return json({
    ruleset: record?.ruleset ?? null,
  });
};

// ---------------------------------------------------------------------------
// Action — resolve collection memberships server-side, then run evaluate()
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const formData = await request.formData();

  const customerTagsCsv = formData.get("customerTagsCsv") as string | null;
  const linesJson = formData.get("lines") as string;
  const rulesetJson = formData.get("ruleset") as string;

  let lines: PreviewLineInput[];
  let ruleset: Ruleset;

  try {
    lines = JSON.parse(linesJson);
    ruleset = JSON.parse(rulesetJson);
  } catch {
    return json({ error: "Invalid form data", result: null });
  }

  // Collect all collection IDs referenced in the ruleset
  const allRulesetCollectionIds: string[] = [];
  for (const rule of ruleset.rules) {
    for (const cond of rule.conditions) {
      if (cond.type === "productInCollection") {
        allRulesetCollectionIds.push(...cond.value);
      }
    }
    if ("collectionId" in rule.action && rule.action.collectionId) {
      allRulesetCollectionIds.push(rule.action.collectionId);
    }
  }
  const uniqueCollectionIds = [...new Set(allRulesetCollectionIds)];

  // Resolve collection memberships server-side for each line that has a productId
  const productIds = lines
    .map((l) => l.productId)
    .filter((id): id is string => id !== null);

  let membershipMap = new Map<
    string,
    Array<{ collectionId: string; isMember: boolean }>
  >();

  if (productIds.length > 0 && uniqueCollectionIds.length > 0) {
    try {
      membershipMap = await resolveCollectionMemberships(
        admin,
        productIds,
        uniqueCollectionIds
      );
    } catch {
      // Fall back to empty memberships — preview still runs, just won't match
      // productInCollection conditions.
    }
  }

  // Inject server-resolved memberships into lines (overrides any client-sent value)
  const resolvedLines: PreviewLineInput[] = lines.map((line) => ({
    ...line,
    collectionMemberships: line.productId
      ? (membershipMap.get(line.productId) ?? [])
      : [],
  }));

  // Compute derived cart subtotal from line subtotals (sum of lineSubtotal values)
  const cartSubtotal = resolvedLines
    .reduce((sum, l) => sum + (parseFloat(l.lineSubtotal) || 0), 0)
    .toFixed(2);

  const engineCart = buildEngineCart({
    cartSubtotal,
    lines: resolvedLines,
    customerTagsCsv: customerTagsCsv || null,
    allRulesetCollectionIds: uniqueCollectionIds,
  });

  // Call the SHARED evaluate() — same function as the Discount Function uses
  const result: EngineResult = evaluate(engineCart, ruleset);

  // Compute final price: start from cart subtotal, subtract all discounts
  const subtotal = parseFloat(cartSubtotal) || 0;
  let totalDiscount = 0;

  for (const op of result.operations) {
    if (op.type === "orderDiscountsAdd") {
      if ("percentage" in op.value) {
        totalDiscount += (subtotal * op.value.percentage) / 100;
      } else {
        totalDiscount += parseFloat(op.value.fixedAmount.amount) || 0;
      }
    } else if (op.type === "productDiscountsAdd") {
      for (const target of op.targets) {
        const line = resolvedLines.find((l) => l.id === target.cartLineId);
        if (!line) continue;
        const lineSubtotal = parseFloat(line.lineSubtotal) || 0;
        if ("percentage" in op.value) {
          const qty = target.quantity ?? line.quantity;
          const unitPrice = line.quantity > 0 ? lineSubtotal / line.quantity : 0;
          totalDiscount += (unitPrice * qty * op.value.percentage) / 100;
        } else {
          totalDiscount += parseFloat(op.value.fixedAmount.amount) || 0;
        }
      }
    }
  }

  const finalPrice = Math.max(0, subtotal - totalDiscount);

  return json({
    error: null,
    result: {
      ...result,
      subtotal,
      totalDiscount: parseFloat(totalDiscount.toFixed(2)),
      finalPrice: parseFloat(finalPrice.toFixed(2)),
    },
  });
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface PreviewResult extends EngineResult {
  subtotal: number;
  totalDiscount: number;
  finalPrice: number;
}

function newLine(): PreviewLineInput {
  return {
    id: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    productId: null,
    variantId: null,
    quantity: 1,
    lineSubtotal: "0.00",
    collectionMemberships: [],
    productTitle: undefined,
    variantTitle: undefined,
    unitPrice: undefined,
    imageUrl: undefined,
  };
}

export default function PreviewPage() {
  const { ruleset } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const shopifyBridge = useAppBridge();
  const isRunning = navigation.state !== "idle";

  const [customerTagsCsv, setCustomerTagsCsv] = useState("");
  const [isGuest, setIsGuest] = useState(false);
  const [lines, setLines] = useState<PreviewLineInput[]>([newLine()]);

  const result = actionData?.result as PreviewResult | null | undefined;

  // Derived cart subtotal = sum of all line subtotals
  const cartSubtotal = lines
    .reduce((sum, l) => sum + (parseFloat(l.lineSubtotal) || 0), 0)
    .toFixed(2);

  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }

  function updateLineQty(idx: number, qty: number) {
    setLines((ls) => {
      const next = [...ls];
      const line = next[idx];
      const unitPrice = parseFloat(line.unitPrice ?? "0") || 0;
      const newQty = Math.max(1, qty);
      const newSubtotal = (unitPrice * newQty).toFixed(2);
      next[idx] = { ...line, quantity: newQty, lineSubtotal: newSubtotal };
      return next;
    });
  }

  async function openProductPicker() {
    const selected = await shopifyBridge.resourcePicker({
      type: "product",
      multiple: true,
      action: "add",
      selectionIds: [],
    });
    if (!selected || selected.length === 0) return;

    const newLines: PreviewLineInput[] = [];
    for (const product of selected) {
      // Use first variant as the default (the picker may have returned variants)
      const variant = product.variants?.[0];
      if (!variant) continue;

      const unitPrice = String(variant.price ?? "0");
      const qty = 1;
      const lineSubtotal = (parseFloat(unitPrice) * qty).toFixed(2);

      // Defensively handle both image field shapes App Bridge may return
      const imgSrc =
        (product as unknown as { images?: Array<{ originalSrc?: string; url?: string }> })
          ?.images?.[0]?.originalSrc ??
        (product as unknown as { images?: Array<{ url?: string }> })
          ?.images?.[0]?.url ??
        (variant as unknown as { image?: { originalSrc?: string; url?: string } })
          ?.image?.originalSrc ??
        undefined;

      newLines.push({
        id: `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        productId: product.id,
        variantId: variant.id ?? null,
        quantity: qty,
        lineSubtotal,
        collectionMemberships: [],
        productTitle: product.title,
        variantTitle: variant.title !== "Default Title" ? variant.title : undefined,
        unitPrice,
        imageUrl: imgSrc,
      });
    }

    if (newLines.length > 0) {
      setLines((ls) => [...ls, ...newLines]);
    }
  }

  function handleRun() {
    if (!ruleset) return;
    submit(
      {
        customerTagsCsv: isGuest ? "" : customerTagsCsv,
        lines: JSON.stringify(lines),
        ruleset: JSON.stringify(ruleset),
      },
      { method: "post" }
    );
  }

  if (!ruleset) {
    return (
      <Page title="Preview cart" backAction={{ content: "Rules", url: "/app" }}>
        <Layout>
          <Layout.Section>
            <Banner tone="warning" title="No ruleset configured">
              <p>
                Create and save at least one rule before using the preview.
              </p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Preview cart"
      subtitle="Simulate checkout to see which rules fire before going live"
      backAction={{ content: "Rules", url: "/app" }}
      primaryAction={{
        content: "Run preview",
        loading: isRunning,
        onAction: handleRun,
      }}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical" title="Error">
              <p>{actionData.error}</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Cart inputs */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                Test cart
              </Text>

              <Divider />
              <Text variant="headingSm" as="h3">
                Line items
              </Text>

              {lines.length === 0 && (
                <Banner tone="info">
                  <p>No items added yet. Use "Add products" to build your test cart.</p>
                </Banner>
              )}

              {lines.map((line, idx) => {
                const displayTitle = line.productTitle ?? "Product";
                const displayVariant = line.variantTitle;
                return (
                  <Box
                    key={line.id}
                    padding="300"
                    background="bg-surface-secondary"
                    borderRadius="200"
                  >
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <InlineStack gap="300" blockAlign="center">
                          {line.imageUrl ? (
                            <Thumbnail
                              source={line.imageUrl}
                              alt={displayTitle}
                              size="small"
                            />
                          ) : null}
                          <BlockStack gap="0">
                            <Text as="span" fontWeight="semibold">
                              {displayTitle}
                            </Text>
                            {displayVariant && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {displayVariant}
                              </Text>
                            )}
                            <Text as="span" tone="subdued" variant="bodySm">
                              ${parseFloat(line.unitPrice ?? "0").toFixed(2)} each
                            </Text>
                          </BlockStack>
                        </InlineStack>
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeLine(idx)}
                        >
                          Remove
                        </Button>
                      </InlineStack>
                      <InlineStack gap="300" blockAlign="center">
                        <TextField
                          label="Quantity"
                          type="number"
                          min={1}
                          value={String(line.quantity)}
                          onChange={(v) =>
                            updateLineQty(idx, parseInt(v) || 1)
                          }
                          autoComplete="off"
                        />
                        <BlockStack gap="0">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Line subtotal
                          </Text>
                          <Text as="span" fontWeight="semibold">
                            ${parseFloat(line.lineSubtotal).toFixed(2)}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    </BlockStack>
                  </Box>
                );
              })}

              <Button onClick={openProductPicker}>Add products</Button>

              <Divider />

              {/* Computed cart subtotal */}
              <InlineStack align="space-between">
                <Text as="span" fontWeight="semibold">
                  Cart subtotal
                </Text>
                <Text as="span" fontWeight="semibold">
                  ${parseFloat(cartSubtotal).toFixed(2)}
                </Text>
              </InlineStack>

              <Divider />

              <BlockStack gap="200">
                <InlineStack gap="300" blockAlign="center">
                  <Checkbox
                    label="Guest checkout (no customer)"
                    checked={isGuest}
                    onChange={setIsGuest}
                  />
                </InlineStack>
                {!isGuest && (
                  <TextField
                    label="Customer tags (comma-separated)"
                    value={customerTagsCsv}
                    onChange={setCustomerTagsCsv}
                    placeholder="vip, loyalty"
                    autoComplete="off"
                  />
                )}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Results */}
        {result && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">
                  Preview results
                </Text>

                {/* Price summary */}
                <Box
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span">Cart subtotal</Text>
                      <Text as="span">${result.subtotal.toFixed(2)}</Text>
                    </InlineStack>
                    <InlineStack align="space-between">
                      <Text as="span" tone="success">
                        Total discount
                      </Text>
                      <Text as="span" tone="success">
                        -${result.totalDiscount.toFixed(2)}
                      </Text>
                    </InlineStack>
                    <Divider />
                    <InlineStack align="space-between">
                      <Text as="span" fontWeight="semibold">
                        Final price
                      </Text>
                      <Text as="span" fontWeight="semibold">
                        ${result.finalPrice.toFixed(2)}
                      </Text>
                    </InlineStack>
                  </BlockStack>
                </Box>

                {/* Trace */}
                <Text variant="headingSm" as="h3">
                  Rule trace
                </Text>
                {result.trace.map((entry) => (
                  <Box
                    key={entry.ruleId}
                    padding="300"
                    borderRadius="200"
                    borderWidth="025"
                    borderColor="border"
                  >
                    <InlineStack gap="200" blockAlign="start">
                      <TraceBadge status={entry.status} />
                      <BlockStack gap="100">
                        <Text as="span" fontWeight="semibold">
                          {entry.ruleName}
                        </Text>
                        <Text as="p" tone="subdued">
                          {entry.reason}
                        </Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                ))}

                {result.operations.length > 0 && (
                  <>
                    <Text variant="headingSm" as="h3">
                      Discount operations ({result.operations.length})
                    </Text>
                    {result.operations.map((op, idx) => (
                      <Box
                        key={idx}
                        padding="200"
                        background="bg-surface-success"
                        borderRadius="200"
                      >
                        <Text as="p">
                          <strong>{op.type}</strong> — {op.message}
                        </Text>
                      </Box>
                    ))}
                  </>
                )}
              </BlockStack>
            </Card>
          </Layout.Section>
        )}
      </Layout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function TraceBadge({ status }: { status: TraceStatus }) {
  switch (status) {
    case "fired":
      return <Badge tone="success">Fired</Badge>;
    case "skipped_condition":
      return <Badge tone="attention">Condition not met</Badge>;
    case "skipped_stop":
      return <Badge tone="new">Skipped (exclusive rule halted)</Badge>;
    case "disabled":
      return <Badge tone="new">Disabled</Badge>;
  }
}
