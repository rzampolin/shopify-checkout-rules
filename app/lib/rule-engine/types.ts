// =============================================================================
// CheckoutRules Rule Engine — Types
// Pure TypeScript, NO Shopify imports. Used by both the Function adapter and
// the app Preview route. Never duplicate or copy this file.
// =============================================================================

// ---------------------------------------------------------------------------
// Engine input (Shopify-agnostic cart representation)
// ---------------------------------------------------------------------------

export interface EngineMoney {
  /** Decimal string, e.g. "120.00" */
  amount: string;
}

export interface EngineCollectionMembership {
  collectionId: string;
  isMember: boolean;
}

export interface EngineLineItem {
  id: string;
  quantity: number;
  /** Line-level cost (qty * unit price). */
  cost: { subtotalAmount: EngineMoney };
  /** Null for custom / gift-card lines. */
  variantId: string | null;
  productId: string | null;
  /**
   * Collection membership results pre-fetched by the input query.
   * Each entry corresponds to one collectionId that appears anywhere in the
   * ruleset's productInCollection conditions.
   */
  collectionMemberships: EngineCollectionMembership[];
}

export interface EngineCustomer {
  /**
   * Tags fetched by hasTags(tags:[…]).
   * Key = tag string (lowercase), value = whether the customer has that tag.
   */
  tagResults: Record<string, boolean>;
}

export interface EngineCart {
  /** Cart-level subtotal before any discounts. */
  cost: { subtotalAmount: EngineMoney };
  lines: EngineLineItem[];
  /** Null for guest checkouts. */
  customer: EngineCustomer | null;
}

// ---------------------------------------------------------------------------
// Rule config (stored as JSON in the $app:ruleset metafield)
// ---------------------------------------------------------------------------

export type ConditionOperator =
  | "gte"   // greater-than-or-equal
  | "lte"   // less-than-or-equal
  | "gt"    // greater-than
  | "lt"    // less-than
  | "eq"    // equal
  | "hasAny" // customer has ANY of the listed tags
  | "hasAll" // customer has ALL of the listed tags
  | "anyOf"  // product is in ANY of the listed collections
  | "allOf"; // product is in ALL of the listed collections

export interface CartSubtotalCondition {
  type: "cartSubtotal";
  operator: "gte" | "lte" | "gt" | "lt" | "eq";
  /** Numeric value in the store's currency (e.g. 100 = $100.00). */
  value: number;
}

export interface CustomerTagCondition {
  type: "customerTag";
  operator: "hasAny" | "hasAll";
  value: string[]; // list of tag strings
}

export interface ProductInCollectionCondition {
  type: "productInCollection";
  operator: "anyOf" | "allOf";
  value: string[]; // list of collection GIDs
}

export interface QuantityCondition {
  type: "quantity";
  operator: "gte" | "lte" | "gt" | "lt" | "eq";
  /** Total quantity across all cart lines. */
  value: number;
}

export type Condition =
  | CartSubtotalCondition
  | CustomerTagCondition
  | ProductInCollectionCondition
  | QuantityCondition;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type ActionScope = "order" | "product";

export interface PercentageOffAction {
  type: "percentageOff";
  scope: ActionScope;
  /** 0–100, e.g. 15 = 15 %. */
  value: number;
  /** Only meaningful when scope = "product". GID of a collection to restrict
   *  the discount to lines whose product is a member of that collection.
   *  Omit (or null) to apply to ALL product lines. */
  collectionId?: string | null;
}

export interface FixedOffAction {
  type: "fixedOff";
  scope: ActionScope;
  /** Absolute money amount, e.g. 5 = $5.00. */
  value: number;
  collectionId?: string | null;
}

export interface TieredTier {
  /** Minimum cart subtotal that activates this tier. */
  minSubtotal?: number;
  /** Minimum total cart quantity that activates this tier. */
  minQuantity?: number;
  /** Percentage discount for this tier (0–100). */
  percentageOff: number;
}

export interface TieredAction {
  type: "tiered";
  scope: ActionScope;
  /**
   * Evaluated in array order; the LAST matching tier wins
   * (i.e., higher tiers should appear later in the array).
   */
  tiers: TieredTier[];
  collectionId?: string | null;
}

export interface BogoAction {
  type: "bogo";
  /** Quantity the customer must buy. */
  buy: number;
  /** Quantity the customer gets discounted. */
  get: number;
  /** Discount percentage on the "get" items (0–100). 100 = free. */
  getDiscountPercent: number;
  /** If set, only lines in this collection qualify as "buy" items. */
  collectionId?: string | null;
}

export type Action =
  | PercentageOffAction
  | FixedOffAction
  | TieredAction
  | BogoAction;

// ---------------------------------------------------------------------------
// Rule
// ---------------------------------------------------------------------------

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  /**
   * When true: if this rule fires, ALL subsequent rules in the array are
   * skipped (exclusive / stop-if-applied stacking halt).
   */
  stopIfApplied: boolean;
  /** All conditions must pass (implicit AND). Empty = always passes. */
  conditions: Condition[];
  action: Action;
}

// ---------------------------------------------------------------------------
// Ruleset (top-level metafield value)
// ---------------------------------------------------------------------------

export interface Ruleset {
  version: 1;
  rules: Rule[];
}

// ---------------------------------------------------------------------------
// Engine output — operations (Shopify-agnostic, trivially mappable)
// ---------------------------------------------------------------------------

export type DiscountValue =
  | { percentage: number }
  | { fixedAmount: { amount: string; appliesToEachItem: boolean } };

export interface ProductDiscountTarget {
  cartLineId: string;
  quantity?: number;
}

export interface ProductDiscountOperation {
  type: "productDiscountsAdd";
  message: string;
  targets: ProductDiscountTarget[];
  value: DiscountValue;
  /** Rule id that produced this operation. */
  ruleId: string;
}

export interface OrderDiscountOperation {
  type: "orderDiscountsAdd";
  message: string;
  /** Cart-line IDs to exclude from the order discount. Empty = whole order. */
  excludedCartLineIds: string[];
  value: DiscountValue;
  ruleId: string;
}

export type DiscountOperation = ProductDiscountOperation | OrderDiscountOperation;

// ---------------------------------------------------------------------------
// Trace (used by Preview)
// ---------------------------------------------------------------------------

export type TraceStatus =
  | "fired"
  | "skipped_condition"   // one or more conditions did not pass
  | "skipped_stop"        // a prior rule with stopIfApplied fired
  | "disabled";           // rule.enabled = false

export interface TraceEntry {
  ruleId: string;
  ruleName: string;
  status: TraceStatus;
  /** Human-readable explanation of why the rule was skipped or fired. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Engine result
// ---------------------------------------------------------------------------

export interface EngineResult {
  operations: DiscountOperation[];
  trace: TraceEntry[];
}
