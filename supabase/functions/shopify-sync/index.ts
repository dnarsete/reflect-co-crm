/* =====================================================================
   The Reflect Co — Shopify Sync Edge Function
   Secure server-side proxy between the CRM and the Shopify Admin API.
   The Shopify token never reaches the browser. Admin-only.

   POST body: { action: string, payload?: object }
   Actions:
     - test_connection      verify the token + store reachability
     - pull_products        fetch products + inventory -> upsert into products
     - push_account         create a Shopify customer from a CRM account
     - create_draft_order   create a Shopify draft order from a CRM order
     - get_order_status     fetch fulfillment status + tracking for an order
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SHOPIFY_STORE   = Deno.env.get("SHOPIFY_STORE_URL") ?? "";
const SHOPIFY_TOKEN   = Deno.env.get("SHOPIFY_ADMIN_TOKEN") ?? "";
const API_VERSION     = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-01";
const SUPABASE_URL    = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON   = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY     = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return json({ error: "Shopify not configured. Set SHOPIFY_STORE_URL and SHOPIFY_ADMIN_TOKEN secrets in Supabase." }, 500);
  }

  /* --- verify the caller is an authenticated admin --- */
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Authorization required" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
  const { data: profile } = await userClient
    .from("profiles").select("role, disabled").eq("id", userData.user.id).single();
  if (!profile || profile.role !== "admin" || profile.disabled) {
    return json({ error: "Admin access required" }, 403);
  }

  /* service-role client — bypasses RLS for sync writes */
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = body?.action;
  const payload = body?.payload || {};

  try {
    let result: any;
    switch (action) {
      case "test_connection":    result = await testConnection(); break;
      case "pull_products":      result = await pullProducts(db); break;
      case "push_account":       result = await pushAccount(db, payload); break;
      case "create_draft_order": result = await createDraftOrder(db, payload); break;
      case "get_order_status":   result = await getOrderStatus(db, payload); break;
      default: return json({ error: `Unknown action: ${action}` }, 400);
    }
    await logSync(db, action, "success", result, userData.user.id);
    return json({ ok: true, ...result });
  } catch (e: any) {
    const msg = e?.message || String(e);
    await logSync(db, action || "unknown", "error", { message: msg }, userData.user.id);
    return json({ error: msg }, 502);
  }
});

/* ------------------------- helpers ------------------------- */

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors });
}

