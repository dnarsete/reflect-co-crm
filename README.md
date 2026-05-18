# The Reflect Co — Rep CRM

A mobile-first, self-contained customer-relationship & sales-rep portal for [thereflectco.com](https://thereflectco.com).
Built as a static HTML/CSS/JS app — no build step, no server, no dependencies. Drop it on any host (or open the file directly) and it runs.

Data persists in the browser via `localStorage`. The intent is for this UI to sit on top of **Shopify** (which remains the source of truth for orders, inventory, and payments) in production.

## Features

- **Mobile-first** layout with large tap targets and a bottom nav (works great as a PWA shell).
- **Roles**: Rep and Admin sign in the same way; views adjust automatically.
- **Accounts** — auto-generated `ACC-####` numbers, account-type dropdown (Dermatologist, Medical Spa, Boutique, Hotel, Retail Store, Salon, Other), billing + business addresses, rep assignment, sales-tax license (with state), opt in/out, call/visit notes log, timestamps.
- **Orders** — reps cannot manually discount; only via promo code. Default shipping ($30). Default tax (Colorado + Denver County, ~8.81%) auto-waived when a sales-tax license is on file. Order # is generated on finalize. Card payments require an e-signature on file. Methods: Visa / MC / Amex / Apple Pay / Venmo / PayPal / ACH. Invoice view with print-to-PDF.
- **Promotions** — code-based with four kinds: `percent`, `shipping` (free), `bonus` (extra product), `access` (seminars/trainings). Minimum-units gating for volume tiers.
- **Reports & KPIs** — date range, rep, account #, order #, account-type filters; by-type breakdown; commission computed per rep; **CSV export**; one-click "last month w/ commission" report.
- **Customer Service** — in-app rule-based assistant that looks up accounts, orders, promos, tax, and reorder-due. Footer fallback (1-800 / email / mailing address). Production should plug into the [Claude API](https://docs.anthropic.com) here.
- **Admin** — rep CRUD with free-form territory tags (e.g. "Denver Metro, Boulder"), account-type management, system settings (shipping/tax/discount alert/reorder window/low-stock threshold), full demo-data reset.
- **Alerts** — low-stock and reorder-due tiles on the dashboard; high-discount orders prompt before finalizing.

## Quick start

```bash
git clone https://github.com/<you>/reflect-co-crm.git
cd reflect-co-crm
open index.html        # macOS — or just double-click it
```

Or serve it locally (any static server works):

```bash
# Python 3
python3 -m http.server 8000
# Node
npx serve .
```

Then visit <http://localhost:8000>.

### Demo accounts

| Role  | Email                       | Password |
| ----- | --------------------------- | -------- |
| Admin | admin@thereflectco.com      | admin    |
| Rep   | rep@thereflectco.com        | rep      |

You can also tap **Use Rep demo** / **Use Admin demo** on the sign-in screen.
If sign-in misbehaves (stale localStorage), click **Reset local data** in the "Demo accounts" disclosure.

## Deploying

This is a static site — three files. Anywhere that serves static assets will work.

- **GitHub Pages**: push the repo, enable Pages from the `main` branch / root.
- **Netlify / Vercel / Cloudflare Pages**: drag-and-drop the folder, or connect the repo.
- **S3 / any CDN**: upload the three files.

## Project structure

```
reflect-co-crm/
├── index.html        # Markup + view templates
├── styles.css        # All styling (dark theme, mobile-first)
├── app.js            # SPA logic, localStorage persistence, seed data
├── README.md
├── LICENSE
└── .gitignore
```

## Where to plug in production systems

This repo is a UX/UX-logic prototype. Production wiring points:

- **Shopify Admin API** — source of truth for products, inventory, orders, fulfillments, customers. Replace the `db.products` / `db.orders` reads with API calls.
- **Shopify Payments / tokenized vault** — payment capture. The CRM intentionally does **not** store card details.
- **Shopify Tax or Avalara** — multi-jurisdiction sales tax. The current static tax rate is a placeholder.
- **Claude API** — replace the rule-based assistant in `cs.answer()` with a real LLM call. Use prompt caching to keep latency / cost down.
- **Auth** — replace the localStorage user list with SSO / Shopify customer accounts or a small auth backend.
- **Lead routing** — wire the rep `territory` ZIP list into your web-form intake to auto-assign new leads.

## Roadmap

- License-file upload (Shopify Files API)
- Geolocation check-in for visits
- Voice-to-text notes (Web Speech API)
- Real-time sync + offline queue
- Push notifications for reorder alerts
- Apple Pay / Pay Sheet integration
- Real AI assistant via Claude API

## License

MIT — see [LICENSE](LICENSE).
