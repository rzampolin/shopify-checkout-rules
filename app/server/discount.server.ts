/**
 * discount.server.ts
 *
 * Read/write the ONE automatic app discount that hosts the Checkout Rules
 * Discount Function.  All Admin GraphQL calls are here; routes stay thin.
 *
 * Responsibilities:
 *  - discoverFunctionId()  — find the deployed Function id via shopifyFunctions.
 *  - loadRuleset()         — fetch the saved ruleset from the discount metafield.
 *  - saveRuleset()         — create (first time) or update the app discount,
 *                            writing TWO metafields:
 *                              1. $app:ruleset       — the full ordered ruleset JSON
 *                              2. $app:function-input-vars — the input query variables
 *                                 { collectionIds, customerTags } consumed by the
 *                                 Function's [extensions.input.variables] toml config.
 *  - activateDiscount()    — enable/disable the discount (status toggle on index).
 */

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { Ruleset } from "~/lib/rule-engine/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FUNCTION_HANDLE = "checkout-rules-discount";
const DISCOUNT_TITLE = "CheckoutRules";
const METAFIELD_NAMESPACE = "$app";
const METAFIELD_KEY = "ruleset";

/** Namespace/key for the input-query-variables metafield.
 *  Must match [extensions.input.variables] in shopify.extension.toml exactly. */
const INPUT_VARS_METAFIELD_KEY = "function-input-vars";

// ---------------------------------------------------------------------------
// GraphQL documents (validated against 2026-04 schema via MCP)
// ---------------------------------------------------------------------------

const GET_SHOPIFY_FUNCTIONS = `#graphql
  query GetShopifyFunctions {
    shopifyFunctions(first: 25, apiType: "discount") {
      nodes {
        id
        title
        apiType
        appKey
      }
    }
  }
`;

const GET_APP_DISCOUNTS = `#graphql
  query GetAppDiscounts {
    discountNodes(first: 10, query: "discount_type:app") {
      nodes {
        id
        discount {
          ... on DiscountAutomaticApp {
            title
            status
            discountClasses
            appDiscountType {
              functionId
              appKey
            }
          }
        }
        metafield(namespace: "$app", key: "ruleset") {
          value
          jsonValue
        }
      }
    }
  }
`;

const GET_DISCOUNT_WITH_RULESET = `#graphql
  query GetDiscountWithRuleset($id: ID!) {
    automaticDiscountNode(id: $id) {
      id
      automaticDiscount {
        ... on DiscountAutomaticApp {
          title
          status
          discountClasses
          appDiscountType {
            functionId
          }
        }
      }
      metafield(namespace: "$app", key: "ruleset") {
        id
        value
        jsonValue
      }
    }
  }
`;

