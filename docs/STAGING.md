# Staging environment — setup & workflow

Reflect CRM runs in two environments:

- **Production** — the live CRM your reps use. Real accounts, real orders. Default URL: `https://dnarsete.github.io/reflect-co-crm/`.
- **Staging** — a mirror where risky changes get tested before they touch production. Access with `?env=staging`.

Staging protects against the class of breakage where a schema change and a code change ship separately and blow up on production (the July 2026 sign-in outage). Every migration and every risky feature runs in staging first, gets verified, then is promoted.

---

## One-time setup

Do this once. Takes ~15 minutes. Everything happens in Supabase.

### 1. Create the staging Supabase project

1. Go to https://supabase.com/dashboard
2. Top-right → **New project**
3. Organization: **The Reflect Co**
4. Name: `reflect-crm-staging`
5. Database password: any strong password (save in your password manager)
6. Region: same as production (probably `us-east-1`)
7. Plan: **Free tier is fine** for staging — no traffic, low storage.
8. Click **Create new project** and wait ~2 minutes for provisioning.

### 2. Copy the URL and publishable key into config.js

Once the project is ready:

1. In the new staging project → **Settings → API**
2. Copy the **Project URL** — looks like `https://xxxxxxxxxx.supabase.co`
3. Copy the **publishable key** — starts with `sb_publishable_...`
4. In this repo, open [config.js](../config.js) — find the `STAGING_CONFIG` block
5. Paste the URL into `SUPABASE_URL`
6. Paste the key into `SUPABASE_KEY`
7. Commit + push

After push, `?env=staging` will attach to your new staging DB.

### 3. Run every migration on staging

Staging starts empty. To match production's schema, run every `.sql` file in [supabase/](../supabase/) in order, in the staging project's SQL Editor. There's no shortcut here — copy each file, paste into a New Query in Supabase SQL Editor, Run, next.

Order:
1. `schema.sql`
2. `commission-default.sql`
3. `profile-fields.sql`
4. `rep-contact.sql`
5. `rep-mgmt.sql`
6. `fix-rep-invite.sql`
7. `fix-recursion.sql`
8. `email-sync.sql`
9. `account-notes.sql`
10. `forecasts.sql`
11. `messages.sql`
12. `tax-exempt.sql`
13. `order-gate.sql`
14. `audit-and-approval.sql`
15. `audit-trigger-fix.sql`
16. `export-logging.sql`
17. `live-prep.sql`
18. `security-hardening.sql`
19. `products-trash.sql`
20. `trash-system.sql`
21. `materials.sql`
22. `shopify-prep.sql`
23. `shopify-tokens.sql`

If any file errors, note the error and stop — flag it and we'll fix.

### 4. (Optional) Create a staging admin user

Sign in to the staging CRM (`?env=staging`) with your normal Google / email and create an account. Then in the staging Supabase SQL Editor:

```sql
update public.profiles
set role = 'admin', rep_id = 'ADMIN-1'
where email = 'dnarsete@gmail.com';
```

Now you're admin on staging.

### 5. (Optional) Seed some test data

Add a couple of fake accounts + orders in the staging CRM so there's data to test against. Never use real customer names or emails — this is a sandbox.

---

## Everyday workflow

### For a normal code change (no schema change)

1. Push to `main` as usual.
2. Load `?env=staging` and sanity-check the change against staging data.
3. Load production URL, verify it still works.

Simple changes rarely need staging — but for anything touching auth, orders, Shopify, or Edge Functions, always staging first.

### For a schema change (new column, new table, new RPC)

The high-risk change type. Follow this exact order:

1. Write the SQL migration file → save under `supabase/`.
2. **Run the SQL in STAGING Supabase first.** Confirm no error.
3. Write the code change (app.js, Edge Function, etc.) that references the new column/table/RPC.
4. Push to `main` → GitHub Pages deploys.
5. Load `?env=staging` → hard-refresh → test the new feature end-to-end.
6. Also test sign-in and any other critical path — schema changes can break things unrelated to the feature.
7. Only after staging verification: run the same SQL in **PRODUCTION Supabase**.
8. Load the production URL, hard-refresh, verify.

If step 6 fails, roll back on staging (drop the column, revert the code) and diagnose. Production is still safe.

### For an Edge Function change

Edge Functions are per-project — deploying to production Supabase doesn't touch staging and vice versa. To test an Edge Function in staging:

1. Deploy the new/updated Edge Function to the **staging** Supabase project via Dashboard → Edge Functions → Deploy.
2. Set any needed secrets on staging (`SHOPIFY_CLIENT_ID`, etc.). Staging can share secrets with prod or use test-mode credentials.
3. Load `?env=staging` and exercise the feature.
4. Deploy the same function to production.

### For a Shopify integration test

You have two options:
- Keep `SHOPIFY_MODE: 'off'` in staging config — the CRM shows Shopify as inactive, no calls made.
- Create a Shopify development store (free from Shopify Partners) and point staging at that. Never point staging at your production Shopify store — you'd create real draft orders.

---

## What CANNOT be staged this way

Because both environments deploy from the same `main` branch, they share the same frontend code. If you push a JavaScript bug, it hits production regardless. Staging protects **backend/schema/integration** changes, not frontend logic.

If you ever need to stage frontend changes too, upgrade to git-branch-based deploys (open a PR, deploy the PR to a preview URL). That's more complex — not needed for now.

---

## Toggling back to production

- Click the red **STAGING** banner at the top of the page — it removes the query param and localStorage entry and reloads on production.
- Or manually: strip `?env=staging` from the URL.

## Emergency: pretend staging is prod

Never do this. But if something's genuinely wrong with your production Supabase project and you need to keep the CRM alive while you fix it, you can temporarily swap `PROD_CONFIG` values with `STAGING_CONFIG` values in config.js, push, and reps hit staging until prod recovers. Then swap back. **This is a break-glass move** — use only in an outage, and remember to swap back within hours.
