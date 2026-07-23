/* =====================================================================
   The Reflect Co — Shopify Sync Edge Function
   Secure server-side proxy between the CRM and the Shopify Admin API.
   The Shopify credentials never reach the browser. Admin-only.

   Auth model (as of 2026 Dev Dashboard apps):
     Client Credentials Grant (CCG) — SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
     are exchanged for a 24-hour access token at
     https://{shop}/admin/oauth/access_token. The token is cached in the
     shopify_tokens table until 60s before expiry and re-fetched on demand.
     Backward-compat: if SHOPIFY_ADMIN_TOKEN is set (legacy static token),
     it's used directly and CCG is skipped.

   POST body: { action: string, payload?: object }
   Actions:
     - test_connection      verify credentials + store reachability
     - pull_products        fetch products + inventory -> upsert into products
     - push_account         create a Shopify customer from a CRM account
     - create_draft_order   create a Shopify draft order from a CRM order
     - get_order_status     fetch fulfillment status + tracking for an order
     - register_webhooks    register all four topics via GraphQL (idempotent)
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/* CCG credentials (preferred, Dev Dashboard 2026+) */
const SHOPIFY_CLIENT_ID     = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const SHOPIFY_SHOP          = Deno.env.get("SHOPIFY_SHOP") ?? Deno.env.get("SHOPIFY_STORE_URL") ?? "";

/* Legacy static token (backward compat) */
const LEGACY_TOKEN          = Deno.env.get("SHOPIFY_ADMIN_TOKEN") ?? "";

const API_VERSION           = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-07";
const SUPABASE_URL          = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON         = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY           = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/* CORS allow-list */
const DEFAULT_ORIGINS = [
  "https://dnarsete.github.io",
  "http://localhost:5173",
  "http://localhost:3000",
];
const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map(s => s.trim()).filter(Boolean).concat(DEFAULT_ORIGINS)
);

