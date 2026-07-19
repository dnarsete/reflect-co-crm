# Shopify Integration — Activation Guide

The Shopify integration is **fully built and dormant**. The CRM doesn't touch Shopify until you complete the steps below. Zero cost, zero risk while dormant.

## Your current situation (Pause and Build plan, $9/mo)

Shopify **Pause and Build** cannot process payments — no card charging, no checkout, no Shopify Payments. Everything else works: catalog, customers, draft orders, webhooks, API access. All prep work below can be done today; the only step that requires an upgrade is **collecting money via the invoice link**.

**What works on Pause and Build:**
- Test connection (step 7.1)
- Sync products from Shopify → CRM (step 7.2)
- Push CRM accounts → Shopify customers (auto on account save)
- Create Shopify draft orders from CRM orders (auto on order finalize)
- Webhook events (inventory / product updates)

**What requires upgrading to Basic Shopify ($39/mo) or higher:**
- Sending a working "pay this invoice" link that actually accepts a card
- `orders/paid` webhook firing (needs a real payment)
- Fulfillment / tracking updates

Recommended: complete steps 1-6 on Pause and Build so activation is one flag flip when you upgrade.

## What's already in the codebase

- `supabase/shopify-prep.sql` — schema: linkage columns on products/accounts/orders, sync log, settings
- `supabase/functions/shopify-sync/index.ts` — secure proxy: test connection, pull products+inventory, push customer, create draft order, get order status
- `supabase/functions/shopify-webhook/index.ts` — receives Shopify events (inventory + order updates), HMAC-verified
- `config.js` — `SHOPIFY_MODE` flag (currently `'off'`)
- Admin tab — "Shopify integration" card with Test connection + Sync products buttons

## What the integration does once live

| Capability | How |
|---|---|
| Product catalog | Pull from Shopify → CRM `products` table (replaces hardcoded products) |
| Inventory / stock | Real stock levels; auto-updated via webhook when Shopify changes |
| Customers | Push a CRM account → create a Shopify customer (linked by ID) |
| Orders | Create a Shopify **draft order** from a CRM order — you confirm/charge in Shopify |
| Fulfillment / tracking | Webhook updates the CRM order with tracking # when Shopify ships it |

The CRM **never** charges a card directly — it creates draft orders that your team confirms in Shopify.

---

## Activation steps (~20 minutes, one time)

### 1. Create a Shopify Custom App

In your Shopify admin:
1. **Settings → Apps and sales channels → Develop apps**
2. **Allow custom app development** (if prompted)
3. **Create an app** → name it `Reflect CRM`
4. **Configure Admin API scopes** — enable exactly these:

   **Read-only:**
   - `read_products`
   - `read_inventory`
   - `read_locations`
   - `read_fulfillments`
   - `read_orders`

   **Read + write:**
   - `read_customers`, `write_customers`
   - `read_draft_orders`, `write_draft_orders`

   Do **not** enable: `write_products`, `write_inventory`, `write_orders`, anything for payments/payouts/store settings.

5. **Install app** → it generates an **Admin API access token** starting with `shpat_…`
6. Copy that token. Also note your store URL, e.g. `thereflectco.myshopify.com`.

### 2. Run the database prep

Supabase SQL Editor → paste `supabase/shopify-prep.sql` → Run.

### 3. Deploy the two Edge Functions

Via Supabase Dashboard (Functions → Create a new function):
- Name `shopify-sync` → paste contents of `supabase/functions/shopify-sync/index.ts` → Deploy
- Name `shopify-webhook` → paste contents of `supabase/functions/shopify-webhook/index.ts` → Deploy

Or via CLI: `supabase functions deploy shopify-sync && supabase functions deploy shopify-webhook`

### 4. Set the secrets

Supabase Dashboard → Project Settings → Edge Functions → Manage secrets. Add:

| Secret | Value |
|---|---|
| `SHOPIFY_STORE_URL` | `thereflectco.myshopify.com` (your store) |
| `SHOPIFY_ADMIN_TOKEN` | the `shpat_…` token from step 1 |
| `SHOPIFY_WEBHOOK_SECRET` | any long random string you choose (used to verify webhooks) |
| `SHOPIFY_API_VERSION` | optional — defaults to `2026-01` |

(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are injected automatically — don't set those.)

### 5. Register webhooks (so Shopify pushes updates to the CRM)

In Shopify admin → Settings → Notifications → Webhooks, OR via the API, create webhooks pointing at:

```
https://clzpkjssxvmgvgloxehk.supabase.co/functions/v1/shopify-webhook
```

Topics to subscribe:
- `inventory_levels/update`
- `products/update`
- `orders/fulfilled`
- `orders/updated`

Use the same `SHOPIFY_WEBHOOK_SECRET` value for signing.

### 6. Flip the flag

In `config.js`: `SHOPIFY_MODE: 'off'` → `'live'`. Commit + push. Site updates in ~60s.

Once flipped:
- **Creating a new account** in the CRM automatically pushes it as a Shopify customer.
- **Finalizing an order** automatically creates a Shopify draft order and stores an invoice link on the order. You'll see a "Shopify: draft sent" badge in the order list, and an "Invoice link" you can send to the customer (once your plan can accept payment).
- **Manual retry** — if a push fails (Shopify down, missing linkage), open the order and click **Push to Shopify**.

### 7. Verify

1. Admin tab → Shopify integration card → **Test connection** → should show your shop name
2. **Sync products now** → pulls your catalog; product count appears
3. Check the Products / orders — Shopify-linked data should be present

---

## Cost

- Edge Functions: free up to 500k invocations/month (you'll use a tiny fraction)
- Shopify: no extra cost — uses your existing Shopify plan
- No per-sync fees

## Deactivate

Set `SHOPIFY_MODE: 'off'` in config.js, or uninstall the Custom App in Shopify (instantly revokes the token). The CRM keeps working with its last-synced data.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Shopify not configured" | `SHOPIFY_STORE_URL` / `SHOPIFY_ADMIN_TOKEN` secrets not set |
| "Shopify API 401" | Token wrong or app uninstalled |
| "Shopify API 403" | Missing a scope — re-check step 1 |
| Webhooks not updating CRM | Webhook URL wrong, or `SHOPIFY_WEBHOOK_SECRET` mismatch between Shopify and the secret |
| Products synced but stock all 0 | `read_inventory` scope missing, or inventory not tracked in Shopify |
