/**
 * app._index.tsx — Rule list dashboard
 *
 * Shows all rules in priority order, active/inactive badges, links to the
 * rule builder, and an activate/deactivate toggle for the whole discount.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSubmit,
} from "@remix-run/react";
import { Page, Layout, Card, Button, Badge, Text, BlockStack, InlineStack, Banner, Box, EmptyState, IndexTable, useIndexResourceState } from "@shopify/polaris";
import shopify from "../shopify.server";
import { loadRuleset, setDiscountActive } from "../server/discount.server";
import type { Ruleset } from "~/lib/rule-engine/types.js";

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const record = await loadRuleset(admin);
  return json({
    discountNodeId: record?.discountNodeId ?? null,
    status: record?.status ?? null,
    ruleset: record?.ruleset ?? null,
  });
};

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await shopify.authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  if (intent === "toggle") {
    const discountNodeId = formData.get("discountNodeId") as string;
    const newActive = formData.get("active") === "true";
    try {
      await setDiscountActive(admin, discountNodeId, newActive);
      return json({ ok: true, error: null });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  return json({ ok: false, error: "Unknown intent" });
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function IndexPage() {
  const { discountNodeId, status, ruleset } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isLoading = navigation.state !== "idle";

  const rules = ruleset?.rules ?? [];
  const isActive = status === "ACTIVE";

  const resourceName = { singular: "rule", plural: "rules" };
  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(rules.map((r) => ({ id: r.id })));

  function handleToggle() {
    submit(
      {
        intent: "toggle",
        discountNodeId: discountNodeId ?? "",
        active: String(!isActive),
      },
      { method: "post" }
    );
  }

  return (
    <Page
      title="CheckoutRules"
      subtitle="Ordered discount rules for checkout — replaces Shopify Scripts"
      primaryAction={{
        content: "New rule",
        onAction: () => navigate("/app/rules/new"),
      }}
      secondaryActions={[
        {
          content: "Preview cart",
          onAction: () => navigate("/app/preview"),
        },
      ]}
    >
      <Layout>
        {actionData?.error && (
          <Layout.Section>
            <Banner tone="critical" title="Error">
              <p>{actionData.error}</p>
            </Banner>
          </Layout.Section>
        )}

        {/* Discount status card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <BlockStack gap="100">
                  <Text variant="headingMd" as="h2">
                    Discount status
                  </Text>
                  <Text as="p" tone="subdued">
                    One automatic app discount drives all rules below.
                  </Text>
                </BlockStack>
                <InlineStack gap="300" blockAlign="center">
                  {discountNodeId ? (
                    <Badge tone={isActive ? "success" : "attention"}>
                      {isActive ? "Active" : "Inactive"}
                    </Badge>
                  ) : (
                    <Badge tone="new">Not created</Badge>
                  )}
                  {discountNodeId && (
                    <Button
                      variant={isActive ? "secondary" : "primary"}
                      tone={isActive ? "critical" : undefined}
                      loading={isLoading}
                      onClick={handleToggle}
                    >
                      {isActive ? "Deactivate" : "Activate"}
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>

              {!discountNodeId && (
                <Banner tone="info">
                  <p>
                    No discount has been created yet. Add a rule and save to
                    create the discount automatically.
                  </p>
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Rules list */}
        <Layout.Section>
          <Card padding="0">
            {rules.length === 0 ? (
              <EmptyState
                heading="No rules yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "Create first rule",
                  onAction: () => navigate("/app/rules/new"),
                }}
              >
                <p>
                  Create rules to automatically apply discounts at checkout.
                  Rules are applied in the order shown below.
                </p>
              </EmptyState>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={rules.length}
                selectedItemsCount={
                  allResourcesSelected ? "All" : selectedResources.length
                }
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: "Priority" },
                  { title: "Name" },
                  { title: "Action" },
                  { title: "Status" },
                  { title: "" },
                ]}
              >
                {rules.map((rule, idx) => (
                  <IndexTable.Row
                    id={rule.id}
                    key={rule.id}
                    selected={selectedResources.includes(rule.id)}
                    position={idx}
                  >
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued">
                        {idx + 1}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="semibold">
                        {rule.name}
                      </Text>
                      {rule.stopIfApplied && (
                        <Box paddingInlineStart="100">
                          <Badge tone="attention">Exclusive</Badge>
                        </Box>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" tone="subdued">
                        {describeAction(rule.action)}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={rule.enabled ? "success" : "new"}>
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Button
                        variant="plain"
                        onClick={() => navigate(`/app/rules/${rule.id}`)}
                      >
                        Edit
                      </Button>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeAction(action: Ruleset["rules"][0]["action"]): string {
  switch (action.type) {
    case "percentageOff":
      return `${action.value}% off ${action.scope}`;
    case "fixedOff":
      return `$${action.value} off ${action.scope}`;
    case "tiered":
      return `Tiered % off ${action.scope}`;
    case "bogo":
      return `Buy ${action.buy} Get ${action.get} (${action.getDiscountPercent}% off)`;
    default:
      return "Unknown action";
  }
}
