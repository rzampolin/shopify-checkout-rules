// =============================================================================
// Rule Engine Unit Tests
// Runner: node:test (built-in, zero-config). Run with:
//   node --experimental-strip-types --test app/lib/rule-engine/engine.test.ts
// or via npm script:
//   npm run test:engine
// =============================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "./engine.js";
import type {
  EngineCart,
  EngineCollectionMembership,
  EngineLineItem,
  OrderDiscountOperation,
  ProductDiscountOperation,
  Ruleset,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCart(
  subtotal: number,
  lines: EngineLineItem[] = [],
  customerTags: string[] = []
): EngineCart {
  return {
    cost: { subtotalAmount: { amount: subtotal.toFixed(2) } },
    lines,
    customer: customerTags.length > 0
      ? {
          tagResults: Object.fromEntries(
            customerTags.map((t) => [t.toLowerCase(), true])
          ),
        }
      : null,
  };
}

function makeLine(
  id: string,
  qty: number,
  unitPrice: number,
  collectionMemberships: EngineCollectionMembership[] = [],
  productId?: string
): EngineLineItem {
  return {
    id,
    quantity: qty,
    cost: { subtotalAmount: { amount: (qty * unitPrice).toFixed(2) } },
    variantId: `gid://shopify/ProductVariant/${id}`,
    productId: productId ?? `gid://shopify/Product/${id}`,
    collectionMemberships,
  };
}

const COL_SALE = "gid://shopify/Collection/100";
const COL_VIP  = "gid://shopify/Collection/200";

function inSale(member = true): EngineCollectionMembership {
  return { collectionId: COL_SALE, isMember: member };
}

// ---------------------------------------------------------------------------
// §8 Hand-trace stacking scenarios (SPEC.md)
// ---------------------------------------------------------------------------

const SPEC_RULESET: Ruleset = {
  version: 1,
  rules: [
    {
      id: "R1",
      name: "R1: subtotal ≥ 100 → 15% off order",
      enabled: true,
      stopIfApplied: false,
      conditions: [{ type: "cartSubtotal", operator: "gte", value: 100 }],
      action: { type: "percentageOff", scope: "order", value: 15 },
    },
    {
      id: "R2",
      name: "R2: collection Sale → 10% off products (stop)",
      enabled: true,
      stopIfApplied: true,
      conditions: [
        {
          type: "productInCollection",
          operator: "anyOf",
          value: [COL_SALE],
        },
      ],
      action: { type: "percentageOff", scope: "product", collectionId: COL_SALE, value: 10 },
    },
    {
      id: "R3",
      name: "R3: qty ≥ 3 → $5 off order",
      enabled: true,
      stopIfApplied: false,
      conditions: [{ type: "quantity", operator: "gte", value: 3 }],
      action: { type: "fixedOff", scope: "order", value: 5 },
    },
  ],
};

describe("SPEC §8 — stacking scenarios", () => {
  it("Scenario 1: $120, 2 items, none in Sale → R1 fires, R2+R3 skip", () => {
    const cart = makeCart(120, [
      makeLine("L1", 1, 60),
      makeLine("L2", 1, 60),
    ]);

    const { operations, trace } = evaluate(cart, SPEC_RULESET);

    // R1 fires
    assert.equal(trace[0].ruleId, "R1");
    assert.equal(trace[0].status, "fired");
    // R2 skips (no Sale items)
    assert.equal(trace[1].ruleId, "R2");
    assert.equal(trace[1].status, "skipped_condition");
    // R3 skips (qty < 3)
    assert.equal(trace[2].ruleId, "R3");
    assert.equal(trace[2].status, "skipped_condition");

    assert.equal(operations.length, 1);
    const op = operations[0] as OrderDiscountOperation;
    assert.equal(op.type, "orderDiscountsAdd");
    assert.deepEqual(op.value, { percentage: 15 });

    // Final price: $120 * 0.85 = $102.00
    const subtotal = 120;
    const pct = (op.value as { percentage: number }).percentage;
    assert.equal(subtotal * (1 - pct / 100), 102);
  });

  it("Scenario 2: $120, 4 items incl. Sale → R1 fires, R2 fires+stop, R3 never evaluated", () => {
    const cart = makeCart(120, [
      makeLine("L1", 2, 20),                  // non-sale
      makeLine("L2", 2, 40, [inSale(true)]),  // sale
    ]);

    const { operations, trace } = evaluate(cart, SPEC_RULESET);

    assert.equal(trace[0].ruleId, "R1");
    assert.equal(trace[0].status, "fired");
    assert.equal(trace[1].ruleId, "R2");
    assert.equal(trace[1].status, "fired");
    assert.ok(trace[1].reason.includes("halted"), `expected 'halted' in reason: "${trace[1].reason}"`);
    assert.equal(trace[2].ruleId, "R3");
    assert.equal(trace[2].status, "skipped_stop");

    // 2 operations: order 15% (R1) + product 10% (R2)
    assert.equal(operations.length, 2);

    const orderOp = operations.find(
      (o): o is OrderDiscountOperation => o.type === "orderDiscountsAdd"
    );
    assert.ok(orderOp);
    assert.deepEqual(orderOp.value, { percentage: 15 });

    const prodOp = operations.find(
      (o): o is ProductDiscountOperation => o.type === "productDiscountsAdd"
    );
    assert.ok(prodOp);
    assert.deepEqual(prodOp.value, { percentage: 10 });
    // Only the sale line (L2) is targeted
    assert.equal(prodOp.targets.length, 1);
    assert.equal(prodOp.targets[0].cartLineId, "L2");
  });

  it("Scenario 3: $80, 4 items, none in Sale → R1+R2 skip, R3 fires ($5 off)", () => {
    const cart = makeCart(80, [
      makeLine("L1", 2, 20),
      makeLine("L2", 2, 20),
    ]);

    const { operations, trace } = evaluate(cart, SPEC_RULESET);

    assert.equal(trace[0].ruleId, "R1");
    assert.equal(trace[0].status, "skipped_condition");
    assert.equal(trace[1].ruleId, "R2");
    assert.equal(trace[1].status, "skipped_condition");
    assert.equal(trace[2].ruleId, "R3");
    assert.equal(trace[2].status, "fired");

    assert.equal(operations.length, 1);
    const op = operations[0] as OrderDiscountOperation;
    assert.equal(op.type, "orderDiscountsAdd");
    assert.deepEqual(op.value, {
      fixedAmount: { amount: "5.00", appliesToEachItem: false },
    });

    // Final price: $80 - $5 = $75
    const subtotal = 80;
    const fixed = parseFloat((op.value as { fixedAmount: { amount: string } }).fixedAmount.amount);
    assert.equal(subtotal - fixed, 75);
  });
});

// ---------------------------------------------------------------------------
// Individual condition tests
// ---------------------------------------------------------------------------

describe("Condition: cartSubtotal", () => {
  const ruleset: Ruleset = {
    version: 1,
    rules: [
      {
        id: "r1",
        name: "gte 50",
        enabled: true,
        stopIfApplied: false,
        conditions: [{ type: "cartSubtotal", operator: "gte", value: 50 }],
        action: { type: "percentageOff", scope: "order", value: 10 },
      },
    ],
  };

  it("fires when subtotal meets threshold", () => {
    const { trace } = evaluate(makeCart(50), ruleset);
    assert.equal(trace[0].status, "fired");
  });

  it("skips when subtotal below threshold", () => {
    const { trace } = evaluate(makeCart(49.99), ruleset);
    assert.equal(trace[0].status, "skipped_condition");
  });

  it("operator lte fires when at or below", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "lte", enabled: true, stopIfApplied: false,
        conditions: [{ type: "cartSubtotal", operator: "lte", value: 100 }],
        action: { type: "percentageOff", scope: "order", value: 5 },
      }],
    };
    assert.equal(evaluate(makeCart(99), r).trace[0].status, "fired");
    assert.equal(evaluate(makeCart(101), r).trace[0].status, "skipped_condition");
  });
});

