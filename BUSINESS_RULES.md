# The Reflect Co — CRM Business Rules

This document captures the business rules the CRM enforces. Use it as a reference when making changes, hiring a developer, or onboarding an admin. Each rule notes **where it's enforced** (database vs application code vs configuration) so you know what would break if a rule changes.

Source of truth for the schema: `supabase/schema.sql` and the migrations in `supabase/*.sql`. Source of truth for behavior: `app.js` and the Edge Functions.

---

## Company identity

- **Legal name:** The Reflect Co
- **Website:** thereflectco.com
- **Mailing / shipping address:** 3642 S. Jason Street, Englewood, CO 80210
- **Phone:** TBD (placeholder in `settings.company`)

Configurable in **Admin → Settings → Company info** (stored in `settings.company` JSONB).

---

## Roles & permissions

| Role | Can do | Cannot do |
|---|---|---|
| **Admin** | Everything: see all reps' data, edit anyone's records, edit notes outside the 24h window, manage promotions, manage account types, change system settings, view the audit log | — |
| **Rep** | Manage their own accounts, orders, forecasts, prospects, and notes (per RLS). Add notes (24h edit window). Use promo codes. See active promotions and the product catalog. | See or edit any other rep's data. Manually discount orders. Edit/delete notes after 24h (except their own first-day window). Manage promotions, settings, or other reps. |

Enforced in: **Postgres Row Level Security** policies on every table. The admin/rep role lives on `profiles.role`. RLS helpers `public.is_admin()` and `public.my_rep_id()` are SECURITY DEFINER, bypassing RLS on internal lookups.

---

## Rep accounts

### Sign-up

- Anyone can sign up at the CRM URL.
- **Required fields at signup:** email, password (12+ char, mixed-case/digits/symbols, not in known leak lists), full name, cell phone.
- **Optional at signup:** company, street, city, state, ZIP.
- New reps are auto-assigned the next available rep ID (`R-002`, `R-003`, ...). R-001 is reserved for the first admin.
- **Approval gate:** uninvited sign-ups land **disabled** — admin must Enable them before they can do anything.
- **Invited sign-ups** (admin pre-added them via Admin → Reps → + Add rep): the matching `pending_invites` row supplies rep_id / role / commission / territory. They land enabled and immediately functional.
- **Email confirmation:** required (Supabase Auth setting). Sign-up email contains a confirmation link.

Enforced in:
- DB trigger `public.handle_new_user` (auto-assigns rep_id, applies invite, sets disabled flag)
- Supabase Auth settings (password policy, email confirmation)
- Frontend signup form (two-stage form expands after Create account)

### MFA / passwords

- Password is required at signup. MFA (TOTP / Passkey) is optional today.
- **Pre-launch action item:** enforce MFA for admin role (deferred until go-live; tracked in launch checklist).

### Session policies

- **Idle timeout:** 30 minutes of no interaction → signed out.
- **Absolute timeout:** 12 hours after sign-in → signed out regardless of activity.
- **Disabled-user lockout:** if a profile's `disabled = true`, they cannot use the app even if their session token is valid (checked at `boot()`).

---

## Accounts (customers)

### Identifiers

- **Account number:** auto-generated as `ACC-####` (4-digit, zero-padded). Counter lives in `counters.account`. Trigger `public.set_account_number` fills it on insert if blank.
- Account type is a dropdown driven by the `account_types` table. Default seed: Dermatologist, Medical Spa, Boutique, Hotel, Retail Store, Salon, Other. Admin can add/remove types.

### Required vs optional

The account form has many fields; **none are technically required at the database level** to allow quick capture in the field. In practice, reps should fill in:
- Business name
- Account type
- One contact path (email, cell, OR business phone)
- One address (business OR billing)

### Tax-exempt accounts