function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("Origin") || "";
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
}

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: cors });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  if (!SHOPIFY_SHOP) {
    return json({ error: "Shopify not configured. Set SHOPIFY_SHOP (e.g. the-reflect-co.myshopify.com) as a Supabase secret." }, 500);
  }
  const usingCCG = !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);
  if (!usingCCG && !LEGACY_TOKEN) {
    return json({ error: "Shopify not configured. Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or the legacy SHOPIFY_ADMIN_TOKEN." }, 500);
  }

  /* --- verify caller is an authenticated admin --- */
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

  /* service-role client — bypasses RLS for sync writes and token cache */
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const action = body?.action;
  const payload = body?.payload || {};

  try {
    let result: any;
    switch (action) {
      case "test_connection":    result = await testConnection(db); break;
      case "pull_products":      result = await pullProducts(db); break;
      case "push_account":       result = await pushAccount(db, payload); break;
      case "create_draft_order": result = await createDraftOrder(db, payload); break;
      case "get_order_status":   result = await getOrderStatus(db, payload); break;
      case "register_webhooks":  result = await registerWebhooks(db); break;
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

/* ------------------------- Auth: CCG token acquisition ------------------------- */

function storeHost() {
  return SHOPIFY_SHOP.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/* Fetches a CCG access token, cached in shopify_tokens until 60s before expiry.
   Reference: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant */
async function getCCGToken(db: any): Promise<string> {
  const cacheKey = "access_token";
  /* 1. Try cache */
  const { data: cached } = await db.from("shopify_tokens").select("*").eq("key", cacheKey).maybeSingle();
  if (cached && new Date(cached.expires_at).getTime() > Date.now() + 60_000) {
    return cached.access_token;
  }
  /* 2. Exchange credentials for a fresh token */
  const params = new URLSearchParams();
  params.set("client_id", SHOPIFY_CLIENT_ID);
  params.set("client_secret", SHOPIFY_CLIENT_SECRET);
  params.set("grant_type", "client_credentials");

  const res = await fetch(`https://${storeHost()}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`CCG token exchange failed (${res.status}): ${text.slice(0, 400)}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`CCG token response not JSON: ${text.slice(0, 200)}`); }
  const token = parsed?.access_token;
  if (!token) throw new Error(`CCG response missing access_token: ${text.slice(0, 200)}`);
  const expiresIn = Number(parsed?.expires_in || 86399);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  /* 3. Persist to cache */
  await db.from("shopify_tokens").upsert({
    key: cacheKey,
    access_token: token,
    scope: parsed?.scope || null,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }, { onConflict: "key" });

  return token;
}

/* Returns the active token — either the legacy static one, or a fresh CCG one. */
async function getShopifyToken(db: any): Promise<string> {
  if (LEGACY_TOKEN) return LEGACY_TOKEN;
  return await getCCGToken(db);
}

/* ------------------------- HTTP helpers ------------------------- */

function shopifyUrl(path: string) {
  return `https://${storeHost()}/admin/api/${API_VERSION}/${path}`;
}

async function shopifyFetch(db: any, path: string, opts: RequestInit = {}): Promise<{ body: any; headers: Headers }> {
  const token = await getShopifyToken(db);
  const res = await fetch(shopifyUrl(path), {
    ...opts,
    headers: {
      "X-Shopify-Access-Token": token,
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

async function shopifyGraphQL(db: any, query: string, variables?: any): Promise<any> {
  const token = await getShopifyToken(db);
  const res = await fetch(`https://${storeHost()}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Shopify GraphQL response not JSON: ${text.slice(0, 400)}`); }
  if (!res.ok) throw new Error(`Shopify GraphQL ${res.status}: ${text.slice(0, 400)}`);
  if (parsed.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(parsed.errors).slice(0, 400)}`);
  return parsed.data;
}

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

async function testConnection(db: any) {
  const { body } = await shopifyFetch(db, "shop.json");
  return {
    shop: {
      name: body?.shop?.name,
      domain: body?.shop?.myshopify_domain,
      email: body?.shop?.email,
      currency: body?.shop?.currency,
      plan: body?.shop?.plan_name,
    },
    api_version: API_VERSION,
    auth_mode: LEGACY_TOKEN ? "legacy_token" : "ccg",
  };
}

async function pullProducts(db: any) {
  const products: any[] = [];
  let pageInfo: string | null = null;
  let pages = 0;
  do {
    pages++;
    const path = pageInfo
      ? `products.json?limit=250&page_info=${encodeURIComponent(pageInfo)}`
      : `products.json?limit=250`;
    const { body, headers } = await shopifyFetch(db, path);
    products.push(...(body?.products || []));
    pageInfo = nextPageInfo(headers.get("Link"));
  } while (pageInfo && pages < 20);

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

  const invByItem: Record<string, number> = {};
  const itemIds = variants.map((v) => v.shopify_inventory_item_id).filter(Boolean) as string[];
  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50).join(",");
    const { body } = await shopifyFetch(db, `inventory_levels.json?inventory_item_ids=${batch}&limit=250`);
    for (const lvl of (body?.inventory_levels || [])) {
      const id = String(lvl.inventory_item_id);
      invByItem[id] = (invByItem[id] || 0) + Number(lvl.available || 0);
    }
  }

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
  const { body } = await shopifyFetch(db, "customers.json", {
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

  const { body } = await shopifyFetch(db, "draft_orders.json", {
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

  const path = ord.shopify_order_id
    ? `orders/${ord.shopify_order_id}.json`
    : `draft_orders/${ord.shopify_draft_order_id}.json`;
  const { body } = await shopifyFetch(db, path);
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

/* Register the four webhooks we care about via the GraphQL Admin API.
   Idempotent: existing subscriptions are detected and reported as "existing".
   Reference: https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate
              https://shopify.dev/docs/api/admin-graphql/latest/enums/webhooksubscriptiontopic */
async function registerWebhooks(db: any) {
  const callbackUrl = `${SUPABASE_URL}/functions/v1/shopify-webhook`;
  /* Verified enum values from shopify.dev */
  const topics = [
    "ORDERS_PAID",
    "ORDERS_FULFILLED",
    "ORDERS_UPDATED",
    "PRODUCTS_UPDATE",
    "INVENTORY_LEVELS_UPDATE",
  ];

  /* 1. Read existing subscriptions for our callback URL */
  const existingQuery = `{
    webhookSubscriptions(first: 100) {
      edges { node { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } } }
    }
  }`;
  const existingData = await shopifyGraphQL(db, existingQuery);
  const existing = new Set<string>();
  for (const edge of (existingData?.webhookSubscriptions?.edges || [])) {
    const t = edge?.node?.topic;
    const url = edge?.node?.endpoint?.callbackUrl;
    if (t && url === callbackUrl) existing.add(t);
  }

  /* 2. Create the ones that aren't already registered */
  const mutation = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }`;
  const results: any[] = [];
  for (const topic of topics) {
    if (existing.has(topic)) {
      results.push({ topic, status: "existing" });
      continue;
    }
    const r = await shopifyGraphQL(db, mutation, {
      topic,
      sub: { callbackUrl, format: "JSON" },
    });
    const created = r?.webhookSubscriptionCreate?.webhookSubscription;
    const errors  = r?.webhookSubscriptionCreate?.userErrors || [];
    if (errors.length) {
      results.push({ topic, status: "error", errors });
    } else {
      results.push({ topic, status: "created", id: created?.id });
    }
  }
  return { callback_url: callbackUrl, results };
}