describe("Condition: customerTag", () => {
  const ruleHasAny: Ruleset = {
    version: 1,
    rules: [
      {
        id: "r1",
        name: "VIP or member",
        enabled: true,
        stopIfApplied: false,
        conditions: [{ type: "customerTag", operator: "hasAny", value: ["vip", "member"] }],
        action: { type: "percentageOff", scope: "order", value: 20 },
      },
    ],
  };

  it("fires when customer has any matching tag", () => {
    const { trace } = evaluate(makeCart(100, [], ["vip"]), ruleHasAny);
    assert.equal(trace[0].status, "fired");
  });

  it("fires when customer has second tag in list", () => {
    const { trace } = evaluate(makeCart(100, [], ["member"]), ruleHasAny);
    assert.equal(trace[0].status, "fired");
  });

  it("skips when customer has no matching tag", () => {
    const { trace } = evaluate(makeCart(100, [], ["gold"]), ruleHasAny);
    assert.equal(trace[0].status, "skipped_condition");
  });

  it("skips for guest (no customer)", () => {
    const cart = makeCart(100);
    cart.customer = null;
    const { trace } = evaluate(cart, ruleHasAny);
    assert.equal(trace[0].status, "skipped_condition");
  });

  it("hasAll: fires only when customer has ALL tags", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "all", enabled: true, stopIfApplied: false,
        conditions: [{ type: "customerTag", operator: "hasAll", value: ["vip", "loyalty"] }],
        action: { type: "percentageOff", scope: "order", value: 10 },
      }],
    };
    assert.equal(
      evaluate(makeCart(50, [], ["vip", "loyalty"]), r).trace[0].status,
      "fired"
    );
    assert.equal(
      evaluate(makeCart(50, [], ["vip"]), r).trace[0].status,
      "skipped_condition"
    );
  });
});

