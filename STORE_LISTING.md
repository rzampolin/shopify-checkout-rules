# CheckoutRules — App Store Listing

## App Name & Tagline

**CheckoutRules**

*Your Shopify Scripts replacement: Rule-based discounts with explicit stacking control and live preview.*

---

## Short Description (60 words)

Replace Shopify Scripts before the 2026-06-30 sunset with CheckoutRules—a rule-driven discount engine that lets you define cart and product discounts in any order, control stacking with exclusive rules, and preview results live before activating. No code required.

---

## Long Description

### Migrate from Shopify Scripts with confidence

Shopify Scripts will sunset on June 30, 2026. CheckoutRules is a modern replacement built on Shopify Functions, giving you back your scripting power in a visual, rules-based interface.

### Rule-based discounts you control

Build discount rules with conditions on:
- **Cart subtotal** (greater than, less than, equals)
- **Customer tags** (loyalty tiers, wholesale, VIP)
- **Products in collections** (seasonal, sale, new arrivals)
- **Item quantity** (bulk discounts)

Apply discounts with actions:
- **Percentage off** (order or product)
- **Fixed amount off** (order or product)
- **Tiered discounts** (thresholds unlock bigger savings)
- **Buy-one-get-one** (BOGO with custom terms)

### Explicit stacking order

Drag rules into the priority order that matters to your business. Use exclusive rules to stop subsequent rules from applying—control discount interactions exactly as you need them. No hidden stacking logic.

### Live preview before activating

Test any cart scenario before activating rules. See which rules fire, why they fired, and the final price. The preview runs the same engine as the live discount function—what you see is what merchants get.

### Minimal permissions, maximum security

CheckoutRules requests only two scopes:
- **Write Discounts** — to create and manage the discount that runs your rules.
- **Read Products** — to let you pick collections and products for conditions.

No access to customer data, order history, or shop settings beyond what you explicitly select.

---

## Key Features

- **Merchant-friendly rule builder** — conditions and actions without code
- **Drag-and-drop rule ordering** — control which rules apply first
- **Exclusive (stop-if-applied) rules** — halt further rule evaluation
- **Live preview** — dry-run any cart before activating
- **Collection and tag filters** — target specific audiences and products
- **Tiered and BOGO actions** — complex discount logic made simple
- **One discount function** — lightweight, fast, no duplicate processing
- **Shopify Scripts replacement** — designed for the sunset migration

---

## How It Works

1. **Define your rules** — Add conditions (subtotal, tags, collections, qty) and choose an action (percentage, fixed, tiered, or BOGO).

2. **Arrange priority** — Drag rules into the order you want them applied. Mark rules as exclusive to stop subsequent rules.

3. **Preview your discounts** — Enter a test cart and see which rules fire, their reasons, and the final price.

4. **Activate** — Save your ruleset and it goes live on your store. The discount applies automatically at checkout.

---

## Permissions Explained

**Write Discounts**
- CheckoutRules creates and updates one automatic discount that hosts its rule engine.
- The app stores your ruleset (the rules you define) as metadata on that discount.
- This is the only way to run a Shopify Function—there's no alternative.

**Read Products**
- When building rules, you can select specific collections from your catalog (e.g., "Sale Items," "Wholesale Only").
- The app reads your product data to show you real collection names so you pick the right one.
- The app never modifies your products or collections.

---

## What's Included

- Unlimited rules and conditions
- All four discount action types (percentage, fixed, tiered, BOGO)
- Full rule priority and exclusive rule control
- Live preview on any test cart
- One-click rule activation and deactivation

---

## Pricing

Free during beta. Pricing to be announced.

---

## Support

For setup help, questions, or bug reports, contact support@checkoutrules.example or visit our docs at https://checkoutrules.example/docs.

---

## What This App Does NOT Do (v1)

- Does not modify checkout UI (e.g., adding custom fields, labels, or widgets)
- Does not customize shipping methods or rates
- Does not apply to payment methods or gift cards
- Does not support scheduled rules (e.g., "activate this rule on Jan 1")
- Does not track rule usage or analytics
- Does not import rules from Shopify Scripts (manual migration)
- Does not support OR logic in conditions (all conditions must be met)

---

## Shopify Scripts Sunset Messaging

**Searching for a Scripts replacement?**

Shopify Scripts—the previous scripting solution—sunsets on June 30, 2026. CheckoutRules is a modern replacement designed specifically to help merchants like you migrate discount logic from Scripts.

If you had Scripts like:

```ruby
# Apply 15% off to VIP customers on carts over $100
if cart.subtotal_price >= 100.0 && customer && customer.tags.include?('vip')
  cart.discount += cart.subtotal_price * 0.15
end
```

In CheckoutRules, you'd define a rule:
1. **Condition:** Cart subtotal >= $100
2. **Condition:** Customer has tag "vip"
3. **Action:** 15% off order

The rest is automatic. No scripting knowledge required.

---

## SEO Keywords

shopify scripts replacement, discount function, cart discounts, product discounts, buy one get one, tiered discounts, customer tag discounts, collection discounts, BOGO, checkout rules, shopify functions
