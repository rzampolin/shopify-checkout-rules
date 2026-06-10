# CheckoutRules — Schema & Engine Contract

This document is the single source of truth for the app-engineer building the UI and for
anyone integrating with the rule engine. The function-engineer owns this file.

---

## 1. Metafield Location

Two metafields live on the `DiscountAutomaticApp` (the single app discount):

| Purpose | Namespace | Key | Type | Shape |
|---------|-----------|-----|------|-------|
| Ruleset config | `$app` | `ruleset` | `json` | `{ version, rules[] }` — see §2 |
| Function input variables | `$app` | `function-input-vars` | `json` | `{ collectionIds, customerTags }` — see §5 |

The ruleset metafield is read by the Function via
`discount.metafield(namespace:"$app", key:"ruleset")` in the input query.

The input-variables metafield is consumed by Shopify's platform at runtime via the
`[extensions.input.variables]` configuration in `shopify.extension.toml` — Shopify injects
its top-level keys as GraphQL input query variables automatically.

Write path: `discountAutomaticAppCreate` / `discountAutomaticAppUpdate` with both
metafields in the same `metafields` array:
```json
[
  { "namespace": "$app", "key": "ruleset",             "type": "json", "value": "<ruleset JSON>" },
  { "namespace": "$app", "key": "function-input-vars", "type": "json", "value": "<vars JSON>" }
]
```

`saveRuleset()` in `app/server/discount.server.ts` writes both in one mutation call.

---

## 2. Rule-Config JSON Schema

The full value of the `$app:ruleset` metafield must conform to this shape:

```jsonc
{
  "version": 1,           // integer, always 1 for MVP
  "rules": [              // ordered array; index 0 = highest priority
    {
      "id": "r_01",                    // string, unique, stable across edits
      "name": "VIP $100+ → 15% off",  // string, shown in Preview + admin UI
      "enabled": true,                 // boolean; false = rule always skipped
      "stopIfApplied": false,          // boolean; true = halt all later rules after this fires
      "conditions": [ /* see §2.1 */ ],
      "action":     { /* see §2.2 */ }
    }
  ]
}
```

### 2.1 Conditions (implicit AND; all must pass for the rule to fire)

Empty `conditions` array means "always matches".

#### cartSubtotal

```jsonc
{
  "type": "cartSubtotal",
  "operator": "gte" | "lte" | "gt" | "lt" | "eq",
  "value": 100          // number, store currency units (e.g., 100 = $100.00)
}
```

#### customerTag

```jsonc
{
  "type": "customerTag",
  "operator": "hasAny" | "hasAll",
  "value": ["vip", "loyalty"]   // string[], tag list (case-insensitive match)
}
```

Guest checkouts (no customer) always fail this condition.

#### productInCollection

```jsonc
{
  "type": "productInCollection",
  "operator": "anyOf" | "allOf",
  "value": ["gid://shopify/Collection/123"]  // string[], Shopify GIDs
}
```

Passes when at least one cart line (anyOf) or at least one cart line that is a member of
ALL listed collections (allOf) exists.

#### quantity

```jsonc
{
  "type": "quantity",
  "operator": "gte" | "lte" | "gt" | "lt" | "eq",
  "value": 3            // number, total quantity across ALL cart lines
}
```

### 2.2 Actions

Exactly one action per rule.

#### percentageOff

```jsonc
{
  "type": "percentageOff",
  "scope": "order" | "product",
  "value": 15,                              // number, 0–100 (percent)
  "collectionId": "gid://shopify/Collection/123"  // optional; product scope only
                                                   // null/omit = all product lines
}
```

`scope: "order"` → `orderDiscountsAdd` operation on the full subtotal.
`scope: "product"` → `productDiscountsAdd` on all lines (or collection-filtered lines).

#### fixedOff

```jsonc
{
  "type": "fixedOff",
  "scope": "order" | "product",
  "value": 5,            // number, absolute money amount (e.g., 5 = $5.00)
  "collectionId": null   // optional; same semantics as percentageOff
}
```

#### tiered

```jsonc
{
  "type": "tiered",
  "scope": "order" | "product",
  "tiers": [
    { "minSubtotal": 50,  "percentageOff": 5  },   // minSubtotal and/or minQuantity
    { "minSubtotal": 100, "percentageOff": 10 },
    { "minSubtotal": 200, "percentageOff": 15 }
  ],
  "collectionId": null  // optional
}
```

Tiers are evaluated in array order; the **last** matching tier wins (highest-discount-last
convention — put the most generous tier at the end of the array). A tier matches when ALL
specified thresholds (`minSubtotal`, `minQuantity`) are satisfied. If no tier matches, the
action produces no operations and the rule is treated as not-fired.

