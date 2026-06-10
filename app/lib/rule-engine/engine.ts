// =============================================================================
// CheckoutRules Rule Engine — Pure evaluation logic
// NO Shopify imports. Framework-free. Used by both the Function adapter and
// the app Preview route. Never duplicate or copy this file.
// =============================================================================

import type {
  Action,
  BogoAction,
  Condition,
  DiscountOperation,
  DiscountValue,
  EngineCart,
  EngineLineItem,
  EngineResult,
  FixedOffAction,
  OrderDiscountOperation,
  PercentageOffAction,
  ProductDiscountOperation,
  ProductDiscountTarget,
  Rule,
  Ruleset,
  TieredAction,
  TieredTier,
  TraceEntry,
  TraceStatus,
} from "./types.js";

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

function parseMoney(amount: string): number {
  return parseFloat(amount) || 0;
}

function formatMoney(n: number): string {
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Condition evaluators
// ---------------------------------------------------------------------------

function compareNumber(
  actual: number,
  operator: "gte" | "lte" | "gt" | "lt" | "eq",
  threshold: number
): boolean {
  switch (operator) {
    case "gte": return actual >= threshold;
    case "lte": return actual <= threshold;
    case "gt":  return actual > threshold;
    case "lt":  return actual < threshold;
    case "eq":  return actual === threshold;
  }
}

function totalQuantity(lines: EngineLineItem[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

function evaluateCondition(
  condition: Condition,
  cart: EngineCart
): { pass: boolean; reason: string } {
  switch (condition.type) {
    case "cartSubtotal": {
      const subtotal = parseMoney(cart.cost.subtotalAmount.amount);
      const pass = compareNumber(subtotal, condition.operator, condition.value);
      return {
        pass,
        reason: pass
          ? `cart subtotal ${subtotal} ${condition.operator} ${condition.value}`
          : `cart subtotal ${subtotal} does not satisfy ${condition.operator} ${condition.value}`,
      };
    }

    case "customerTag": {
      if (!cart.customer) {
        return { pass: false, reason: "no customer (guest checkout)" };
      }
      const tagMap = cart.customer.tagResults;
      const required = condition.value;

      if (condition.operator === "hasAny") {
        const hit = required.some((t) => tagMap[t.toLowerCase()] === true);
        return {
          pass: hit,
          reason: hit
            ? `customer has at least one of [${required.join(", ")}]`
            : `customer has none of [${required.join(", ")}]`,
        };
      } else {
        // hasAll
        const missing = required.filter((t) => !tagMap[t.toLowerCase()]);
        const pass = missing.length === 0;
        return {
          pass,
          reason: pass
            ? `customer has all of [${required.join(", ")}]`
            : `customer missing tags: [${missing.join(", ")}]`,
        };
      }
    }

    case "productInCollection": {
      const requiredCollections = condition.value;
      // Check whether ANY line item has a product that satisfies the condition.
      const qualifyingLines = cart.lines.filter((line) => {
        if (!line.collectionMemberships.length) return false;
        if (condition.operator === "anyOf") {
          return requiredCollections.some((cid) =>
            line.collectionMemberships.some(
              (m) => m.collectionId === cid && m.isMember
            )
          );
        } else {
          // allOf: the product must be a member of ALL listed collections
          return requiredCollections.every((cid) =>
            line.collectionMemberships.some(
              (m) => m.collectionId === cid && m.isMember
            )
          );
        }
      });
      const pass = qualifyingLines.length > 0;
      return {
        pass,
        reason: pass
          ? `${qualifyingLines.length} line(s) match collection condition`
          : `no lines match collection condition [${requiredCollections.join(", ")}]`,
      };
    }

    case "quantity": {
      const qty = totalQuantity(cart.lines);
      const pass = compareNumber(qty, condition.operator, condition.value);
      return {
        pass,
        reason: pass
          ? `total quantity ${qty} ${condition.operator} ${condition.value}`
          : `total quantity ${qty} does not satisfy ${condition.operator} ${condition.value}`,
      };
    }
  }
}

/**
 * Evaluates ALL conditions for a rule (implicit AND).
 * Returns { pass, failReason } where failReason is the first failing condition
 * description (or empty string if all pass).
 */
function evaluateConditions(
  conditions: Condition[],
  cart: EngineCart
): { pass: boolean; failReason: string } {
  for (const condition of conditions) {
    const result = evaluateCondition(condition, cart);
    if (!result.pass) {
      return { pass: false, failReason: result.reason };
    }
  }
  return { pass: true, failReason: "" };
}

// ---------------------------------------------------------------------------
// Action builders — return zero or more DiscountOperation objects
// ---------------------------------------------------------------------------

function linesInCollection(
  lines: EngineLineItem[],
  collectionId: string | null | undefined
): EngineLineItem[] {
  if (!collectionId) return lines;
  return lines.filter((line) =>
    line.collectionMemberships.some(
      (m) => m.collectionId === collectionId && m.isMember
    )
  );
}

function buildPercentageOff(
  action: PercentageOffAction,
  cart: EngineCart,
  ruleId: string,
  ruleName: string
): DiscountOperation[] {
  const value: DiscountValue = { percentage: action.value };

  if (action.scope === "order") {
    const op: OrderDiscountOperation = {
      type: "orderDiscountsAdd",
      message: `${ruleName}: ${action.value}% off order`,
      excludedCartLineIds: [],
      value,
      ruleId,
    };
    return [op];
  }

  // product scope
  const targetLines = linesInCollection(cart.lines, action.collectionId);
  if (!targetLines.length) return [];
  const targets: ProductDiscountTarget[] = targetLines.map((l) => ({
    cartLineId: l.id,
  }));
  const op: ProductDiscountOperation = {
    type: "productDiscountsAdd",
    message: `${ruleName}: ${action.value}% off`,
    targets,
    value,
    ruleId,
  };
  return [op];
}

function buildFixedOff(
  action: FixedOffAction,
  cart: EngineCart,
  ruleId: string,
  ruleName: string
): DiscountOperation[] {
  const value: DiscountValue = {
    fixedAmount: { amount: formatMoney(action.value), appliesToEachItem: false },
  };

  if (action.scope === "order") {
    const op: OrderDiscountOperation = {
      type: "orderDiscountsAdd",
      message: `${ruleName}: $${action.value} off order`,
      excludedCartLineIds: [],
      value,
      ruleId,
    };
    return [op];
  }

  const targetLines = linesInCollection(cart.lines, action.collectionId);
  if (!targetLines.length) return [];
  const targets: ProductDiscountTarget[] = targetLines.map((l) => ({
    cartLineId: l.id,
  }));
  const op: ProductDiscountOperation = {
    type: "productDiscountsAdd",
    message: `${ruleName}: $${action.value} off`,
    targets,
    value,
    ruleId,
  };
  return [op];
}

function pickTier(tiers: TieredTier[], cart: EngineCart): TieredTier | null {
  const subtotal = parseMoney(cart.cost.subtotalAmount.amount);
  const qty = totalQuantity(cart.lines);
  let matched: TieredTier | null = null;
  for (const tier of tiers) {
    const subtotalOk =
      tier.minSubtotal === undefined || subtotal >= tier.minSubtotal;
    const qtyOk =
      tier.minQuantity === undefined || qty >= tier.minQuantity;
    if (subtotalOk && qtyOk) {
      matched = tier; // last match wins (ascending tier array convention)
    }
  }
  return matched;
}

function buildTiered(
  action: TieredAction,
  cart: EngineCart,
  ruleId: string,
  ruleName: string
): DiscountOperation[] {
  const tier = pickTier(action.tiers, cart);
  if (!tier) return [];

  const value: DiscountValue = { percentage: tier.percentageOff };

  if (action.scope === "order") {
    const op: OrderDiscountOperation = {
      type: "orderDiscountsAdd",
      message: `${ruleName}: ${tier.percentageOff}% off order (tiered)`,
      excludedCartLineIds: [],
      value,
      ruleId,
    };
    return [op];
  }

  const targetLines = linesInCollection(cart.lines, action.collectionId);
  if (!targetLines.length) return [];
  const targets: ProductDiscountTarget[] = targetLines.map((l) => ({
    cartLineId: l.id,
  }));
  const op: ProductDiscountOperation = {
    type: "productDiscountsAdd",
    message: `${ruleName}: ${tier.percentageOff}% off (tiered)`,
    targets,
    value,
    ruleId,
  };
  return [op];
}

function buildBogo(
  action: BogoAction,
  cart: EngineCart,
  ruleId: string,
  ruleName: string
): DiscountOperation[] {
  // Collect qualifying lines (those in the optional collectionId filter).
  const qualifyingLines = linesInCollection(cart.lines, action.collectionId);

  // Count total buy-eligible quantity across qualifying lines.
  const totalBuyQty = qualifyingLines.reduce((s, l) => s + l.quantity, 0);
  if (totalBuyQty < action.buy) return [];

  // Determine how many "get" sets we can grant.
  const sets = Math.floor(totalBuyQty / action.buy);
  let getRemaining = sets * action.get;
  if (getRemaining <= 0) return [];

  const targets: ProductDiscountTarget[] = [];
  for (const line of qualifyingLines) {
    if (getRemaining <= 0) break;
    const discountQty = Math.min(line.quantity, getRemaining);
    targets.push({ cartLineId: line.id, quantity: discountQty });
    getRemaining -= discountQty;
  }

  if (!targets.length) return [];

  const value: DiscountValue = { percentage: action.getDiscountPercent };
  const op: ProductDiscountOperation = {
    type: "productDiscountsAdd",
    message: `${ruleName}: Buy ${action.buy} Get ${action.get} (${action.getDiscountPercent}% off)`,
    targets,
    value,
    ruleId,
  };
  return [op];
}

function buildOperations(
  action: Action,
  cart: EngineCart,
  ruleId: string,
  ruleName: string
): DiscountOperation[] {
  switch (action.type) {
    case "percentageOff": return buildPercentageOff(action, cart, ruleId, ruleName);
    case "fixedOff":      return buildFixedOff(action, cart, ruleId, ruleName);
    case "tiered":        return buildTiered(action, cart, ruleId, ruleName);
    case "bogo":          return buildBogo(action, cart, ruleId, ruleName);
  }
}

// ---------------------------------------------------------------------------
// Main evaluate function
// ---------------------------------------------------------------------------

/**
 * Evaluates the ordered ruleset against the cart.
 *
 * Rules are processed in array order (index 0 = highest priority).
 * All conditions within a rule are AND-combined.
 * If a rule fires and has stopIfApplied = true, subsequent rules are
 * skipped regardless of their conditions.
 *
 * @returns { operations, trace } — operations can be mapped directly to
 *   CartLinesDiscountsGenerateRunResult; trace is for Preview/debugging.
 */
export function evaluate(
  cart: EngineCart,
  ruleset: Ruleset
): EngineResult {
  const operations: DiscountOperation[] = [];
  const trace: TraceEntry[] = [];
  let halted = false;

  for (const rule of ruleset.rules) {
    // --- disabled check ---
    if (!rule.enabled) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        status: "disabled" as TraceStatus,
        reason: "rule is disabled",
      });
      continue;
    }

    // --- stopIfApplied halt propagated from a prior rule ---
    if (halted) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        status: "skipped_stop" as TraceStatus,
        reason: "a prior exclusive rule fired; evaluation halted",
      });
      continue;
    }

    // --- condition evaluation (implicit AND) ---
    const { pass, failReason } = evaluateConditions(rule.conditions, cart);
    if (!pass) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        status: "skipped_condition" as TraceStatus,
        reason: `condition not met: ${failReason}`,
      });
      continue;
    }

    // --- build operations ---
    const ops = buildOperations(rule.action, cart, rule.id, rule.name);

    // An action that produces no ops (e.g., tiered with no matching tier,
    // or product-scope with no matching lines) is treated as not firing.
    if (ops.length === 0) {
      trace.push({
        ruleId: rule.id,
        ruleName: rule.name,
        status: "skipped_condition" as TraceStatus,
        reason: "conditions passed but action produced no eligible lines/tiers",
      });
      continue;
    }

    operations.push(...ops);

    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      status: "fired" as TraceStatus,
      reason: rule.stopIfApplied
        ? `fired; ${ops.length} operation(s) added; evaluation halted (stopIfApplied)`
        : `fired; ${ops.length} operation(s) added`,
    });

    if (rule.stopIfApplied) {
      halted = true;
    }
  }

  return { operations, trace };
}