const CREATE_APP_DISCOUNT = `#graphql
  mutation CreateAppDiscount($input: DiscountAutomaticAppInput!) {
    discountAutomaticAppCreate(automaticAppDiscount: $input) {
      automaticAppDiscount {
        discountId
        title
        status
        appDiscountType {
          functionId
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_APP_DISCOUNT = `#graphql
  mutation UpdateAppDiscount($id: ID!, $input: DiscountAutomaticAppInput!) {
    discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $input) {
      automaticAppDiscount {
        discountId
        title
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DiscountRecord {
  /** GID of the DiscountAutomaticNode, e.g. "gid://shopify/DiscountAutomaticNode/123" */
  discountNodeId: string;
  /** Underlying discount GID returned by discountAutomaticAppCreate */
  discountId: string;
  title: string;
  status: "ACTIVE" | "EXPIRED" | "SCHEDULED" | string;
  ruleset: Ruleset | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the union of all collection GIDs and customer tags from the ruleset.
 * Returns the JSON-serialisable object written to the $app:function-input-vars
 * metafield, whose top-level keys are injected as input query variables by
 * Shopify at runtime (no deploy required).
 *
 * Both keys are always present (empty arrays when nothing is referenced) so the
 * metafield is always valid and a missing key never produces a null variable
 * that could break execution.
 */
export function buildInputVariables(ruleset: Ruleset): {
  collectionIds: string[];
  customerTags: string[];
} {
  const collectionIdSet = new Set<string>();
  const customerTagSet = new Set<string>();

  for (const rule of ruleset.rules) {
    for (const cond of rule.conditions) {
      if (cond.type === "productInCollection") {
        for (const gid of cond.value) collectionIdSet.add(gid);
      }
      if (cond.type === "customerTag") {
        for (const tag of cond.value) customerTagSet.add(tag.toLowerCase());
      }
    }
    // Also check action collectionId for bogo/product-scope actions
    if ("collectionId" in rule.action && rule.action.collectionId) {
      collectionIdSet.add(rule.action.collectionId);
    }
  }

  return {
    collectionIds: Array.from(collectionIdSet),
    customerTags: Array.from(customerTagSet),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover the deployed Function id by searching for the function with handle
 * matching our extension's handle.
 */
export async function discoverFunctionId(
  admin: AdminApiContext
): Promise<string | null> {
  const response = await admin.graphql(GET_SHOPIFY_FUNCTIONS);
  const data = await response.json();
  const nodes: Array<{ id: string; title: string; apiType: string; appKey: string }> =
    data?.data?.shopifyFunctions?.nodes ?? [];

  // Match by title or apiType since the handle isn't directly exposed in the
  // shopifyFunctions query; the function handle is baked into the app key suffix.
  // We look for the discount-type function owned by this app.
  const fn = nodes.find(
    (n) =>
      n.apiType === "discount" &&
      (n.title === "Checkout Rules Discount" ||
        n.title.toLowerCase().includes("checkout-rules") ||
        n.title.toLowerCase().includes("checkoutrules"))
  ) ?? nodes.find((n) => n.apiType === "discount");

  return fn?.id ?? null;
}

/**
 * Load all app discounts for this shop and return the one that belongs to our
 * Function, or null if not yet created.
 */
export async function loadRuleset(
  admin: AdminApiContext
): Promise<DiscountRecord | null> {
  const response = await admin.graphql(GET_APP_DISCOUNTS);
  const data = await response.json();
  const nodes: Array<{
    id: string;
    discount?: {
      title?: string;
      status?: string;
      discountClasses?: string[];
      appDiscountType?: { functionId?: string; appKey?: string };
    };
    metafield?: { value?: string; jsonValue?: unknown } | null;
  }> = data?.data?.discountNodes?.nodes ?? [];

  // Find our discount node by its title (unique per shop for this app).
  const node = nodes.find(
    (n) => n.discount?.title === DISCOUNT_TITLE
  );
  if (!node) return null;

  let ruleset: Ruleset | null = null;
  if (node.metafield?.jsonValue) {
    try {
      ruleset =
        typeof node.metafield.jsonValue === "string"
          ? JSON.parse(node.metafield.jsonValue)
          : (node.metafield.jsonValue as Ruleset);
    } catch {
      ruleset = null;
    }
  }

  return {
    discountNodeId: node.id,
    discountId: node.id, // node id is the canonical reference for updates
    title: node.discount?.title ?? DISCOUNT_TITLE,
    status: node.discount?.status ?? "ACTIVE",
    ruleset,
  };
}

/**
 * Load the full record for a specific discount node id.
 */
export async function loadDiscountById(
  admin: AdminApiContext,
  discountNodeId: string
): Promise<DiscountRecord | null> {
  const response = await admin.graphql(GET_DISCOUNT_WITH_RULESET, {
    variables: { id: discountNodeId },
  });
  const data = await response.json();
  const node = data?.data?.automaticDiscountNode;
  if (!node) return null;

  let ruleset: Ruleset | null = null;
  const mf = node.metafield;
  if (mf?.jsonValue) {
    try {
      ruleset =
        typeof mf.jsonValue === "string"
          ? JSON.parse(mf.jsonValue)
          : (mf.jsonValue as Ruleset);
    } catch {
      ruleset = null;
    }
  }

  const discount = node.automaticDiscount as {
    title?: string;
    status?: string;
    discountClasses?: string[];
    appDiscountType?: { functionId?: string };
  };

  return {
    discountNodeId: node.id,
    discountId: node.id,
    title: discount?.title ?? DISCOUNT_TITLE,
    status: discount?.status ?? "ACTIVE",
    ruleset,
  };
}

/**
 * Save the ruleset — creates the discount on first call, updates on subsequent
 * calls. Writes TWO metafields in a single mutation:
 *
 *   1. $app:ruleset             — the full ordered ruleset JSON (read by the
 *                                  Function via discount.metafield in the query).
 *   2. $app:function-input-vars — { collectionIds, customerTags } used as input
 *                                  query variables by Shopify at runtime (no
 *                                  deploy required to pick up changes).
 *
 * Returns the resulting DiscountRecord.
 */
export async function saveRuleset(
  admin: AdminApiContext,
  ruleset: Ruleset,
  existingDiscountNodeId?: string | null
): Promise<DiscountRecord> {
  const rulesetJson = JSON.stringify(ruleset);

  // Build the input-query-variables payload — the union of all collection GIDs
  // and customer tags referenced by this ruleset.  Shopify reads this metafield
  // at runtime (via [extensions.input.variables] in shopify.extension.toml) and
  // injects its top-level keys as GraphQL variables.  No deploy is needed.
  const { collectionIds, customerTags } = buildInputVariables(ruleset);
  const inputVarsJson = JSON.stringify({ collectionIds, customerTags });

  const metafieldInput = [
    {
      namespace: METAFIELD_NAMESPACE,
      key: METAFIELD_KEY,
      type: "json",
      value: rulesetJson,
    },
    {
      namespace: METAFIELD_NAMESPACE,
      key: INPUT_VARS_METAFIELD_KEY,
      type: "json",
      value: inputVarsJson,
    },
  ];

  if (existingDiscountNodeId) {
    // UPDATE path
    const response = await admin.graphql(UPDATE_APP_DISCOUNT, {
      variables: {
        id: existingDiscountNodeId,
        input: {
          title: DISCOUNT_TITLE,
          metafields: metafieldInput,
        },
      },
    });
    const data = await response.json();
    const errors: Array<{ field: string[]; message: string }> =
      data?.data?.discountAutomaticAppUpdate?.userErrors ?? [];
    if (errors.length) {
      throw new Error(
        `discountAutomaticAppUpdate errors: ${errors.map((e) => e.message).join(", ")}`
      );
    }
    return {
      discountNodeId: existingDiscountNodeId,
      discountId: existingDiscountNodeId,
      title: DISCOUNT_TITLE,
      status: "ACTIVE",
      ruleset,
    };
  }

  // CREATE path — discover the Function id first
  const functionId = await discoverFunctionId(admin);
  if (!functionId) {
    throw new Error(
      "Could not find the deployed CheckoutRules Discount Function. " +
        "Deploy the app with `shopify app deploy` before saving rules."
    );
  }

  const response = await admin.graphql(CREATE_APP_DISCOUNT, {
    variables: {
      input: {
        title: DISCOUNT_TITLE,
        functionId,
        startsAt: new Date().toISOString(),
        discountClasses: ["PRODUCT", "ORDER"],
        metafields: metafieldInput,
      },
    },
  });
  const data = await response.json();
  const errors: Array<{ field: string[]; message: string }> =
    data?.data?.discountAutomaticAppCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `discountAutomaticAppCreate errors: ${errors.map((e) => e.message).join(", ")}`
    );
  }

  const created = data?.data?.discountAutomaticAppCreate?.automaticAppDiscount;
  if (!created?.discountId) {
    throw new Error("discountAutomaticAppCreate returned no discountId.");
  }

  return {
    discountNodeId: created.discountId,
    discountId: created.discountId,
    title: DISCOUNT_TITLE,
    status: "ACTIVE",
    ruleset,
  };
}

// ---------------------------------------------------------------------------
// Collection membership resolution (for preview route)
// ---------------------------------------------------------------------------

/**
 * GraphQL query to fetch which collections a single product belongs to.
 * We fetch the first 250 collections — sufficient for real-world rulesets
 * which are bounded at 100 collection IDs by the platform input-vars limit.
 */
const GET_PRODUCT_COLLECTIONS = `#graphql
  query GetProductCollections($id: ID!) {
    product(id: $id) {
      id
      collections(first: 250) {
        nodes {
          id
        }
      }
    }
  }
`;

/**
 * For the preview route: resolves which of the given collection GIDs each
 * product actually belongs to, using the Admin GraphQL API.
 *
 * Returns a Map keyed by productId; each entry is an array of
 * { collectionId, isMember } matching the PreviewLineInput.collectionMemberships
 * shape consumed by buildEngineCart.
 *
 * Falls back to an empty memberships array if any individual product query
 * fails, so the preview never crashes due to a transient API error.
 *
 * @param admin          - Authenticated Admin API context
 * @param productIds     - Unique product GIDs to resolve (duplicates ignored)
 * @param collectionIds  - The collection GIDs to check membership against
 */
export async function resolveCollectionMemberships(
  admin: AdminApiContext,
  productIds: string[],
  collectionIds: string[]
): Promise<Map<string, Array<{ collectionId: string; isMember: boolean }>>> {
  const result = new Map<
    string,
    Array<{ collectionId: string; isMember: boolean }>
  >();

  if (collectionIds.length === 0 || productIds.length === 0) {
    return result;
  }

  const collectionIdSet = new Set(collectionIds);
  const uniqueProductIds = [...new Set(productIds)];

  await Promise.all(
    uniqueProductIds.map(async (productId) => {
      try {
        const response = await admin.graphql(GET_PRODUCT_COLLECTIONS, {
          variables: { id: productId },
        });
        const data = await response.json();
        const nodes: Array<{ id: string }> =
          data?.data?.product?.collections?.nodes ?? [];
        const memberSet = new Set(nodes.map((n: { id: string }) => n.id));
        const memberships = collectionIds.map((collectionId) => ({
          collectionId,
          isMember: memberSet.has(collectionId) && collectionIdSet.has(collectionId),
        }));
        result.set(productId, memberships);
      } catch {
        // Graceful fallback: treat all memberships as false for this product
        result.set(
          productId,
          collectionIds.map((collectionId) => ({
            collectionId,
            isMember: false,
          }))
        );
      }
    })
  );

  return result;
}

/**
 * Toggle the discount active/inactive by updating its title with the same
 * mutation (status is controlled by startsAt/endsAt; the simplest MVP approach
 * is to update endsAt to a past date to deactivate, or null to activate).
 */
export async function setDiscountActive(
  admin: AdminApiContext,
  discountNodeId: string,
  active: boolean
): Promise<void> {
  const input: Record<string, unknown> = { title: DISCOUNT_TITLE };
  if (!active) {
    // Set endsAt to a past date to deactivate
    input.endsAt = new Date(Date.now() - 1000).toISOString();
  } else {
    // Clear endsAt to re-activate
    input.endsAt = null;
    input.startsAt = new Date().toISOString();
  }

  const response = await admin.graphql(UPDATE_APP_DISCOUNT, {
    variables: { id: discountNodeId, input },
  });
  const data = await response.json();
  const errors: Array<{ field: string[]; message: string }> =
    data?.data?.discountAutomaticAppUpdate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `setDiscountActive errors: ${errors.map((e) => e.message).join(", ")}`
    );
  }
}