- Each account has a `tax_exempt` boolean (default `false`) and optional `sales_tax_license` / `sales_tax_state` text fields.
- **When `tax_exempt = true`**, orders for that account are not charged sales tax. The license/state fields are *documentation only* — the box is what controls behavior.
- **When `tax_exempt = false`**, the default tax rate applies (see "Tax").
- An admin or a rep can flip the box on any account they have access to.
- On any order, the rep can override per-order (toggle the box, enter license #). Saving the order propagates those values **back to the account** — future orders inherit.

Enforced in: `accounts.tax_exempt` column + tax computation in `orders.refresh()` + sync-back in `orders.syncTaxToAccount()`.

---

## Orders

### Identifiers

- **Order number:** auto-generated as `ORD-####` when an order transitions to `status = 'finalized'`. Counter lives in `counters.order`. Trigger `public.set_order_number` handles it.
- Until finalized, an order is in `draft` status and has no order number.

### Discount policy

- **Reps cannot manually discount.** The order form has no "discount $" or "discount %" input for reps.
- Discounts apply only via **promo codes** managed in the Promotions tab.
- The percent-off applies to subtotal. Free-shipping codes zero out shipping. Bonus-product / access-perk codes don't change the price but record the perk on the order.

Enforced in: order form UI (no discount input) + `orders.applyPromo()` enforces minimum-qty rules.

### Default shipping

- **$30** per order. Configurable in Admin → Settings → Default shipping.
- Reps can edit the shipping amount per order (no enforcement against editing — handled by trust + audit log).

### Tax

- **Default rate:** ~8.81% (Colorado state + Denver county combined). Stored as decimal in `settings.tax_rate_default`.
- **Default label:** "Colorado + Denver County". In `settings.tax_label_default`.
- **Tax-exempt override:** if the order's `tax_exempt = true`, rate becomes 0 and label becomes "Tax-exempt" (with license # appended if provided).
- Configurable in Admin → Settings → Default tax rate.

**Production note:** Real multi-jurisdiction tax should use Shopify Tax or Avalara (Phase 3). The single-rate default is a placeholder for Colorado-based customers.

### Payments

- Accepted methods (configurable in the order form): Visa, Mastercard, Amex, Apple Pay, Venmo, PayPal, ACH.
- **Card payments require a captured signature** before finalize. The order form has a signature pad (canvas drawing); the resulting PNG data URL is stored in `orders.payment.signature` JSONB. Finalize is blocked otherwise.
- **Card data is NEVER stored.** Only method + last 4 + signature.
- All sales final. No payment terms (no Net 30). Reps cannot extend credit.

### Returns

- Allowed only for **shipping damage**, case-by-case admin approval.
- No system enforcement; documented policy.

### High-discount alerts

- If an order's effective discount % ≥ `high_discount_alert_pct` (default 20%), the rep gets a confirmation prompt before finalize: "High discount (X%) — admin will be notified."
- The notification itself is informational right now (not wired to email). Admin can review via the audit log.

Configurable in Admin → Settings → High discount alert %.

---

## Promotions

- Admin-managed only. Reps can read; they cannot create/edit.
- Each promo has:
  - **Code** (uppercased text, unique)
  - **Kind**: `percent`, `shipping`, `bonus`, or `access`
  - **Value**: percent off (only relevant for `percent` kind)
  - **Min qty**: minimum total units required to apply
  - **Perks**: free-text description (e.g., "Seminar access")
  - **Active**: boolean toggle
- Seed promos: WELCOME10 (10% off), FREESHIP24 (free shipping at 24+ units), BOGO48 (bonus product at 48+ units), SEMINAR100 (seminar access at 100+ units).

---

## Account notes

- Reps add notes ("call log", "visit", "voicemail left", etc.) inline on each account.
- **Each note's author can edit or delete it for 24 hours after posting.** After 24h, it's locked.
- **Admin can edit/delete any note at any time**, regardless of age or author.
- The 24-hour rule is **enforced by Postgres RLS policies on `account_notes`** — even if the UI buttons are bypassed via direct API calls, the database rejects the update/delete.

Enforced in: RLS policies on `account_notes` use `created_at > now() - interval '24 hours'`.

---

## Forecasts

- Reps log expected sales by month, linking to either an existing **account** OR a **prospect** (lead not yet a customer).
- Each forecast captures: period month, contact, account type, appointment kind (new/existing), appointment date, monthly $, quarterly $, close probability %, status, source, notes.
- Reps see only their own; admin sees all and gets a rollup view.
- **Cases-needed calculation:** sum of (monthly × close% / 100) across all open forecasts ÷ $600 per case of Appose Lip TX = cases admin should order.

Enforced in: RLS on `forecasts` + app rollup logic in `forecasts.render()`.

---

## Products

- Currently managed via SQL (no UI editor yet). Admin can add/edit/disable via Supabase Table Editor or SQL.
- Each product: SKU, name, wholesale price, stock, active flag.
- Phase 3 (Shopify integration) will replace this with live Shopify catalog pull.

Seed products: Reflect Serum 30ml, Reflect Hydrating Mask, Reflect Starter Kit, Appose Lip TX (case of 24 at $600).

---

## Auto-generated identifiers

All counters live in the `counters` table:

| Counter | Format | Where used |
|---|---|---|
| `account` | `ACC-0001` | accounts.account_number |
| `order` | `ORD-1001` | orders.order_number (set on finalize) |
| `rep` | `R-002` | profiles.rep_id (set on signup if not pre-invited; R-001 reserved for first admin) |

Atomically incremented via `public.next_counter(key)` SECURITY DEFINER function.

---

## Audit & retention

- **All inserts / updates / deletes** on accounts, orders, forecasts, account_notes, profiles, promotions, and products are logged to `audit_log` (who, when, before/after JSON).
- Only admin can read the audit log (RLS-enforced).
- **No automatic purge.** Audit log retained indefinitely.

### CSV exports

- **Exports are admin-only.** Reps see all data on screen but cannot click Export CSV — the button is hidden for the rep role. The exportCsv functions also defensively block non-admins server-side.
- Reports and Forecast CSV exports are **watermarked** with the exporter's name, rep ID, role, ISO timestamp, and filter description.
- A "Confidential — for the named exporter only. Do not redistribute." line is prepended to every export.
- **Every export is logged to `audit_log`** via `public.log_export()` (record count, filter, timestamp, who). Blocked rep attempts are also logged as `BLOCKED — rep attempted`.

---

## Lead routing (not yet implemented)

The schema supports it:
- Each rep has a `territory` text array — free-form tags (e.g., "Denver Metro", "Boulder", "Colorado").
- Incoming web leads should be matched to a rep by territory tag (or city/state on the lead).

Currently captured but not auto-routed — Phase 3 / 4 work.

---

## Things this CRM intentionally does NOT do

- **Store credit card numbers** — only last 4 + signature. PCI compliance lives at Shopify/Stripe when wired up.
- **Process payments directly** — the order's "payment authorized" flag is symbolic; real payment capture happens in Shopify Payments at integration time.
- **Send transactional emails directly** — Supabase Auth handles confirmation + reset emails. Invoice/tracking emails to customers aren't wired up yet (Phase 4: SendGrid or similar).
- **Calculate multi-state sales tax** — single Colorado rate today; Shopify Tax / Avalara handles this at integration.
- **Sync inventory with reality** — current `products.stock` is hardcoded. Phase 3 reads from Shopify.

---

## Cross-references

- **Setup / activation of AI assistant:** see `AI_SETUP.md`
- **Database schema:** `supabase/schema.sql`
- **Migrations applied in order:**
  1. `schema.sql` (initial)
  2. `fix-recursion.sql` (RLS recursion fix)
  3. `forecasts.sql` (prospects + forecasts + Appose Lip TX product)
  4. `tax-exempt.sql` (tax_exempt column + sync)
  5. `account-notes.sql` (dedicated notes table with 24h window)
  6. `rep-mgmt.sql` (disabled column + pending_invites + auto-rep-id-from-invite)
  7. `rep-contact.sql` (contact fields + auto rep ID counter)
  8. `audit-and-approval.sql` (audit log + uninvited-signup disabled gate)
