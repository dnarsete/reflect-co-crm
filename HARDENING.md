# Security Hardening — deployment steps

An audit found 14 issues in the CRM. All fixes are in this commit. Some take effect the moment GitHub Pages redeploys (auto in ~60s after push). Two — the database migration and the Edge Function redeploys — need manual steps in Supabase.

## What was found

| # | Severity | Issue | Fix location |
|---|---|---|---|
| 1 | Critical | Reps could self-promote to admin via `profiles.update` | SQL trigger |
| 2 | Critical | Client-computed order totals = commission fraud | SQL trigger |
| 3 | High | `counters` table world-writable | SQL policy drop |
| 4 | High | Every rep could read every rep's tax_id / address / commission | SQL policy + view |
| 5 | High | XSS via `payment.signature` img src | app.js + SQL trigger |
| 6 | High | Timing attack on `verify_admin_secret` | SQL: bcrypt + rate limit |
| 7 | Medium | Rep could spoof `rep_id` on account notes | SQL policy |
| 8 | Medium | XSS via `shopify_invoice_url` | app.js + SQL check |
| 9 | Medium | Supabase CDN loaded without version pin or SRI | index.html |
| 10 | Medium | No Content-Security-Policy | index.html |
| 11 | Medium | Password recovery used `window.prompt` | app.js modal |
| 12 | Medium | Weak password policy | app.js strength check |
| 13 | Low | CORS `*` on Edge Functions | 3 × index.ts allow-list |
| 14 | Low | HMAC compare had length short-circuit | shopify-webhook/index.ts |

Frontend fixes (5, 8, 9, 10, 11, 12) go live automatically after the git push. Backend fixes need the two manual steps below.

---

## Step 1 — Run the SQL migrations (~30 seconds)

Supabase Dashboard → **SQL Editor** → paste and Run in this order:

1. `supabase/security-hardening.sql` — all the fixes below (idempotent, safe to re-run)
2. `supabase/materials.sql` — creates the private "materials" storage bucket and RLS (needed if you want the Marketing Materials tab to work)
3. `supabase/trash-system.sql` — enables the two-tier product trash: 45 days in the visible bin → 45 more days in a hidden archive → permanent purge (supersedes the earlier products-trash.sql)

The file is idempotent — safe to run any number of times. It handles:
- Trigger blocking rep self-elevation
- Trigger recomputing order totals server-side from `products.price`
- Dropping the world-writable `counters` policy
- Restricting `profiles` reads to self+admin; new `reps_public()` RPC — reps get only their own row, admins get all
- Trigger + CHECK constraint validating `payment.signature` data URLs
- CHECK constraint restricting `shopify_invoice_url` to `*.myshopify.com` / `checkout.shopify.com`
- Hashing existing `admin_secrets` values with bcrypt, rate-limiting `verify_admin_secret`, adding `set_admin_secret()` for rotation
- Tightening `account_notes` insert/update policies to prevent `rep_id` spoofing

### After running

Rotate any existing admin override code so it's stored fresh as bcrypt:
```sql
select public.set_admin_secret('order_override', 'YourNewOverrideCode');
```

If you never set one, skip that.

---

## Step 2 — Redeploy the Edge Functions (~2 minutes)

Three functions were changed:
- `shopify-sync` — CORS allow-list
- `invite-rep` — CORS allow-list
- `ai-assistant` — CORS allow-list
- `shopify-webhook` — constant-time HMAC compare

For each: Supabase Dashboard → **Functions** → click the function → **Edit** → paste the new contents from `supabase/functions/<name>/index.ts` → **Deploy**.

(Or via CLI: `supabase functions deploy shopify-sync invite-rep ai-assistant shopify-webhook`.)

### Optional — allow additional origins

If you ever host the CRM under a different origin (say, a staging domain), set the `ALLOWED_ORIGINS` env var in Supabase Dashboard → **Project Settings → Edge Functions → Manage secrets**:

```
ALLOWED_ORIGINS=https://staging.example.com,https://another.example.com
```

Comma-separated. The production origin (`https://dnarsete.github.io`) plus localhost are already allowed by default; you don't need to add them.

---

## Step 3 — One-time Supabase Auth dashboard settings

These don't come from code — they're toggles in Supabase Dashboard.

1. **Password strength check.** Dashboard → **Authentication → Providers → Email → Password Requirements** → enable **Prevent use of leaked passwords** (checks Have-I-Been-Pwned). Minimum length: leave at 10, the client-side check is stricter.

2. **Session timeout.** Dashboard → **Authentication → Sessions** → set **JWT expiry** to 3600 (1 hour) and **Refresh Token Rotation** on. The CRM already has an absolute-timeout enforcer on top of that.

3. **MFA enforcement (when ready to require it).** Dashboard → **Authentication → Providers → Email** → **Enforce MFA for all users**. See `launch_checklist` — this is a planned launch item.

---

## Step 4 — Verify

Sign in as a rep (not admin). Open the browser console. Try each:

```js
// Should FAIL — RLS denies:
await sb.from('profiles').update({role:'admin'}).eq('id', (await sb.auth.getUser()).data.user.id)
// Expected: { error: null, data: [...] } — but re-select the row; role should still be 'rep'.
// (The trigger silently reverts privileged columns for non-admins.)

// Should FAIL — counters no longer writable:
await sb.from('counters').update({value: 0}).eq('key', 'order')
// Expected: RLS error / 0 rows updated.

// Should FAIL — order with tampered total gets recomputed:
await sb.from('orders').insert({rep_id: 'YOUR_REP_ID', items: [{sku:'RC-KIT-04', qty:1, price:0.01}], total: 999999})
// Expected: insert succeeds but re-select shows total = 140.00 (real product price), not 999999.

// Should FAIL — other reps' emails/cell/commission invisible:
await sb.from('profiles').select('email, cell, commission, tax_id')
// Expected: only your own row returned. Others' PII is hidden.
```

Then sign in as admin — the same queries return richer results (admin bypasses the restrictions).

---

## Ongoing hygiene

- **Do not run `SHOPIFY_MODE: 'live'` until Step 1 is done.** The order-total trigger is what defends the Shopify-linked commission math.
- **Rotate `admin_secrets` values via `set_admin_secret()` only** — inserting plaintext directly re-introduces the timing attack.
- **When updating Supabase JS** (e.g. to 2.46.x), also recompute the SRI hash. Command:
  ```bash
  curl -sL "https://unpkg.com/@supabase/supabase-js@X.Y.Z/dist/umd/supabase.js" | openssl dgst -sha384 -binary | openssl base64 -A
  ```
  Update both `src` and `integrity` in `index.html` in the same commit.