function storeHost() {
  return SHOPIFY_STORE.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function shopifyUrl(path: string) {
  return `https://${storeHost()}/admin/api/${API_VERSION}/${path}`;
}

async function shopifyFetch(path: string, opts: RequestInit = {}): Promise<{ body: any; headers: Headers }> {
  const res = await fetch(shopifyUrl(path), {
    ...opts,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_TOKEN,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }
  if (!res.ok) {
    const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
    throw new Error(`Shopify API ${res.status}: ${detail.slice(0, 400)}`);
  }
  return { body: parsed, headers: res.headers };
}

/* Follow Shopify cursor pagination via the Link header */
function nextPageInfo(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const m = linkHeader.split(",").find((p) => p.includes('rel="next"'));
  if (!m) return null;
  const url = m.match(/<([^>]+)>/)?.[1];
  if (!url) return null;
  return new URL(url).searchParams.get("page_info");
}

async function logSync(db: any, action: string, status: string, detail: any, userId: string) {
  try {
    await db.from("shopify_sync_log").insert({ action, status, detail, user_id: userId });
  } catch (_) { /* logging must never break the response */ }
}

/* ------------------------- actions ------------------------- */

async function testConnection() {
  const { body } = await shopifyFetch("shop.json");
  return {
    shop: {
      name: body?.shop?.name,
      domain: body?.shop?.myshopify_domain,
      email: body?.shop?.email,
      currency: body?.shop?.currency,
      plan: body?.shop?.plan_name,
    },
    api_version: API_VERSION,
  };
}

async function pullProducts(db: any) {
  /* 1. Fetch all products (paginated) */
  const products: any[] = [];
  let pageInfo: string | null = null;
  let pages = 0;
  do {
    pages++;
    const path = pageInfo
      ? `products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `products.json?limit=250`;
    const { body, headers } = await shopifyFetch(path);
    products.push(...(body?.products || []));
    pageInfo = nextPageInfo(headers.get("Link"));
  } while (pageInfo && pages < 20);

  /* 2. Collect every variant + its inventory_item_id */
  const variants: any[] = [];
  for (const p of products) {
    for (const v of (p.variants || [])) {
      variants.push({
        shopify_product_id: String(p.id),
        shopify_variant_id: String(v.id),
        shopify_inventory_item_id: v.inventory_item_id ? String(v.inventory_item_id) : null,
        sku: (v.sku || "").trim(),
        name: p.title + (v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""),
        price: Number(v.price || 0),
        active: p.status === "active",
      });
    }
  }

  /* 3. Fetch inventory levels for all inventory_item_ids (batched, 50 per call) */
  const invByItem: Record<string, number> = {};
  const itemIds = variants.map((v) => v.shopify_inventory_item_id).filter(Boolean) as string[];
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50).join(",");
    const { body } = await shopifyFetch(`inventory_levels.json?inventory_item_ids=${batch}&limit=250`);
    for (const lvl of (body?.inventory_levels || [])) {
      const id = String(lvl.inventory_item_id);
      invByItem[id] = (invByItem[id] || 0) + Number(lvl.available || 0);
    }
  }

  /* 4. Upsert into the products table (keyed by SKU) */
  let upserted = 0, skippedNoSku = 0;
  const nowIso = new Date().toISOString();
  for (const v of variants) {
    if (!v.sku) { skippedNoSku++; continue; }
    const stock = v.shopify_inventory_item_id ? (invByItem[v.shopify_inventory_item_id] ?? 0) : 0;
    const { error } = await db.from("products").upsert({
      sku: v.sku,
      name: v.name,
      price: v.price,
      stock,
      active: v.active,
      shopify_product_id: v.shopify_product_id,
      shopify_variant_id: v.shopify_variant_id,
      shopify_inventory_item_id: v.shopify_inventory_item_id,
      synced_at: nowIso,
    }, { onConflict: "sku" });
    if (!error) upserted++;
  }

  /* 5. Update sync metadata */
  await db.from("settings").upsert({ key: "shopify_connected", value: true });
  await db.from("settings").upsert({ key: "shopify_store_url", value: storeHost() });
  await db.from("settings").upsert({ key: "shopify_last_product_sync", value: nowIso });
  await db.from("settings").upsert({ key: "shopify_product_count", value: upserted });

  return { products_found: products.length, variants_found: variants.length, upserted, skipped_no_sku: skippedNoSku, synced_at: nowIso };
}

async function pushAccount(db: any, payload: any) {
  const accountId = payload?.account_id;
  if (!accountId) throw new Error("payload.account_id required");
  const { data: acc, error } = await db.from("accounts").select("*").eq("id", accountId).single();
  if (error || !acc) throw new Error("Account not found");
  if (acc.shopify_customer_id) {
    return { already_linked: true, shopify_customer_id: acc.shopify_customer_id };
  }
  const nameParts = (acc.billing_name || acc.business_name || "").trim().split(/\s+/);
  const customer: any = {
    first_name: nameParts[0] || acc.business_name || "Account",
    last_name: nameParts.slice(1).join(" ") || "",
    email: acc.email || undefined,
    phone: acc.business_phone || acc.cell || undefined,
    note: `CRM account ${acc.account_number} · type ${acc.type || "—"} · rep ${acc.rep_id || "—"}`,
    tags: ["reflect-crm", acc.type || ""].filter(Boolean).join(", "),
    addresses: acc.business_address ? [{ address1: acc.business_address, default: true }] : undefined,
  };
  const { body } = await shopifyFetch("customers.json", {
    method: "POST",
    body: JSON.stringify({ customer }),
  });
  const shopifyId = body?.customer?.id ? String(body.customer.id) : null;
  if (shopifyId) {
    await db.from("accounts").update({ shopify_customer_id: shopifyId }).eq("id", accountId);
  }
  return { created: true, shopify_customer_id: shopifyId };
}

async function createDraftOrder(db: any, payload: any) {
  const orderId = payload?.order_id;
  if (!orderId) throw new Error("payload.order_id required");
  const { data: ord, error } = await db
    .from("orders").select("*, account:accounts(*)").eq("id", orderId).single();
  if (error || !ord) throw new Error("Order not found");
  if (ord.shopify_draft_order_id) {
    return { already_linked: true, shopify_draft_order_id: ord.shopify_draft_order_id };
  }

  /* Map CRM items to Shopify draft-order line items.
     If the product has a known shopify_variant_id, use it; else a custom line item. */
  const skus = (ord.items || []).map((i: any) => i.sku);
  const { data: prods } = await db.from("products").select("sku, shopify_variant_id").in("sku", skus);
  const variantBySku: Record<string, string> = {};
  (prods || []).forEach((p: any) => { if (p.shopify_variant_id) variantBySku[p.sku] = p.shopify_variant_id; });

  const line_items = (ord.items || []).map((i: any) => {
    if (variantBySku[i.sku]) {
      return { variant_id: Number(variantBySku[i.sku]), quantity: i.qty };
    }
    return { title: `${i.name} (${i.sku})`, price: String(i.price), quantity: i.qty };
  });

  const draft: any = {
    line_items,
    note: `Reflect CRM order · rep ${ord.rep_id || "—"} · ${ord.order_number || "draft"}`,
    tags: "reflect-crm",
    use_customer_default_address: true,
  };
  if (ord.account?.shopify_customer_id) draft.customer = { id: Number(ord.account.shopify_customer_id) };
  else if (ord.account?.email) draft.email = ord.account.email;
  if (ord.promo_code) draft.note += ` · promo ${ord.promo_code}`;
  if (Number(ord.shipping) > 0) {
    draft.shipping_line = { title: "Shipping", price: String(ord.shipping) };
  }
  if (ord.tax_exempt) draft.tax_exempt = true;

  const { body } = await shopifyFetch("draft_orders.json", {
    method: "POST",
    body: JSON.stringify({ draft_order: draft }),
  });
  const draftId = body?.draft_order?.id ? String(body.draft_order.id) : null;
  const invoiceUrl = body?.draft_order?.invoice_url || null;
  if (draftId) {
    await db.from("orders").update({
      shopify_draft_order_id: draftId,
      shopify_status: "draft",
      shopify_invoice_url: invoiceUrl,
    }).eq("id", orderId);
  }
  return { created: true, shopify_draft_order_id: draftId, invoice_url: invoiceUrl };
}

async function getOrderStatus(db: any, payload: any) {
  const orderId = payload?.order_id;
  if (!orderId) throw new Error("payload.order_id required");
  const { data: ord } = await db.from("orders").select("*").eq("id", orderId).single();
  if (!ord) throw new Error("Order not found");
  const shopifyId = ord.shopify_order_id || ord.shopify_draft_order_id;
  if (!shopifyId) return { linked: false, message: "Order not yet sent to Shopify." };

  /* If we only have a draft order id, check whether it completed into an order */
  const path = ord.shopify_order_id
    ? `orders/${ord.shopify_order_id}.json`
    : `draft_orders/${ord.shopify_draft_order_id}.json`;
  const { body } = await shopifyFetch(path);
  const o = body?.order || body?.draft_order || {};
  const tracking = (o.fulfillments || [])
    .flatMap((f: any) => f.tracking_numbers || [])
    .filter(Boolean);
  const update: any = {
    shopify_status: o.fulfillment_status || o.status || ord.shopify_status,
  };
  if (tracking.length) update.tracking = tracking.join(", ");
  await db.from("orders").update(update).eq("id", orderId);
  return {
    linked: true,
    financial_status: o.financial_status,
    fulfillment_status: o.fulfillment_status,
    status: o.status,
    tracking,
  };
}
