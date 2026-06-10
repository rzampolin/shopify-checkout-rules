# CheckoutRules — Build Spec

> An embedded Shopify app that replaces Shopify Scripts (sunset 2026-06-30) with **one**
> Discount Function driven by merchant-defined, explicitly-ordered rules. A shared
> rule-engine module powers both the Function and an in-app Preview, so the two never drift.

---

## 1. MVP Feature Scope

| # | Feature | Notes |
|---|---------|-------|
| 1 | **Rule builder UI (Polaris)** | Conditions: cart subtotal, customer tags, product-in-collection, line quantity. Actions: percentage off, fixed off, tiered, BOGO. |
| 2 | **Explicit stacking** | Merchant drags rules into priority order; engine applies them in sequence inside the single Function. A rule may be marked *exclusive* (`stopIfApplied`) to halt later rules. |
| 3 | **Preview mode** | Merchant enters a test cart (products + qty + customer tag) and sees which rules fire and the final price **before** activating. Powered by the **same** `rule-engine` module as the Function. |
| 4 | **Config in metafields** | The full ordered ruleset is stored as JSON in one app-owned discount metafield, read directly by the Function at runtime. |

**Explicitly OUT of MVP (v2):** checkout UI extensions, shipping/payment customization,
per-rule usage limits, scheduled rules, analytics. Shipping discount class is not wired up.

---

## 2. Architecture (no-drift core)

```
                    ┌─────────────────────────────┐
                    │  rule-engine (pure TS)      │  ← single source of truth
                    │  evaluate(cart, ruleset)    │     no Shopify imports
                    │   → { operations, trace }   │
                    └──────────────┬──────────────┘
                ┌──────────────────┴───────────────────┐
                ▼                                       ▼
   ┌────────────────────────┐              ┌────────────────────────┐
   │ Discount Function      │              │ App Preview route       │
   │ run.ts adapts Shopify  │              │ adapts test-cart form   │
   │ input → engine input,  │              │ → engine input, renders │
   │ engine output → result │              │ trace + final price     │
   └────────────────────────┘              └────────────────────────┘
```

The engine is a framework-free TypeScript module. The Function and the app each own a thin
**adapter** that maps their world into the engine's normalized `EngineCart` and maps the
engine's `EngineResult.operations` out. Business logic lives only in the engine.

---

## 3. Minimal Access Scopes (each justified)

| Scope | Why it is required | Why nothing more |
|-------|--------------------|------------------|
| `write_discounts` | Create/update the single automatic **app discount** that hosts the Function, and write its ruleset metafield via `discountAutomaticAppCreate` / `...Update` + `metafieldsSet`. | Read access is implied; no order or customer write needed. |
| `read_products` | Power the Polaris collection/product resource pickers in the rule builder so merchants choose real collection IDs for `productInCollection` conditions. | `read` only — the app never mutates catalog data. |

**Deliberately excluded:** `read_customers` (customer-tag conditions are evaluated by the
Function from the live cart's `buyerIdentity`; the builder takes tags as free-text, so no
customer read is needed), `read_orders`, `write_products`, any checkout/shipping scopes.

---

## 4. Admin API objects & webhooks

**GraphQL Admin (2025-10) objects/mutations used by the app:**
- `discountAutomaticAppCreate` / `discountAutomaticAppUpdate` — create/update the one app
  discount bound to the Function (`functionId`), carrying `discountClasses: [PRODUCT, ORDER]`.
