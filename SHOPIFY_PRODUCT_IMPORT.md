# Shopify product import — Appose Lip TX

Single-product wholesale import CSV, sized for one case of 24 at $600.

## File

`appose-lip-tx-shopify-import.csv` — Shopify's standard product import format.

## Import path

1. Shopify admin → **Products** → **Import** (top-right)
2. Drag `appose-lip-tx-shopify-import.csv` onto the drop zone
3. Preview shows 1 product, 1 variant — click **Import products**
4. Wait ~15 seconds

## What gets created

| Field | Value |
|---|---|
| Title | Appose Lip TX — Case of 24 |
| Handle | `appose-lip-tx-case-24` |
| Vendor | Appose |
| SKU | `APPOSE-LIPTX-C24` |
| Wholesale price | $600.00 |
| Weight | 168g (placeholder — adjust to real case weight) |
| Inventory tracking | Shopify |
| Starting stock | 0 (set real quantity in admin after import) |
| Status | Active |
| Tax | Taxable |
| Shipping | Required |

## After import

1. **Product image** — the CSV has no image column filled. Upload the case pack photo in the product editor.
2. **Real weight** — replace the 168g placeholder with the actual shipping weight so shipping rates calculate correctly.
3. **Inventory** — enter the real on-hand case count.
4. **Sync to CRM** — once the Shopify integration is live (see `SHOPIFY_SETUP.md`), Admin tab → Shopify integration → **Sync products now** pulls this product into the CRM's product catalog and it becomes selectable on new orders.

## Adding more products later

Same CSV format. Duplicate the row, change:
- `Handle` (unique, kebab-case)
- `Title`
- `Variant SKU`
- `Variant Price`
- `Body (HTML)`
- image alt text / SEO fields

Multiple variants of the same product? Same Handle, additional rows with different `Option1 Value` (e.g., single unit / case of 12 / case of 24).