describe("Condition: productInCollection", () => {
  it("anyOf fires when at least one line is in collection", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "in sale", enabled: true, stopIfApplied: false,
        conditions: [{ type: "productInCollection", operator: "anyOf", value: [COL_SALE] }],
        action: { type: "percentageOff", scope: "product", value: 15 },
      }],
    };
    const cart = makeCart(100, [
      makeLine("L1", 1, 50, [inSale(false)]),
      makeLine("L2", 1, 50, [inSale(true)]),
    ]);
    assert.equal(evaluate(cart, r).trace[0].status, "fired");
  });

  it("anyOf skips when no lines are in collection", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "in sale", enabled: true, stopIfApplied: false,
        conditions: [{ type: "productInCollection", operator: "anyOf", value: [COL_SALE] }],
        action: { type: "percentageOff", scope: "product", value: 15 },
      }],
    };
    const cart = makeCart(100, [makeLine("L1", 1, 50, [inSale(false)])]);
    assert.equal(evaluate(cart, r).trace[0].status, "skipped_condition");
  });

  it("allOf fires only when line is in ALL listed collections", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "allOf", enabled: true, stopIfApplied: false,
        conditions: [{
          type: "productInCollection", operator: "allOf",
          value: [COL_SALE, COL_VIP],
        }],
        action: { type: "percentageOff", scope: "product", value: 10 },
      }],
    };
    const bothCollections: EngineCollectionMembership[] = [
      { collectionId: COL_SALE, isMember: true },
      { collectionId: COL_VIP, isMember: true },
    ];
    const oneCollection: EngineCollectionMembership[] = [
      { collectionId: COL_SALE, isMember: true },
      { collectionId: COL_VIP, isMember: false },
    ];
    assert.equal(
      evaluate(makeCart(100, [makeLine("L1", 1, 100, bothCollections)]), r).trace[0].status,
      "fired"
    );
    assert.equal(
      evaluate(makeCart(100, [makeLine("L1", 1, 100, oneCollection)]), r).trace[0].status,
      "skipped_condition"
    );
  });
});