- `metafieldsSet` (or the discount mutation's `metafields` arg) — persist the ruleset JSON
  into the discount's `$app:ruleset` metafield (type `json`).
- `discountNodes` / `discountNode(metafield)` — load the saved ruleset on app boot/edit.
- `shopifyFunctions` (query) — discover the deployed Function's `id` to bind the discount.
- `Collection` / `Product` reads — resource picker (App Bridge) for collection conditions.

**Webhooks (template defaults + compliance):**
- `app/uninstalled` — clean up session + (optionally) the app discount.
- `app/scopes_update` — keep granted scopes in sync.
- Mandatory compliance (public app): `customers/data_request`, `customers/redact`,
  `shop/redact` — app stores no PII, so handlers acknowledge with 200 and a no-op.

---

## 5. Functions extension — input/output contract

**One** Discount Function extension, flavor **TypeScript**.

- **Type/template:** `discount`
- **Target:** `cart.lines.discounts.generate.run` (export `cart-lines-discounts-generate-run`)
- **Output type:** `CartLinesDiscountsGenerateRunResult` → `{ operations: [...] }`
- **Discount classes:** `PRODUCT`, `ORDER` (declared on the discount; shipping omitted in MVP)

**Input query (`src/cart_lines_discounts_generate_run.graphql`)** must fetch:
```graphql
query Input {
  cart {
    cost { subtotalAmount { amount } }
    lines {
      id
      quantity
      cost { subtotalAmount { amount } }
      merchandise {
        __typename
        ... on ProductVariant {
          id
          product {
            id
            inAnyCollection: inCollections(ids: $collectionIds) { collectionId isMember }
          }
        }
      }
    }
    buyerIdentity {
      customer { hasTags(tags: $customerTags) { tag hasTag } }
    }
  }
  discount {
    discountClasses
    metafield(namespace: "$app", key: "ruleset") { jsonValue }
  }
}
```
> The function-engineer owns finalizing exact field names against the live schema via
> `introspect_graphql_schema` + `validate_graphql_codeblocks`. Collection-membership and tag
> args are injected from the ruleset at build time where the schema requires literals, or
> resolved by iterating membership flags. Document the final query in SCHEMA.md.

**Output:** ordered `operations[]` of `productDiscountsAdd` / `orderDiscountsAdd`, each with
`candidates[]` (`message`, `targets`, `value.percentage|fixedAmount`) and a
`selectionStrategy`. The Function gates each op on `discount.discountClasses` membership.

---

## 6. Rule-config data model (summary — full schema in SCHEMA.md)

Stored as JSON in discount metafield `$app:ruleset`:
```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "r_01",
      "name": "VIP $100+ → 15% off order",
      "enabled": true,
      "stopIfApplied": false,          // explicit stacking: halt later rules if this fires
      "conditions": [                   // implicit AND (MVP)
        { "type": "cartSubtotal",        "operator": "gte",   "value": 100 },
        { "type": "customerTag",         "operator": "hasAny","value": ["vip"] },
        { "type": "productInCollection", "operator": "anyOf", "value": ["gid://shopify/Collection/1"] },
        { "type": "quantity",            "operator": "gte",   "value": 3 }
      ],
      "action": { "type": "percentageOff", "scope": "order", "value": 15 }
    }
  ]
}
```
Array order **is** priority (index 0 applied first). Actions: `percentageOff`, `fixedOff`,
`tiered` (`tiers[]` by subtotal/qty → percentage), `bogo` (`buy`, `get`, `getDiscountPercent`,
`collectionId?`). Engine returns `{ operations, trace }` where `trace[]` records, per rule,
whether it fired and why — consumed by Preview.

---

## 7. File tree (target)

```
output/
├── SPEC.md                  # this file
├── SCHEMA.md                # rule-config + engine contract (function-engineer)
├── README.md                # setup/run (release-engineer)
├── STORE_LISTING.md         # App Store listing copy (release-engineer)
├── shopify.app.toml         # scopes, webhooks, $app:ruleset metafield def
├── package.json
├── prisma/                  # session storage (template default)
├── app/                     # React Router embedded admin app (app-engineer)
│   ├── shopify.server.ts
│   ├── db.server.ts
│   ├── routes/
│   │   ├── app._index.tsx           # rule list + activate toggle
│   │   ├── app.rules.$id.tsx        # rule builder (conditions→action, drag-order)
│   │   ├── app.preview.tsx          # test-cart preview (uses rule-engine)
│   │   ├── app.server/discount.server.ts  # discount + metafield read/write
│   │   └── webhooks.*.tsx
│   └── lib/
│       ├── rule-engine/             # SHARED pure module (symlinked/imported by function)
│       │   ├── engine.ts            # evaluate(cart, ruleset) → { operations, trace }
│       │   ├── types.ts
│       │   └── engine.test.ts       # rule-engine unit tests
│       └── preview-adapter.ts
└── extensions/
    └── checkout-rules-discount/     # the one Discount Function (TypeScript)
        ├── shopify.extension.toml   # target + $app:ruleset metafield
        ├── src/
        │   ├── cart_lines_discounts_generate_run.ts        # adapter → engine
        │   ├── cart_lines_discounts_generate_run.graphql   # input query
        │   └── rule-engine/         # SAME engine source as app/lib/rule-engine
        └── package.json
```
> **No-drift mechanism:** the `rule-engine` directory is authored once and shared by both
> consumers (a path import or a tiny workspace package). function-engineer establishes the
> canonical location; app-engineer imports from it rather than copying. Document the chosen
> sharing mechanism in SCHEMA.md.

---

## 8. Hand-trace stacking scenarios (qa-tester must verify)

Given rules in priority order: **R1** (subtotal ≥ 100 → 15% off order),
**R2** (collection "Sale" → 10% off matching products, `stopIfApplied`),
**R3** (qty ≥ 3 of any → $5 off order).

1. Cart $120, 2 items, none in Sale → R1 fires (15% order), R2 skip, R3 skip (qty<3).
   Final ≈ $102. Trace: [R1 fired, R2 no, R3 no].
2. Cart $120, 4 items incl. Sale item → R1 fires, R2 fires (10% on Sale line) **and halts**;
   R3 never evaluated. Trace: [R1 fired, R2 fired+stop, R3 skipped].
3. Cart $80, 4 items, none in Sale → R1 skip (subtotal<100), R2 skip, R3 fires ($5 order).
   Final $75. Trace: [R1 no, R2 no, R3 fired].

Preview output and Function output for identical input **must match** (same engine).
