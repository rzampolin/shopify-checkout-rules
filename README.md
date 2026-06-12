# CheckoutRules

**Replace Shopify Scripts (sunset 2026-06-30) with a single Discount Function driven by merchant-defined, explicitly-ordered rules.** The shared rule engine powers both the live Function and an in-app Preview, so the two never drift.

---

## Architecture Overview

CheckoutRules is a Remix-based embedded Shopify admin app with a single TypeScript Discount Function. The core is a **shared rule engine** (pure TypeScript, no framework dependencies) that both consumers import without copying:

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
   │ (cart.lines.discounts  │              │ adapts test-cart form   │
   │  .generate.run)        │              │ → engine input, renders │
   │ Shopify input → engine │              │ trace + final price     │
   │ engine output → result │              │                         │
   └────────────────────────┘              └────────────────────────┘
```

**Ruleset storage:** The full ordered ruleset is persisted as JSON in the discount's `$app:ruleset` metafield, read directly by the Function at runtime.

**Key operations:**
- Create/update the single automatic app discount via `discountAutomaticAppCreate` / `discountAutomaticAppUpdate`
- Metafield mutations with `metafieldsSet` (or inline on discount mutations)
- Function discovery via `shopifyFunctions` query
- Product/collection resource pickers for conditions (Admin API reads)

---

## Prerequisites

- **Node 22.6.0+** (see package.json `engines.node`)
- **Shopify CLI 3.x+** (`shopify --version`)
- **Partner account** with app development access
- **Development store** on your Partner account with `checkout_ui_extensions` capability

---

## Setup & Run

### 1. Clone and install dependencies

```bash
npm install
```

### 2. Generate Prisma client and apply migrations

```bash
npm run setup
# or separately:
prisma generate && prisma migrate deploy
```

### 3. Configure credentials

```bash
cp .env.example .env
```

`shopify app dev` injects `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` automatically at startup from your linked Partner account — **do not set them in `.env`**. If you define them there, the Remix/Vite plugin overrides the CLI-injected values and breaks embedded auth (you will see `invalid_client` errors in the OAuth flow). See the comment block at the top of `.env.example` for a full explanation.

The only variables you may need to set manually in `.env` are:

- `SHOPIFY_APP_URL` — only for production deployments; `shopify app dev` sets this automatically via the Cloudflare tunnel URL during development.
- `DATABASE_URL` — defaults to `file:./dev.db` (SQLite). Swap for a Postgres/MySQL URL in production.

### 4. Link your app to the Partner account

```bash
npm run config:link
```

The CLI will prompt you to select your Partner account and app. This populates `shopify.app.toml` with your `client_id` and `application_url`.

### 5. Deploy the Function (first time only)

Before saving your first ruleset in the app, deploy the Function so the app can discover its `functionId`:

```bash
npm run deploy
```

(You only need to redeploy when the Function source code or input-query structure changes — not when merchant rules change.)

### 6. Start the dev server

```bash
npm run dev
```

The CLI will:
- Start the embedded Remix app on `localhost:39351`
- Expose it via a Cloudflare tunnel
- Prompt you to install the app on your dev store

After installation, navigate to the app in your Shopify admin. The **Rules** page lists saved rulesets; click **Edit** to build or preview rules.

---

## Scopes & Permissions

The app requests **two** minimal scopes (configured in `shopify.app.toml`):

| Scope | Purpose |
|-------|---------|
| `write_discounts` | Create and update the single automatic app discount that hosts the Function, and persist the ruleset JSON in its `$app:ruleset` metafield. |
| `read_products` | Power the Polaris collection and product resource pickers in the rule builder so merchants select real collection GIDs for `productInCollection` conditions. |

**Deliberately excluded:** `read_customers` (customer tags are evaluated from the live cart's `buyerIdentity`; builders enter tags as free text, no lookup needed), `read_orders`, `write_products`, any checkout or shipping scopes.

---

## Testing

### Run the rule-engine tests

The engine includes 37 unit tests covering all condition types, action types (percentage, fixed, tiered, BOGO), stacking rules, and exclusive (`stopIfApplied`) behavior:

```bash
npm run test:engine
```

All 37 tests currently pass.

### Dry-run rules with the Preview tool

1. In the app, go to **Rules** and click **Preview**.
2. Enter a test cart: product GIDs, quantities, customer tags, and cart subtotal.
3. Click **Evaluate Rules**.
4. The Preview renders:
   - Which rules fired and why (trace with human-readable reasons)
   - Final computed price after all discounts
   - Individual operation details (targets, discount amounts)

The Preview uses the **same** `evaluate()` function as the live Function, so output is guaranteed to match.

### Hand-trace with test scenarios

SPEC.md **§8** documents three stacking scenarios for QA verification:

1. **High-value cart, no sale items:** R1 fires (15% off order), R2 and R3 skip → ~$102.
2. **High-value with sale item:** R1 fires, R2 fires and stops → R3 never evaluated.
3. **Low-value, high qty:** R1 and R2 skip, R3 fires ($5 off order) → $75.

Use Preview to verify each scenario returns the expected trace and final price.

---

## Trade-offs & Deployment

### Production URL configuration

`shopify.app.toml` contains `application_url` and `redirect_urls` which are
currently set to `https://example.com` placeholders.