describe("Condition: quantity", () => {
  const r: Ruleset = {
    version: 1,
    rules: [{
      id: "r1", name: "qty≥3", enabled: true, stopIfApplied: false,
      conditions: [{ type: "quantity", operator: "gte", value: 3 }],
      action: { type: "fixedOff", scope: "order", value: 5 },
    }],
  };

  it("fires when total quantity meets threshold", () => {
    const cart = makeCart(50, [makeLine("L1", 2, 10), makeLine("L2", 1, 10)]);
    assert.equal(evaluate(cart, r).trace[0].status, "fired");
  });

  it("skips when total quantity below threshold", () => {
    const cart = makeCart(50, [makeLine("L1", 2, 10)]);
    assert.equal(evaluate(cart, r).trace[0].status, "skipped_condition");
  });
});

// ---------------------------------------------------------------------------
// Action tests
// ---------------------------------------------------------------------------

describe("Action: percentageOff", () => {
  it("order scope emits orderDiscountsAdd", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "15% order", enabled: true, stopIfApplied: false,
        conditions: [],
        action: { type: "percentageOff", scope: "order", value: 15 },
      }],
    };
    const { operations } = evaluate(makeCart(100), r);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].type, "orderDiscountsAdd");
    assert.deepEqual(operations[0].value, { percentage: 15 });
  });

  it("product scope emits productDiscountsAdd with all lines as targets", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "10% product", enabled: true, stopIfApplied: false,
        conditions: [],
        action: { type: "percentageOff", scope: "product", value: 10 },
      }],
    };
    const cart = makeCart(100, [makeLine("L1", 1, 50), makeLine("L2", 1, 50)]);
    const { operations } = evaluate(cart, r);
    assert.equal(operations.length, 1);
    const op = operations[0] as ProductDiscountOperation;
    assert.equal(op.type, "productDiscountsAdd");
    assert.equal(op.targets.length, 2);
    assert.deepEqual(op.value, { percentage: 10 });
  });

  it("product scope with collectionId targets only matching lines", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "sale 10%", enabled: true, stopIfApplied: false,
        conditions: [],
        action: { type: "percentageOff", scope: "product", collectionId: COL_SALE, value: 10 },
      }],
    };
    const cart = makeCart(100, [
      makeLine("L1", 1, 50, [inSale(true)]),
      makeLine("L2", 1, 50, [inSale(false)]),
    ]);
    const { operations } = evaluate(cart, r);
    const op = operations[0] as ProductDiscountOperation;
    assert.equal(op.targets.length, 1);
    assert.equal(op.targets[0].cartLineId, "L1");
  });
});

describe("Action: fixedOff", () => {
  it("order scope emits fixedAmount orderDiscountsAdd", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "$10 off", enabled: true, stopIfApplied: false,
        conditions: [],
        action: { type: "fixedOff", scope: "order", value: 10 },
      }],
    };
    const { operations } = evaluate(makeCart(100), r);
    assert.equal(operations.length, 1);
    const op = operations[0] as OrderDiscountOperation;
    assert.deepEqual(op.value, {
      fixedAmount: { amount: "10.00", appliesToEachItem: false },
    });
  });
});

describe("Action: tiered", () => {
  const tieredRuleset: Ruleset = {
    version: 1,
    rules: [{
      id: "r1", name: "tiered", enabled: true, stopIfApplied: false,
      conditions: [],
      action: {
        type: "tiered",
        scope: "order",
        tiers: [
          { minSubtotal: 50,  percentageOff: 5 },
          { minSubtotal: 100, percentageOff: 10 },
          { minSubtotal: 200, percentageOff: 15 },
        ],
      },
    }],
  };

  it("picks the last matching tier (highest discount)", () => {
    const { operations } = evaluate(makeCart(150), tieredRuleset);
    assert.equal(operations.length, 1);
    assert.deepEqual(operations[0].value, { percentage: 10 });
  });

  it("picks tier 3 when subtotal ≥ 200", () => {
    const { operations } = evaluate(makeCart(250), tieredRuleset);
    assert.deepEqual(operations[0].value, { percentage: 15 });
  });

  it("no operations when subtotal below first tier", () => {
    const { operations, trace } = evaluate(makeCart(30), tieredRuleset);
    assert.equal(operations.length, 0);
    assert.equal(trace[0].status, "skipped_condition");
  });

  it("minQuantity tier fires at correct threshold", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "qty tiered", enabled: true, stopIfApplied: false,
        conditions: [],
        action: {
          type: "tiered", scope: "order",
          tiers: [
            { minQuantity: 3, percentageOff: 5 },
            { minQuantity: 6, percentageOff: 10 },
          ],
        },
      }],
    };
    const cart = makeCart(100, [makeLine("L1", 4, 25)]);
    const { operations } = evaluate(cart, r);
    assert.deepEqual(operations[0].value, { percentage: 5 });
  });
});