#### bogo

```jsonc
{
  "type": "bogo",
  "buy": 2,                       // number, quantity the customer must buy
  "get": 1,                       // number, quantity the customer receives discounted
  "getDiscountPercent": 100,      // number, 0–100; 100 = free
  "collectionId": null            // optional; restricts buy-eligible lines to this collection
}
```

Engine calculation: `sets = Math.floor(totalBuyQty / buy)`, `getQty = sets * get`.
The discounted quantity is spread across qualifying lines in array order.

---

## 3. TypeScript Contracts

These types are canonical. Import from `app/lib/rule-engine/types.ts`.

### EngineCart

```ts
interface EngineCart {
  cost: { subtotalAmount: { amount: string } }; // decimal string, e.g. "120.00"
  lines: EngineLineItem[];
  customer: EngineCustomer | null;              // null for guest checkouts
}

interface EngineLineItem {
  id: string;                                   // cart line GID
  quantity: number;
  cost: { subtotalAmount: { amount: string } };
  variantId: string | null;
  productId: string | null;
  collectionMemberships: EngineCollectionMembership[];
}

interface EngineCollectionMembership {
  collectionId: string;   // Shopify collection GID
  isMember: boolean;
}

interface EngineCustomer {
  tagResults: Record<string, boolean>; // lowercase tag → hasTag
}
```

### EngineResult

```ts
interface EngineResult {
  operations: DiscountOperation[];
  trace: TraceEntry[];
}

type DiscountOperation = ProductDiscountOperation | OrderDiscountOperation;

interface ProductDiscountOperation {
  type: "productDiscountsAdd";
  message: string;
  targets: { cartLineId: string; quantity?: number }[];
  value: DiscountValue;
  ruleId: string;
}

interface OrderDiscountOperation {
  type: "orderDiscountsAdd";
  message: string;
  excludedCartLineIds: string[];
  value: DiscountValue;
  ruleId: string;
}

type DiscountValue =
  | { percentage: number }
  | { fixedAmount: { amount: string; appliesToEachItem: boolean } };
```

### Trace

```ts
type TraceStatus =
  | "fired"
  | "skipped_condition"   // a condition was not met
  | "skipped_stop"        // a prior stopIfApplied rule fired
  | "disabled";           // rule.enabled = false

interface TraceEntry {
  ruleId: string;
  ruleName: string;
  status: TraceStatus;
  reason: string;         // human-readable; shown in Preview UI
}
```

### evaluate() signature

```ts
import { evaluate } from "app/lib/rule-engine/engine.js";

evaluate(cart: EngineCart, ruleset: Ruleset): EngineResult
```

Pure function. No side effects. Safe to call in both Function WASM context and browser/Node
preview context.

---

## 4. No-Drift Sharing Mechanism

The engine is authored **once** at:

```
output/app/lib/rule-engine/
  engine.ts       ← evaluate() implementation
  types.ts        ← all TypeScript interfaces
  engine.test.ts  ← unit tests
```

The Function adapter at `extensions/checkout-rules-discount/src/` imports via a **relative
path**:

```ts
import { evaluate } from "../../../app/lib/rule-engine/engine.js";
import type { ... }  from "../../../app/lib/rule-engine/types.js";
```

The app Preview route imports the same source:

```ts
import { evaluate } from "~/lib/rule-engine/engine.js"; // Remix alias
```

There is **no copy, no symlink, no workspace package** — just two consumers of the same
directory tree using relative/alias imports. The Shopify CLI function build bundles the
imported source into the WASM artifact at deploy time, so the relative path resolves
correctly under the monorepo layout.

**Constraint:** do not move `app/lib/rule-engine/` without updating:
1. `extensions/checkout-rules-discount/src/cart_lines_discounts_generate_run.ts` (3 import paths)
2. The Remix app's import alias / barrel export

---

## 5. Function Input Query (final, validated)

File: `extensions/checkout-rules-discount/src/cart_lines_discounts_generate_run.graphql`

```graphql
query CartLinesDiscountsGenerateRun(
  $collectionIds: [ID!]
  $customerTags: [String!]
) {
  cart {
    cost {
      subtotalAmount {
        amount
      }
    }
    lines {
      id
      quantity
      cost {
        subtotalAmount {
          amount
        }
      }
      merchandise {
        __typename
        ... on ProductVariant {
          id
          product {
            id
            inCollections(ids: $collectionIds) {
              collectionId
              isMember
            }
          }
        }
      }
    }
    buyerIdentity {
      customer {
        hasTags(tags: $customerTags) {
          tag
          hasTag
        }
      }
    }
  }
  discount {
    discountClasses
    metafield(namespace: "$app", key: "ruleset") {
      jsonValue
    }
  }
}
```

