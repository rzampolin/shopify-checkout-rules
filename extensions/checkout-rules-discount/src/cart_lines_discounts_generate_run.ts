// =============================================================================
// CheckoutRules — Discount Function Adapter
//
// This file is a THIN ADAPTER. All business logic lives in the shared engine
// at app/lib/rule-engine/engine.ts (imported via relative path — no copies).
//
// Responsibilities:
//   1. Parse the ruleset from discount.metafield.jsonValue.
//   2. Gate operations on discount.discountClasses (PRODUCT, ORDER only).
//   3. Map the Shopify input → EngineCart.
//   4. Call evaluate(cart, ruleset).
//   5. Map EngineResult.operations → CartLinesDiscountsGenerateRunResult.
// =============================================================================

// Generated types from the input query (produced by `shopify app function typegen`)
import type {
  CartLinesDiscountsGenerateRunResult,
  InputQuery,
} from "../generated/api.js";
import {
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
} from "../generated/api.js";

// Shared engine — single source of truth, no copy
import { evaluate } from "../../../app/lib/rule-engine/engine.js";
import type {
  DiscountOperation,
  EngineCart,
  EngineCollectionMembership,
  EngineLineItem,
  OrderDiscountOperation,
  ProductDiscountOperation,
  Ruleset,
} from "../../../app/lib/rule-engine/types.js";

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type Input = InputQuery;

// ---------------------------------------------------------------------------
// Adapter: Shopify input → EngineCart
// ---------------------------------------------------------------------------

function buildEngineCart(input: Input): EngineCart {
  const lines: EngineLineItem[] = input.cart.lines.map((line) => {
    let variantId: string | null = null;
    let productId: string | null = null;
    let collectionMemberships: EngineCollectionMembership[] = [];

    if (line.merchandise.__typename === "ProductVariant") {
      variantId = line.merchandise.id;
      productId = line.merchandise.product.id;
      collectionMemberships = (
        line.merchandise.product.inCollections ?? []
      ).map((m) => ({
        collectionId: m.collectionId,
        isMember: m.isMember,
      }));
    }

    return {
      id: line.id,
      quantity: line.quantity,
      cost: {
        subtotalAmount: { amount: line.cost.subtotalAmount.amount },
      },
      variantId,
      productId,
      collectionMemberships,
    };
  });

  const buyerIdentity = input.cart.buyerIdentity;
  const customer = buildCustomer(buyerIdentity);

  return {
    cost: {
      subtotalAmount: { amount: input.cart.cost.subtotalAmount.amount },
    },
    lines,
    customer,
  };
}

function buildCustomer(
  buyerIdentity: Input["cart"]["buyerIdentity"]
): EngineCart["customer"] {
  const rawCustomer = buyerIdentity?.customer;
  if (!rawCustomer) return null;

  const tagResults: Record<string, boolean> = {};
  for (const entry of rawCustomer.hasTags ?? []) {
    tagResults[entry.tag.toLowerCase()] = entry.hasTag;
  }
  return { tagResults };
}

// ---------------------------------------------------------------------------
// Adapter: EngineResult.operations → CartLinesDiscountsGenerateRunResult
// ---------------------------------------------------------------------------

function mapOperations(
  operations: DiscountOperation[],
  discountClasses: string[]
): CartLinesDiscountsGenerateRunResult["operations"] {
  const hasProduct = discountClasses.includes("PRODUCT");
  const hasOrder   = discountClasses.includes("ORDER");

  const result: CartLinesDiscountsGenerateRunResult["operations"] = [];

  for (const op of operations) {
    if (op.type === "productDiscountsAdd" && hasProduct) {
      const productOp = op as ProductDiscountOperation;
      result.push({
        productDiscountsAdd: {
          selectionStrategy: ProductDiscountSelectionStrategy.First,
          candidates: [
            {
              message: productOp.message,
              value: mapDiscountValue(productOp.value),
              targets: productOp.targets.map((t) => ({
                cartLine: {
                  id: t.cartLineId,
                  quantity: t.quantity ?? null,
                },
              })),
            },
          ],
        },
      });
    }

    if (op.type === "orderDiscountsAdd" && hasOrder) {
      const orderOp = op as OrderDiscountOperation;
      result.push({
        orderDiscountsAdd: {
          selectionStrategy: OrderDiscountSelectionStrategy.First,
          candidates: [
            {
              message: orderOp.message,
              value: mapDiscountValue(orderOp.value),
              targets: [
                {
                  orderSubtotal: {
                    excludedCartLineIds: orderOp.excludedCartLineIds,
                  },
                },
              ],
            },
          ],
        },
      });
    }
  }

  return result;
}

type MappedValue =
  | { percentage: { value: string } }
  | { fixedAmount: { amount: string; appliesToEachItem: boolean } };

function mapDiscountValue(
  value: DiscountOperation["value"]
): MappedValue {
  if ("percentage" in value) {
    // Shopify expects a Decimal string for percentage value
    return { percentage: { value: value.percentage.toString() } };
  }
  return {
    fixedAmount: {
      amount: value.fixedAmount.amount,
      appliesToEachItem: value.fixedAmount.appliesToEachItem,
    },
  };
}

// ---------------------------------------------------------------------------
// Function export — must be camelCase of the target name
// ---------------------------------------------------------------------------

export function cartLinesDiscountsGenerateRun(
  input: Input
): CartLinesDiscountsGenerateRunResult {
  // 1. Parse ruleset from metafield
  const jsonValue = input.discount?.metafield?.jsonValue;
  if (!jsonValue) {
    // No ruleset configured — no discount applied
    return { operations: [] };
  }

  let ruleset: Ruleset;
  try {
    ruleset = (
      typeof jsonValue === "string" ? JSON.parse(jsonValue) : jsonValue
    ) as Ruleset;
  } catch {
    // Malformed JSON — safe fallback
    return { operations: [] };
  }

  if (!ruleset?.rules?.length) {
    return { operations: [] };
  }

  // 2. Build engine cart from Shopify input
  const engineCart = buildEngineCart(input);

  // 3. Evaluate rules
  const { operations } = evaluate(engineCart, ruleset);

  // 4. Map to Shopify output, gated on discount classes
  const discountClasses: string[] = input.discount?.discountClasses ?? [];
  const mappedOps = mapOperations(operations, discountClasses);

  return { operations: mappedOps };
}