describe("Action: bogo", () => {
  const bogoRuleset: Ruleset = {
    version: 1,
    rules: [{
      id: "r1", name: "buy2get1-50%", enabled: true, stopIfApplied: false,
      conditions: [],
      action: {
        type: "bogo",
        buy: 2,
        get: 1,
        getDiscountPercent: 50,
      },
    }],
  };

  it("grants 1 discounted item when 3 items present", () => {
    const cart = makeCart(90, [makeLine("L1", 3, 30)]);
    const { operations } = evaluate(cart, bogoRuleset);
    assert.equal(operations.length, 1);
    const op = operations[0] as ProductDiscountOperation;
    assert.equal(op.targets[0].quantity, 1);
    assert.deepEqual(op.value, { percentage: 50 });
  });

  it("grants 3 discounted items when 6 items present (3 sets of buy=2)", () => {
    // buy=2, get=1: floor(6/2)=3 sets → 3 get-items
    const cart = makeCart(180, [makeLine("L1", 6, 30)]);
    const { operations } = evaluate(cart, bogoRuleset);
    const op = operations[0] as ProductDiscountOperation;
    assert.equal(op.targets[0].quantity, 3);
  });

  it("no operation when not enough items to trigger buy threshold", () => {
    const cart = makeCart(30, [makeLine("L1", 1, 30)]);
    const { operations, trace } = evaluate(cart, bogoRuleset);
    assert.equal(operations.length, 0);
    assert.equal(trace[0].status, "skipped_condition");
  });

  it("bogo with collectionId only targets collection lines", () => {
    const r: Ruleset = {
      version: 1,
      rules: [{
        id: "r1", name: "sale bogo", enabled: true, stopIfApplied: false,
        conditions: [],
        action: {
          type: "bogo", buy: 2, get: 1, getDiscountPercent: 100,
          collectionId: COL_SALE,
        },
      }],
    };
    const cart = makeCart(90, [
      makeLine("L1", 3, 30, [inSale(true)]),  // eligible
      makeLine("L2", 5, 30, [inSale(false)]), // not in collection
    ]);
    const { operations } = evaluate(cart, r);
    const op = operations[0] as ProductDiscountOperation;
    // Only L1's quantity (3) matters for the buy threshold; grants 1
    assert.equal(op.targets.every(t => t.cartLineId === "L1"), true);
  });
});

// ---------------------------------------------------------------------------
// AND-combining conditions
// ---------------------------------------------------------------------------

describe("AND-combining multiple conditions", () => {
  const r: Ruleset = {
    version: 1,
    rules: [{
      id: "r1", name: "multi-cond", enabled: true, stopIfApplied: false,
      conditions: [
        { type: "cartSubtotal", operator: "gte", value: 100 },
        { type: "customerTag",  operator: "hasAny", value: ["vip"] },
      ],
      action: { type: "percentageOff", scope: "order", value: 20 },
    }],
  };

  it("fires when ALL conditions pass", () => {
    const cart = makeCart(150, [], ["vip"]);
    assert.equal(evaluate(cart, r).trace[0].status, "fired");
  });

  it("skips when subtotal condition fails (even with right tag)", () => {
    const cart = makeCart(50, [], ["vip"]);
    assert.equal(evaluate(cart, r).trace[0].status, "skipped_condition");
  });

  it("skips when tag condition fails (even with right subtotal)", () => {
    const cart = makeCart(150, [], ["bronze"]);
    assert.equal(evaluate(cart, r).trace[0].status, "skipped_condition");
  });

  it("skips when both conditions fail", () => {
    const cart = makeCart(50, [], ["bronze"]);
    assert.equal(evaluate(cart, r).trace[0].status, "skipped_condition");
  });
});