During `shopify app dev` these values are **automatically overridden** by the
CLI because `automatically_update_urls_on_dev = true` is set — the CLI
rewrites them to the live Cloudflare tunnel URL for the duration of the dev
session without touching the file on disk.

However, `include_config_on_deploy = true` is also set, which means every
time you run `shopify app deploy`, the CLI reads `shopify.app.toml` from disk
and pushes its current contents to the Partner Dashboard — including the URL
fields.  **If you leave the placeholder `https://example.com` in the file, a
`shopify app deploy` will reset your live app's URL to the placeholder on
every deploy**, breaking OAuth for all installed merchants.

Before running `shopify app deploy` against production, replace the
placeholder with your real production URL in both fields:

```toml
application_url = "https://your-real-app.example.com"

[auth]
redirect_urls = [ "https://your-real-app.example.com/auth/callback" ]
```

**Rule changes take effect immediately — no redeploy needed.** When `saveRuleset()` is called, the app writes the full ordered ruleset JSON into the discount's `$app:ruleset` metafield and writes the set of collection GIDs and customer tags used by the rules into the discount's `$app:function-input-vars` metafield. The Function reads both metafields at runtime via its input query; Shopify resolves the metafield values fresh on every checkout evaluation. Adding a rule that references a new collection or customer tag is therefore instantaneous — no `shopify app deploy` required.

**When you do need to redeploy:** Run `shopify app deploy` only when the Function source code itself changes (e.g., new condition or action type) or when the input-query structure changes (e.g., adding new GraphQL fields or query variables). Rule data changes — collections, tags, thresholds, ordering — never require a redeploy.

---

## Project Structure

```
output/
├── SPEC.md                  # Feature spec & architecture
├── SCHEMA.md                # Data model & engine contract
├── README.md                # This file
├── STORE_LISTING.md         # App Store copy
├── shopify.app.toml         # App config (scopes, webhooks, metafield)
├── package.json             # Root scripts + workspaces
├── .env.example             # Environment template
├── prisma/                  # Session storage (template default)
│   ├── schema.prisma
│   └── migrations/
├── app/                     # Remix embedded admin app
│   ├── shopify.server.ts    # Shopify App Bridge init
│   ├── db.server.ts         # Prisma session setup
│   ├── entry.client.tsx
│   ├── entry.server.tsx
│   ├── root.tsx             # App layout
│   ├── routes/
│   │   ├── auth.$.tsx       # OAuth flow
│   │   ├── app.tsx          # App shell
│   │   ├── app._index.tsx   # Rule list + activate toggle
│   │   ├── app.rules.$id.tsx # Rule builder (conditions/action, drag-order)
│   │   ├── app.preview.tsx  # Test-cart preview (uses engine)
│   │   ├── webhooks.*.tsx   # App lifecycle & GDPR compliance
│   ├── server/
│   │   └── discount.server.ts # Admin API: discount CRUD + ruleset/input-variable metafield writes
│   ├── lib/
│   │   ├── rule-engine/     # SHARED PURE ENGINE (no copies)
│   │   │   ├── engine.ts    # evaluate() → { operations, trace }
│   │   │   ├── types.ts     # TypeScript interfaces
│   │   │   └── engine.test.ts # 37 unit tests
│   │   └── preview-adapter.ts # Map test-cart form → EngineCart
├── extensions/
│   └── checkout-rules-discount/ # ONE Discount Function (TypeScript)
│       ├── shopify.extension.toml
│       ├── src/
│       │   ├── cart_lines_discounts_generate_run.ts # Adapter: Shopify → engine
│       │   └── cart_lines_discounts_generate_run.graphql # Input query
│       └── package.json
└── vite.config.ts          # Remix + TypeScript paths
```

**No-drift guarantee:** `app/lib/rule-engine/` is authored once. The Function and Preview import from it using relative and Remix alias paths respectively — no copy, no symlink. The CLI function build bundles the imported source into WASM, so relative paths resolve correctly.

---

## Limitations (v1 MVP)

- No checkout UI extensions (v2).
- No shipping or payment customization; PRODUCT and ORDER discount classes only.
- Conditions are AND-only; no OR operators (v2).
- No per-rule usage limits or scheduled rules (v2).
- No analytics or bulk imports (v2).
- Collection and customer-tag conditions reference data stored in metafields; changes take effect immediately with no redeploy.

---

## Troubleshooting

**"Could not find the deployed CheckoutRules Discount Function"**
- You haven't run `shopify app deploy` yet. The app discovers the Function's ID via the `shopifyFunctions` query; this ID is set at deploy time. Run `npm run deploy` once, then save rules.

**Function not picking up new collections/tags**
- No redeploy is needed. `saveRuleset()` writes the collection GIDs and customer tags into the `$app:function-input-vars` metafield on the discount, which the Function reads at runtime. If a newly-saved rule is not being evaluated, confirm the metafield was written successfully (check the Admin API response from the `metafieldsSet` call in `discount.server.ts`) and that the correct discount ID is active.

**Preview and Function output differ**
- This should never happen (both use the same engine). If it does, file a bug with your test cart JSON and ruleset.

---

## Next Steps

See **SPEC.md** for the full feature specification, **SCHEMA.md** for the rule-config data model and engine contract, and **STORE_LISTING.md** for the App Store listing copy.
