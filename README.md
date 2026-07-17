# The Reflect Co — Rep CRM

Mobile-first sales-rep CRM for [thereflectco.com](https://thereflectco.com). Built with vanilla HTML/CSS/JS + Supabase (Postgres + Auth) + Supabase Edge Functions. No build step, no bundler. Hosted on GitHub Pages.

Live: **https://dnarsete.github.io/reflect-co-crm/**

---

## Stack

| Layer | Service | Purpose |
|---|---|---|
| Frontend hosting | GitHub Pages | Serves `index.html`, `styles.css`, `app.js`, `config.js` |
| Database + Auth | Supabase (Postgres) | Real shared data, Row-Level Security, JWT sessions |
| Serverless functions | Supabase Edge Functions (Deno) | Shopify sync, AI assistant, invite emails |
| Commerce backend | Shopify (Phase 3) | Live products, inventory, payments, tax, fulfillment |
| AI | Anthropic Claude API (dormant until enabled) | Real assistant answering questions from your data |

## Features

- **Real auth** (Supabase). Email + password, MFA (TOTP + Passkey), password reset via email, 12-hour absolute session + 30-min idle timeout.
- **Roles**: admin sees everything; reps see only their own accounts / orders / forecasts / prospects (enforced by Row-Level Security at the database).
- **Accounts** — auto-generated `ACC-####` numbers, account-type dropdown, billing + business addresses, rep assignment, tax-exempt toggle with sales-tax license, 24-hour note edit window (DB-enforced).
- **Orders** — reps cannot manually discount; only via promo code. Default shipping ($30). Default tax (Colorado + Denver County, ~8.81%). Order # generated on finalize. Card payments require an in-app signature (canvas pad). Watermarked invoice.
- **Prospects → Accounts** — lead capture and one-click conversion to a real customer account.
- **Promotions** — code-based with four kinds: percent off, free shipping, bonus product, access perks. Volume gates via `min_qty`.
- **Forecasts** — reps log expected sales by month linked to accounts or prospects. Admin sees a team rollup (revenue, weighted pipeline, cases needed).
- **Reports & KPIs** — time-preset filters (Today / This Week / This Month / This Quarter / YTD / Last Quarter, plus admin extras). Revenue trend by day/week/month. By-rep breakdown. Leaderboard (🥇🥈🥉) across revenue, orders, avg deal, close rate. CSV export (admin only, watermarked and audit-logged).
- **Rep management** (👥 Reps tab, admin) — full CRUD on rep profiles with contact info, commission %, territory, disable/enable, password reset. Pending invites with pre-set data applied on signup.
- **Messages** — admin can broadcast announcements, promos, todos, or 1-on-1 messages that appear in the rep's dashboard.
- **Audit log** — every insert / update / delete on all key tables, admin-only readable.
- **Approval gate** — uninvited signups land disabled; invited signups land active with pre-set rep ID, role, commission, territory.

## Project layout

```
reflect-co-crm/
├── index.html                              # Markup + view templates
├── styles.css                              # Dark theme, mobile-first
├── app.js                                  # SPA logic; all Supabase queries
├── config.js                               # Supabase URL, publishable key, feature flags
├── README.md
├── LICENSE
├── BUSINESS_RULES.md                       # Rules encoded in DB / code / config
├── AI_SETUP.md                             # Activation guide for the AI assistant
├── SHOPIFY_SETUP.md                        # Activation guide for Shopify integration
├── docs/
│   ├── BUSINESS_RULES.docx                 # Downloadable Word version
│   └── BUSINESS_RULES.html                 # Print-friendly HTML
└── supabase/
    ├── schema.sql                          # Base tables + RLS + triggers
    ├── *.sql                               # Sequential migrations (run in order)
    └── functions/
        ├── ai-assistant/                   # Claude tool-calling Edge Function
        ├── shopify-sync/                   # Shopify admin API proxy
        ├── shopify-webhook/                # Shopify webhook receiver
        └── invite-rep/                     # Auto-invite emails for new reps
```

## Migration order

Apply `supabase/*.sql` in this order (all idempotent):

1. `schema.sql`
2. `fix-recursion.sql`
3. `forecasts.sql`
4. `tax-exempt.sql`
5. `account-notes.sql`
6. `rep-mgmt.sql`
7. `rep-contact.sql`
8. `audit-and-approval.sql`
9. `profile-fields.sql`
10. `email-sync.sql`
11. `messages.sql`
12. `export-logging.sql`
13. `shopify-prep.sql`
14. `live-prep.sql`

## Feature flags (config.js)

| Flag | Values | Effect |
|---|---|---|
| `AI_MODE` | `'off'` / `'live'` | Help tab uses the AI Edge Function (needs Anthropic API key) |
| `SHOPIFY_MODE` | `'off'` / `'live'` | Admin can sync products from Shopify (needs Shopify Custom App token) |
| `INVITE_EMAILS` | `'off'` / `'live'` | Admin adding a rep triggers an official invite email (needs invite-rep Edge Function deployed) |

## Business rules

See [BUSINESS_RULES.md](BUSINESS_RULES.md) for the full list of what the CRM enforces and where each rule lives (database / app code / configuration).

## Deployment

Any GitHub push to `main` auto-deploys via GitHub Pages (~60 seconds). Supabase Edge Functions deploy separately via the Supabase Dashboard (paste the TypeScript from `supabase/functions/<name>/index.ts`) or via the Supabase CLI.

## License

MIT — see [LICENSE](LICENSE).