Validated against the `functions_discount` schema (version 2026-04) via
`validate_graphql_codeblocks` — status: VALID.

### Variable injection strategy (runtime metafield — no deploy required)

`$collectionIds` and `$customerTags` are declared as **nullable** list variables
(`[ID!]` and `[String!]` — no trailing `!`). Nullability is required because if the
input-variables metafield is absent or a key is missing, Shopify resolves the variable to
`null`; a non-nullable (`!`) variable receiving `null` would fail execution.

`inCollections(ids: null)` and `hasTags(tags: null)` both return empty arrays, which the
Function adapter handles via its existing `?? []` fallbacks.

**How runtime injection works:**

1. `shopify.extension.toml` declares `[extensions.input.variables]` pointing at the
   `$app:function-input-vars` metafield (a separate metafield from `$app:ruleset`).
2. At runtime, Shopify reads that metafield and injects its top-level keys as GraphQL
   variables into the input query. The metafield must be a JSON object whose **top-level
   keys exactly match the variable names**:
   ```json
   { "collectionIds": ["gid://shopify/Collection/123"], "customerTags": ["vip"] }
   ```
3. When a merchant saves a ruleset, `saveRuleset()` calls `buildInputVariables(ruleset)`,
   which walks every rule condition and action to collect the union of all
   `productInCollection.value` GIDs and all `customerTag.value` tag strings.
4. Both metafields are written **together** in the same discount mutation's `metafields`
   array — no extra API call is needed.
5. The new variable values take effect on the **next Function invocation** — no deploy.

At runtime the engine resolves per-rule membership by matching `collectionId` values in
`EngineLineItem.collectionMemberships` and tag keys in `EngineCustomer.tagResults`.

**Platform limits to respect:**
- List variables may not exceed **100 elements** each (Shopify Functions platform limit).
  For MVP this is acceptable; enforce a UI-level warning if approaching the limit.
- The input-variables metafield itself must not exceed 10,000 bytes (platform limit on
  metafields returned to Functions).

**toml configuration:**
```toml
[extensions.input.variables]
namespace = "$app"
key       = "function-input-vars"
```

---

## 6. discountClasses Gating

The Function adapter checks `input.discount.discountClasses` before emitting operations:

- `productDiscountsAdd` operations are only emitted when `"PRODUCT"` is in `discountClasses`.
- `orderDiscountsAdd` operations are only emitted when `"ORDER"` is in `discountClasses`.

The discount is created/updated with `discountClasses: [PRODUCT, ORDER]` via
`discountAutomaticAppCreate`. Shipping is explicitly excluded from MVP.

---

## 7. BOGO Quantity Semantics

For `type: "bogo"`:
- `sets = Math.floor(totalBuyQty / buy)` where `totalBuyQty` = sum of quantities of all
  qualifying lines (those in `collectionId` if set, otherwise all lines).
- `getQty = sets * get` — total items to discount.
- Discounted quantity is distributed across qualifying lines in cart-array order, up to each
  line's full quantity.

Example: buy=2, get=1, 6 items in one line → sets=3, getQty=3, one target with quantity=3.

---

## 8. Integration Checklist for App-Engineer

1. When saving a ruleset, call `saveRuleset()` from `app/server/discount.server.ts`.
   It serializes the ruleset to JSON and writes **two** metafields in one discount mutation:
   - `$app:ruleset` — the full ordered ruleset config (read by the Function's input query).
   - `$app:function-input-vars` — `{ collectionIds, customerTags }` populated by
     `buildInputVariables(ruleset)`. Shopify injects these as input query variables at
     runtime. Changes take effect immediately with **no deploy**.
2. No `.graphql` file is ever rewritten at runtime. The query structure is fixed at deploy
   time; only the variable values (supplied via the metafield) change per ruleset save.
3. For the Preview route, import `evaluate` from `~/lib/rule-engine/engine.js` (same file).
   Build an `EngineCart` from the test-cart form inputs using the same shape as the Function
   adapter, then pass it to `evaluate(cart, ruleset)` and render `result.trace` and the
   final computed price.
4. `trace[].status` values: `"fired"` (rule applied), `"skipped_condition"` (condition
   failed), `"skipped_stop"` (exclusive rule before it fired), `"disabled"` (rule off).
5. Never copy `app/lib/rule-engine/`; always import from that directory.
6. The 100-element list limit applies to both `collectionIds` and `customerTags` in the
   input-variables metafield. Display a warning in the UI if a ruleset approaches this limit.
