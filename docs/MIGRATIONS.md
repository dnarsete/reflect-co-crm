# Migration rules — how to change the database without breaking the CRM

The July 22, 2026 sign-in outage happened because a code change referenced a Postgres column (`products.archived_at`) that hadn't been added to the database yet. Every subsequent boot threw *"column products.archived_at does not exist"* and the app never got past the sign-in gate.

This document exists so that class of failure never happens again. Every claim below is a rule the mature CRMs (Salesforce, HubSpot, Zoho, Dynamics) follow religiously. We follow them too.

---

## The five rules

### Rule 1 — Migrations run BEFORE the code that references them

Sequence for any change involving a new column, table, index, RPC, or trigger:

1. Write the SQL migration → save under `supabase/`.
2. **Run it on production Supabase** (or staging first, then prod — see [STAGING.md](STAGING.md)).
3. Verify the change lands (query the table, confirm the column exists).
4. **Only then** push the code that references the new schema.

Reversed order = outage. If step 2 is skipped or forgotten, the code deploy on step 4 breaks boot for every user.

### Rule 2 — Migrations are additive-only within a release

You may:
- ✅ Add a new column (`alter table X add column if not exists Y ...`)
- ✅ Add a new table (`create table if not exists ...`)
- ✅ Add a new index, RLS policy, function, trigger
- ✅ Add a `default` on a new column so existing rows populate

You may NOT (in the same push):
- ❌ Drop a column that any live code still reads
- ❌ Rename a column (rename = drop + add; break any live code)
- ❌ Change a column type in a way that requires a table rewrite (`alter column type`) without a graceful two-step
- ❌ Add a `not null` constraint to an existing column without first backfilling values

If a column truly needs to go away, follow Rule 3.

### Rule 3 — Deprecations take two releases

To remove or rename a column:

**Release 1: introduce the new, keep the old.**
- Add the new column (or new name).
- Backfill it: `update X set new_col = old_col where new_col is null`.
- Update the app to WRITE to both old and new (dual-write).
- Update the app to READ from the new only.
- Ship it. Both columns coexist for at least one release.

**Release 2: drop the old.**
- Once you're confident nothing reads the old column anymore, drop it in a migration.
- Update the app to stop writing to it.

This is how Salesforce ships API version changes for a decade without breaking customer integrations.

### Rule 4 — Every risky query has a fallback

Whenever the app queries a column that a migration is supposed to add, wrap the query in a try/fallback so a missing column doesn't kill boot. Existing pattern in [app.js](../app.js:283):

```javascript
async loadAll(){
  const productsQ = async () => {
    let r = await sb.from('products')
      .select('*')
      .is('deleted_at', null)
      .is('archived_at', null)
      .order('name');
    if(r.error && /archived_at/i.test(r.error.message||'')){
      r = await sb.from('products').select('*').is('deleted_at', null).order('name');
    }
    if(r.error && /deleted_at/i.test(r.error.message||'')){
      r = await sb.from('products').select('*').order('name');
    }
    return r;
  };
  ...
}
```

Rule of thumb: if a query references a column that a migration added in the last three commits, and boot depends on the query, it must have a fallback.

### Rule 5 — Every migration is idempotent

Every SQL file under `supabase/` must be safe to re-run any number of times without error.

Patterns to use:
- `create table if not exists ...`
- `alter table X add column if not exists Y ...`
- `create index if not exists ...`
- `create or replace function ...`
- `do $$ begin create policy ... exception when duplicate_object then null; end $$` for RLS policies
- `insert into settings ... on conflict (key) do nothing` for seeds

Never:
- `alter table X drop column Y` without an `if exists`
- `create policy ...` without a duplicate handler
- `insert into ...` without `on conflict do nothing`

Idempotency lets us re-run migrations on staging or production or after a Supabase restore without worrying about "did I already run this?"

---

## Migration file template

Save new migrations as `supabase/YYYYMMDD-description.sql` (date-prefixed so ordering is obvious). Copy this template:

```sql
-- =====================================================================
-- <one-line summary of what this migration does>
--
-- Why: <one-paragraph reason — link to the issue/context if there is one>
--
-- Backward compatibility: <note if anything in the app depends on this
-- being run first, or if a fallback is in place>
--
-- Idempotent — safe to re-run.
-- =====================================================================

-- <schema changes here, using the additive rules above>
```

---

## The audit — current state of the codebase (July 2026)

Ran a sweep of `app.js` for column references and cross-checked against migration files. Every reference is safe:

| Column | Referenced by | Guarded? |
|---|---|---|
| `deleted_at` (products) | `ref.loadAll()`, `productsAdmin.render()`, `productsAdmin.renderTrash()` | ✅ Fallback in place ([app.js:289](../app.js:289)) |
| `archived_at` (products) | `ref.loadAll()`, `productsAdmin.render()`, `productsAdmin.renderTrash()` | ✅ Fallback in place ([app.js:290](../app.js:290)) |
| `tax_exempt` (accounts, orders) | Many places | ✅ Column has been in schema for months |
| `shopify_customer_id` (accounts) | `shopify-sync` Edge Function | ✅ Added in `shopify-prep.sql` before code referenced it |
| `shopify_draft_order_id` (orders) | `orders.render()`, Edge Function | ✅ Same |
| `shopify_order_id`, `shopify_status`, `shopify_invoice_url` (orders) | Same | ✅ Same |
| `shopify_variant_id`, `shopify_product_id`, `shopify_inventory_item_id` (products) | Edge Function | ✅ Same |

No new risky refs at time of writing. If you're about to push code that queries a column not in this table, either:
1. Run the migration first, OR
2. Add a fallback matching the pattern in Rule 4, OR
3. Both (belt + suspenders).

---

## Checklist before every push

Copy into the commit message or a PR:

```
[ ] Schema changes (if any) landed in SUPABASE before this push
[ ] Migration file is idempotent
[ ] Migration is additive-only (no drops/renames mid-release)
[ ] Every new column reference has a fallback for the transition period
[ ] Tested on staging with a hard-refresh (?env=staging)
[ ] Sign-in still works after the change
```

If any box can't be ticked, don't push.
