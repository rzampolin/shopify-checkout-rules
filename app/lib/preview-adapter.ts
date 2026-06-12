/**
 * preview-adapter.ts
 *
 * Maps the test-cart form inputs from app.preview.tsx into the EngineCart
 * shape expected by evaluate().  This is the app-side adapter — symmetric
 * to the Function adapter in cart_lines_discounts_generate_run.ts.
 *
 * No Shopify API imports; pure transformation only.
 */

import type {
  EngineCart,
  EngineCollectionMembership,
  EngineLineItem,
} from "~/lib/rule-engine/types.js";

// ---------------------------------------------------------------------------
// Form-side types (what the preview form captures)
// ---------------------------------------------------------------------------

export interface PreviewLineInput {
  /** Arbitrary stable id for this line (auto-generated) */
  id: string;
  /** Shopify Product GID — used for collection membership resolution */
  productId: string | null;
  /** Shopify Variant GID — the specific variant selected */
  variantId: string | null;
  quantity: number;
  /** Line subtotal as a decimal string — computed from unitPrice * quantity */
  lineSubtotal: string;
  /**
   * Collection memberships resolved server-side from the Admin API.
   * The preview form no longer asks the merchant to enter these manually.
   */
  collectionMemberships: Array<{
    collectionId: string;
    isMember: boolean;
  }>;
  // ---- Display-only fields (not read by buildEngineCart / engine) ----
  /** Human-readable product title shown in the preview UI */
  productTitle?: string;
  /** Human-readable variant title shown in the preview UI */
  variantTitle?: string;
  /** Unit price decimal string (from picker) — used to recompute lineSubtotal on qty change */
  unitPrice?: string;
  /** Thumbnail image URL for the product/variant */
  imageUrl?: string;
}

export interface PreviewCartInput {
  /** Cart subtotal as a decimal string, e.g. "120.00" */
  cartSubtotal: string;
  lines: PreviewLineInput[];
  /** Customer tags as a comma-separated string or null for guest */
  customerTagsCsv: string | null;
  /**
   * Full list of collection GIDs referenced in the current ruleset.
   * Used to fill in missing collection membership entries for each line
   * (collections not explicitly listed default to isMember=false).
   */
  allRulesetCollectionIds: string[];
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Convert the preview form's flat inputs into an EngineCart.
 *
 * The engine only sees the canonical EngineCart / EngineLineItem shape.
 * Display-only fields on PreviewLineInput (productTitle, variantTitle,
 * unitPrice, imageUrl) are ignored here — they never reach the engine.
 *
 * For any collection GIDs that appear in the ruleset but are NOT listed in a
 * line's collectionMemberships array, we default isMember to false (safe
 * fallback, matching the Function's behaviour when inCollections returns null).
 */
export function buildEngineCart(input: PreviewCartInput): EngineCart {
  const lines: EngineLineItem[] = input.lines.map((line) => {
    // Ensure every collection that appears anywhere in the ruleset has an
    // explicit membership entry for this line (false if not specified).
    const membershipMap = new Map<string, boolean>(
      line.collectionMemberships.map((m) => [m.collectionId, m.isMember])
    );
    for (const gid of input.allRulesetCollectionIds) {
      if (!membershipMap.has(gid)) {
        membershipMap.set(gid, false);
      }
    }
    const collectionMemberships: EngineCollectionMembership[] = Array.from(
      membershipMap.entries()
    ).map(([collectionId, isMember]) => ({ collectionId, isMember }));

    return {
      id: line.id,
      quantity: line.quantity,
      cost: {
        subtotalAmount: { amount: line.lineSubtotal },
      },
      variantId: line.variantId ?? null,
      productId: line.productId,
      collectionMemberships,
    };
  });

  // Build customer from the comma-separated tag string.
  let customer: EngineCart["customer"] = null;
  if (input.customerTagsCsv !== null) {
    const tags = input.customerTagsCsv
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

    // tagResults must contain all tags from the ruleset so the engine can
    // determine hasTag. Tags not present in the customer's list = false.
    const tagResults: Record<string, boolean> = {};
    for (const tag of tags) {
      tagResults[tag] = true;
    }
    customer = { tagResults };
  }

  return {
    cost: {
      subtotalAmount: { amount: input.cartSubtotal },
    },
    lines,
    customer,
  };
}
