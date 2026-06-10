/**
 * app.preview.tsx — Test-cart preview
 *
 * The merchant enters a test cart (line items, quantities, customer tags) and
 * sees which rules fire (the trace) plus the final computed price.
 *
 * IMPORTANT: This route imports the SAME evaluate() function used by the
 * Discount Function — no reimplementation.  Import path uses the Remix "~"
 * alias which resolves to app/lib (the canonical single source of truth per
 * SCHEMA.md §4).
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
  Select,
  Checkbox,
} from "@shopify/polaris";
import { useState } from "react";
import shopify from "../shopify.server";
import { loadRuleset } from "../server/discount.server";
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
// Action — run evaluate() server-side
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  // Authenticate (required even for server-side evaluation)
  await shopify.authenticate.admin(request);
  const formData = await request.formData();

  const cartSubtotal = formData.get("cartSubtotal") as string;
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

  // Collect all collection IDs from the ruleset for the adapter
  const allRulesetCollectionIds: string[] = [];
  for (const rule of ruleset.rules) {
    for (const cond of rule.conditions) {
      if (cond.type === "productInCollection") {
        allRulesetCollectionIds.push(...cond.value);
      }
    }
  }

  const engineCart = buildEngineCart({
    cartSubtotal,
    lines,
    customerTagsCsv: customerTagsCsv || null,
    allRulesetCollectionIds,
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
        const line = lines.find((l) => l.id === target.cartLineId);
        if (!line) continue;
        const lineSubtotal = parseFloat(line.lineSubtotal) || 0;
        if ("percentage" in op.value) {
          // Percentage applies to the target portion of the line
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
    quantity: 1,
    lineSubtotal: "0.00",
    collectionMemberships: [],
  };
}

export default function PreviewPage() {
  const { ruleset } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isRunning = navigation.state !== "idle";

  const [cartSubtotal, setCartSubtotal] = useState("100.00");
  const [customerTagsCsv, setCustomerTagsCsv] = useState("");
  const [isGuest, setIsGuest] = useState(false);
  const [lines, setLines] = useState<PreviewLineInput[]>([newLine()]);

  const result = actionData?.result as PreviewResult | null | undefined;

  function addLine() {
    setLines((ls) => [...ls, newLine()]);
  }
  function removeLine(idx: number) {
    setLines((ls) => ls.filter((_, i) => i !== idx));
  }
  function updateLine(idx: number, updates: Partial<PreviewLineInput>) {
    setLines((ls) => {
      const next = [...ls];
      next[idx] = { ...next[idx], ...updates };
      return next;
    });
  }
  function updateMembership(
    lineIdx: number,
    mIdx: number,
    field: "collectionId" | "isMember",
    value: string | boolean
  ) {
    setLines((ls) => {
      const next = [...ls];
      const memberships = [...next[lineIdx].collectionMemberships];
      memberships[mIdx] = { ...memberships[mIdx], [field]: value };
      next[lineIdx] = { ...next[lineIdx], collectionMemberships: memberships };
      return next;
    });
  }
  function addMembership(lineIdx: number) {
    setLines((ls) => {
      const next = [...ls];
      next[lineIdx] = {
        ...next[lineIdx],
        collectionMemberships: [
          ...next[lineIdx].collectionMemberships,
          { collectionId: "", isMember: false },
        ],
      };
      return next;
    });
  }

  function handleRun() {
    if (!ruleset) return;
    submit(
      {
        cartSubtotal,
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
              <TextField
                label="Cart subtotal ($)"
                type="number"
                value={cartSubtotal}
                onChange={setCartSubtotal}
                prefix="$"
                autoComplete="off"
              />
              <Divider />
              <Text variant="headingSm" as="h3">
                Line items
              </Text>
              {lines.map((line, idx) => (
                <Box
                  key={line.id}
                  padding="300"
                  background="bg-surface-secondary"
                  borderRadius="200"
                >
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text as="span" fontWeight="semibold">
                        Line {idx + 1}
                      </Text>
                      {lines.length > 1 && (
                        <Button
                          variant="plain"
                          tone="critical"
                          onClick={() => removeLine(idx)}
                        >
                          Remove
                        </Button>
                      )}
                    </InlineStack>
                    <InlineStack gap="200">
                      <TextField
                        label="Product GID (optional)"
                        value={line.productId ?? ""}
                        onChange={(v) =>
                          updateLine(idx, { productId: v || null })
                        }
                        placeholder="gid://shopify/Product/123"
                        autoComplete="off"
                      />
                      <TextField
                        label="Quantity"
                        type="number"
                        min={1}
                        value={String(line.quantity)}
                        onChange={(v) =>
                          updateLine(idx, { quantity: parseInt(v) || 1 })
                        }
                        autoComplete="off"
                      />
                      <TextField
                        label="Line subtotal ($)"
                        type="number"
                        value={line.lineSubtotal}
                        onChange={(v) =>
                          updateLine(idx, { lineSubtotal: v })
                        }
                        prefix="$"
                        autoComplete="off"
                      />
                    </InlineStack>

                    {/* Collection memberships */}
                    {line.collectionMemberships.length > 0 && (
                      <BlockStack gap="100">
                        <Text as="span" tone="subdued">
                          Collection memberships
                        </Text>
                        {line.collectionMemberships.map((m, mIdx) => (
                          <InlineStack key={mIdx} gap="200" blockAlign="center">
                            <TextField
                              label="Collection GID"
                              labelHidden
                              value={m.collectionId}
                              onChange={(v) =>
                                updateMembership(idx, mIdx, "collectionId", v)
                              }
                              placeholder="gid://shopify/Collection/123"
                              autoComplete="off"
                            />
                            <Checkbox
                              label="Is member"
                              checked={m.isMember}
                              onChange={(v) =>
                                updateMembership(idx, mIdx, "isMember", v)
                              }
                            />
                          </InlineStack>
                        ))}
                      </BlockStack>
                    )}
                    <Button
                      variant="plain"
                      onClick={() => addMembership(idx)}
                    >
                      + Add collection membership
                    </Button>
                  </BlockStack>
                </Box>
              ))}
              <Button onClick={addLine}>Add line item</Button>
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
