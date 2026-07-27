# Rep testing — safe way to onboard new reps to the CRM

This runbook covers two features built for onboarding reps to the CRM without risk of accidental real orders:

1. **Test mode** — a per-rep flag that blocks Shopify pushes so any orders they finalize stay inside the CRM
2. **Magic link login** — reps sign in with a one-click email link, no password to remember

Together these let you invite reps, have them explore the CRM freely, and know that nothing they do will accidentally send a real invoice.

---

## Test mode

### What it does

When a rep's profile has `test_mode = true`:
- A brown/gold banner appears across the top of the CRM: *"🧪 TEST MODE — orders you finalize will NOT push to Shopify. No invoices. No emails. No real transactions."*
- The **Finalize & invoice** button on the order modal is replaced with **🧪 Complete (test only)**
- The **Push to Shopify** button (on existing finalized orders) is hidden
- The confirmation dialog before finalizing spells out that nothing will hit Shopify
- Orders they finalize get an `is_test = true` flag in the database (useful for filtering in reports later)
- Everything else works normally: they can create accounts, save drafts, forecast, view reports, chat with the assistant

### What it doesn't do

- Doesn't hide the rep's activity from Admin (Admin can see everything the rep does — this is intentional)
- Doesn't prevent the rep from saving drafts, editing accounts, or using the rest of the CRM
- Doesn't tag test accounts (accounts they create aren't marked "test" — only the finalized orders are)

### One-time SQL setup

Paste in Supabase → SQL Editor → Run:

```sql
alter table public.profiles add column if not exists test_mode boolean default false;
alter table public.orders add column if not exists is_test boolean default false;
create index if not exists orders_is_test_idx on public.orders(is_test) where is_test = true;
```

Full file: [supabase/test-mode.sql](../supabase/test-mode.sql).

### How to enable for a rep

1. CRM → **Reps** tab (bottom nav) → click **Edit** on the rep you want to put in test mode
2. Scroll to the bottom → find the highlighted **🧪 Test mode** checkbox
3. Check it → **Save**
4. The rep signs out and back in (or refreshes) → banner appears + finalize button changes

### How to turn it off

Same place — uncheck the box → Save. On next sign-in / refresh, the rep is back to normal.

### Cleaning up test data after training

Optional. Test orders live alongside real orders. To hide them from reports:

```sql
-- List all test orders so you can review before deleting
select id, order_number, rep_id, total, placed_at, account_id
  from public.orders
  where is_test = true
  order by placed_at desc;

-- Delete them (irreversible!)
delete from public.orders where is_test = true;

-- Or just archive by marking them as cancelled (reversible)
update public.orders set status = 'cancelled' where is_test = true;
```

Test accounts (retailers the rep created for practice) are not automatically flagged. Delete manually via the CRM Accounts tab or via SQL.

---

## Magic link login

### What it does

Rep clicks a button on the sign-in screen → types their email → gets a link in their inbox → clicks the link → automatically signed in. No password to remember or reset.

Works for existing users only (by design — admin should explicitly add reps before they can sign in).

### One-time Supabase setup

Supabase's Email auth provider is enabled by default. If you disabled it at some point, re-enable:

1. Supabase Dashboard → **Authentication** → **Providers**
2. Find **Email** in the list → click into it
3. Ensure **Enable Email provider** is on
4. Ensure **Enable Magic Link** is on (it's typically on by default)
5. Under **Email Templates** (left sidebar) → **Magic Link** — you can customize the email if you want. The default template works fine.

Also verify:

- Supabase → **Authentication** → **URL Configuration** → **Site URL** = `https://dnarsete.github.io/reflect-co-crm/`
- **Redirect URLs** allow list includes `https://dnarsete.github.io/reflect-co-crm/`

If either is wrong, the magic link will show "invalid redirect" when clicked.

### How reps use it

1. Go to `https://dnarsete.github.io/reflect-co-crm/`
2. Type email in the Email field (do NOT type a password)
3. Click **✉️ Email me a sign-in link**
4. Check inbox (or spam folder — first-time senders sometimes land there)
5. Click the link in the email → auto-signed-in on the CRM

Link expires 1 hour after sending.

### If a rep says the link doesn't arrive

Check in order:
- Spam folder
- Correct email typed (Supabase silently succeeds even for typos to avoid leaking whether an email exists)
- The rep has actually signed up (magic link is `shouldCreateUser: false` — link only works for existing accounts). If they haven't, admin needs to invite them via **Add rep** first, then rep signs up with password once, THEN can use magic links.
- Supabase email delivery working — check Supabase → Authentication → Rate Limits and Logs

---

## Recommended onboarding flow for a test rep

1. Admin: **Reps** tab → **+ Add rep** → fill in their name, email, cell → Save (invites them, sets `test_mode = false` by default)
2. Rep: goes to CRM → clicks **Create account** → signs up with the same email + a password
3. Admin: back on Reps tab → **Edit** the new rep → check the **🧪 Test mode** box → Save
4. Rep: signs out and back in → sees the test-mode banner
5. Rep can now freely create test accounts + finalize orders → nothing pushes to Shopify
6. Once trained: Admin unchecks test mode → rep is now a real live rep

Optionally the rep can bypass the password step entirely for future sign-ins by using **✉️ Email me a sign-in link** on the sign-in screen.