// ---------------------------------------------------------------------------
// Priority order and stacking
// ---------------------------------------------------------------------------

describe("Priority order — rules evaluated in array order", () => {
  it("first matching rule fires first in operations array", () => {
    const r: Ruleset = {
      version: 1,
      rules: [
        {
          id: "r1", name: "first", enabled: true, stopIfApplied: false,
          conditions: [{ type: "cartSubtotal", operator: "gte", value: 50 }],
          action: { type: "percentageOff", scope: "order", value: 5 },
        },
        {
          id: "r2", name: "second", enabled: true, stopIfApplied: false,
          conditions: [{ type: "cartSubtotal", operator: "gte", value: 100 }],
          action: { type: "percentageOff", scope: "order", value: 10 },
        },
      ],
    };
    const { operations, trace } = evaluate(makeCart(150), r);
    assert.equal(trace[0].ruleId, "r1");
    assert.equal(trace[0].status, "fired");
    assert.equal(trace[1].ruleId, "r2");
    assert.equal(trace[1].status, "fired");
    // Both operations present; r1's op first
    assert.equal(operations[0].ruleId, "r1");
    assert.equal(operations[1].ruleId, "r2");
  });
});

describe("stopIfApplied halts subsequent rules", () => {
  it("skips all rules after an exclusive rule fires", () => {
    const r: Ruleset = {
      version: 1,
      rules: [
        {
          id: "r1", name: "exclusive", enabled: true, stopIfApplied: true,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 20 },
        },
        {
          id: "r2", name: "never runs", enabled: true, stopIfApplied: false,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 10 },
        },
        {
          id: "r3", name: "also never", enabled: true, stopIfApplied: false,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 5 },
        },
      ],
    };
    const { operations, trace } = evaluate(makeCart(100), r);
    assert.equal(operations.length, 1);
    assert.equal(trace[0].status, "fired");
    assert.equal(trace[1].status, "skipped_stop");
    assert.equal(trace[2].status, "skipped_stop");
  });

  it("does NOT halt when stopIfApplied rule's conditions fail", () => {
    const r: Ruleset = {
      version: 1,
      rules: [
        {
          id: "r1", name: "exclusive fails", enabled: true, stopIfApplied: true,
          conditions: [{ type: "cartSubtotal", operator: "gte", value: 9999 }],
          action: { type: "percentageOff", scope: "order", value: 20 },
        },
        {
          id: "r2", name: "runs fine", enabled: true, stopIfApplied: false,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 10 },
        },
      ],
    };
    const { operations, trace } = evaluate(makeCart(100), r);
    assert.equal(trace[0].status, "skipped_condition");
    assert.equal(trace[1].status, "fired");
    assert.equal(operations.length, 1);
    assert.equal(operations[0].ruleId, "r2");
  });
});

describe("disabled rules are skipped without halting", () => {
  it("disabled rule does not fire and does not trigger stop", () => {
    const r: Ruleset = {
      version: 1,
      rules: [
        {
          id: "r1", name: "disabled exclusive", enabled: false, stopIfApplied: true,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 50 },
        },
        {
          id: "r2", name: "active", enabled: true, stopIfApplied: false,
          conditions: [],
          action: { type: "percentageOff", scope: "order", value: 10 },
        },
      ],
    };
    const { operations, trace } = evaluate(makeCart(100), r);
    assert.equal(trace[0].status, "disabled");
    assert.equal(trace[1].status, "fired");
    assert.equal(operations.length, 1);
    assert.equal(operations[0].ruleId, "r2");
  });
});

describe("empty ruleset returns empty result", () => {
  it("no operations, no trace entries", () => {
    const r: Ruleset = { version: 1, rules: [] };
    const { operations, trace } = evaluate(makeCart(100), r);
    assert.equal(operations.length, 0);
    assert.equal(trace.length, 0);
  });
});
