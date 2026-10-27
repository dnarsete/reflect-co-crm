/* =====================================================================
   The Reflect Co — Ship Paid Order Edge Function

   Called by Shopify Flow when an order moves to "paid". Buys the
   cheapest USPS label from Shippo (no signature required), optionally
   creates a Shopify Fulfillment with the tracking number (so Shopify
   emails the customer the shipping notification automatically), and
   returns a summary that Flow emails to bj + dan.

   Auth:
     Flow sends a shared secret in the `x-flow-secret` header. Set
     FLOW_SHARED_SECRET in Supabase secrets. Keep it long and random.

   Dry-run mode (recommended for the first few orders):
     If FLOW_DRY_RUN=true (default), the function fetches the rate and
     returns the cheapest USPS option but does NOT buy a label or
     create a fulfillment. Flip to FLOW_DRY_RUN=false when ready to
     buy real postage.

   Request body (from Flow HTTP action):
     { "order_id": "<Shopify order GID or numeric id>" }

   Response (to Flow — used in the follow-up email action):
     {
       ok: true,
       dry_run: true/false,
       order_name: "#1042",
       service: "USPS Ground Advantage",
       cost: "6.42 USD",
       estimated_days: 3,
       ship_to_city: "Dallas, TX",
       label_url: "https://shippo-delivery.s3.amazonaws.com/....pdf",   // null in dry-run
       tracking_number: "9400111...",                                   // null in dry-run
       tracking_url: "https://tools.usps.com/go/TrackConfirmAction?...",// null in dry-run
       shopify_fulfillment_id: "..."                                    // null in dry-run or if fulfillment-create failed
     }
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/* Shippo */
const SHIPPO_API_KEY = Deno.env.get("SHIPPO_API_KEY") ?? "";
const SHIPPO_API     = "https://api.goshippo.com";

/* Shopify — reuses the same CCG app the shopify-sync function uses */
const SHOPIFY_CLIENT_ID     = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
const SHOPIFY_CLIENT_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
const SHOPIFY_SHOP          = Deno.env.get("SHOPIFY_SHOP") ?? "";
const LEGACY_TOKEN          = Deno.env.get("SHOPIFY_ADMIN_TOKEN") ?? "";
const API_VERSION           = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-07";

/* Supabase (service role, for the token cache) */
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

/* Flow auth + dry-run toggle */
const FLOW_SHARED_SECRET = Deno.env.get("FLOW_SHARED_SECRET") ?? "";
const DRY_RUN = (Deno.env.get("FLOW_DRY_RUN") ?? "true").toLowerCase() !== "false";

/* Ship-from — reads from Supabase secrets so the canonical business
   address can be corrected without a code deploy. Confirmed with Dan
   2026-10-27: 3642 S Jason Street, Englewood CO 80110. */
const SHIP_FROM = {
  name:    Deno.env.get("SHIP_FROM_NAME")   ?? "The Reflect Co",
  street1: Deno.env.get("SHIP_FROM_STREET") ?? "3642 S Jason Street",
  city:    Deno.env.get("SHIP_FROM_CITY")   ?? "Englewood",
  state:   Deno.env.get("SHIP_FROM_STATE")  ?? "CO",
  zip:     Deno.env.get("SHIP_FROM_ZIP")    ?? "80110",
  country: "US",
  email:   Deno.env.get("SHIP_FROM_EMAIL")  ?? "dan@thereflectco.com",
};

/* Parcel (fixed) */
const PARCEL = {
  length:        "10",
  width:          "7",
  height:         "5",
  distance_unit: "in",
  weight:        "2.78",
  mass_unit:     "lb",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-flow-secret",
  "Content-Type": "application/json",
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

function storeHost() {
  return SHOPIFY_SHOP.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/* ---------- Shopify auth: fetch (or reuse cached) CCG access token ---------- */
async function getShopifyToken(db: any): Promise<string> {
  if (LEGACY_TOKEN) return LEGACY_TOKEN;
  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error("Shopify auth not configured (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET).");
  }
  const { data: cached } = await db.from("shopify_tokens").select("*").eq("key", "access_token").maybeSingle();
  if (cached && new Date(cached.expires_at).getTime() > Date.now() + 60_000) return cached.access_token;

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
  if (!res.ok) throw new Error(`CCG token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const token = parsed?.access_token;
  if (!token) throw new Error(`CCG response missing access_token`);
  const expiresAt = new Date(Date.now() + Number(parsed?.expires_in || 86399) * 1000).toISOString();
  await db.from("shopify_tokens").upsert({ key: "access_token", access_token: token, expires_at: expiresAt });
  return token;
}

async function shopifyGet(db: any, path: string): Promise<any> {
  const token = await getShopifyToken(db);
  const r = await fetch(`https://${storeHost()}/admin/api/${API_VERSION}${path}`, {
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Shopify GET ${path} ${r.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}

async function shopifyPost(db: any, path: string, body: any): Promise<any> {
  const token = await getShopifyToken(db);
  const r = await fetch(`https://${storeHost()}/admin/api/${API_VERSION}${path}`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Shopify POST ${path} ${r.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}

/* ---------- Shippo ---------- */
async function shippo(path: string, body?: any): Promise<any> {
  const r = await fetch(`${SHIPPO_API}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Authorization": `ShippoToken ${SHIPPO_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Shippo ${path} ${r.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}

/* ---------- Order id normalizer ----------
   Shopify Flow may pass either a numeric Admin REST id ("5473627635743")
   or a GraphQL global id ("gid://shopify/Order/5473627635743"). Normalize
   to the numeric REST id. */
function normalizeOrderId(raw: any): string {
  const s = String(raw ?? "").trim();
  const m = s.match(/(\d{6,})/);
  if (!m) throw new Error(`Unrecognized order_id: ${s}`);
  return m[1];
}

/* ---------- Handler ---------- */
serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  /* Shared-secret auth */
  if (!FLOW_SHARED_SECRET) return json({ error: "FLOW_SHARED_SECRET not set on the function." }, 500);
  if (req.headers.get("x-flow-secret") !== FLOW_SHARED_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }

  if (!SHIPPO_API_KEY) return json({ error: "SHIPPO_API_KEY not configured." }, 500);
  if (!SHOPIFY_SHOP)   return json({ error: "SHOPIFY_SHOP not configured." }, 500);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  let orderId: string;
  try { orderId = normalizeOrderId(body?.order_id ?? body?.shopify_order_id); }
  catch (e: any) { return json({ error: e.message }, 400); }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    /* 1. Fetch the order */
    const { order } = await shopifyGet(db, `/orders/${orderId}.json`);
    if (!order) return json({ error: "Order not found." }, 404);
    const shipTo = order.shipping_address;
    if (!shipTo) return json({ error: "Order has no shipping_address." }, 400);

    const address_to: any = {
      name:    shipTo.name,
      company: shipTo.company || undefined,
      street1: shipTo.address1,
      street2: shipTo.address2 || undefined,
      city:    shipTo.city,
      state:   shipTo.province_code,
      zip:     shipTo.zip,
      country: shipTo.country_code || "US",
      phone:   shipTo.phone || undefined,
      email:   order.email || undefined,
    };

    /* 1b. IDEMPOTENCY — if Flow retries (timeout, network blip) after a
       prior invocation already bought a label and created a fulfillment
       on this order, bail here. Without this guard we'd buy a second
       label (real postage) and create a duplicate fulfillment, meaning
       the customer gets two shipping emails and we pay for two labels. */
    try {
      const existingFul = await shopifyGet(db, `/orders/${orderId}/fulfillments.json`);
      const already = (existingFul?.fulfillments || []).find(
        (f: any) => (f.tracking_number || f.tracking_numbers?.length) &&
                    (f.status === "success" || f.status === "pending")
      );
      if (already) {
        return json({
          ok: true,
          already_shipped: true,
          order_name: order.name,
          order_id: String(order.id),
          tracking_number: already.tracking_number || already.tracking_numbers?.[0] || null,
          tracking_url: already.tracking_url || null,
          service: already.tracking_company || null,
          note: "This order already has a fulfillment with tracking — skipping to avoid duplicate labels.",
        });
      }
    } catch (_) { /* non-fatal — fall through to normal flow */ }

    /* 2. Create Shippo shipment (synchronous — Shippo returns rates in one call) */
    const shipment = await shippo("/shipments/", {
      address_from: SHIP_FROM,
      address_to,
      parcels: [PARCEL],
      async: false,
    });

    if (shipment.status === "ERROR") {
      return json({ error: "Shippo shipment failed.", shippo_messages: shipment.messages }, 502);
    }

    /* 3. Pick cheapest USPS rate. Fall back to the cheapest rate from
       ANY carrier if USPS can't service this address (Canada, APO/FPO,
       PO Box in some cases). Without the fallback, non-US orders 502
       and Flow retries forever, label never buys, the order sits
       unshipped. */
    const allRates = (shipment.rates || [])
      .filter((r: any) => r.amount && !isNaN(Number(r.amount)))
      .sort((a: any, b: any) => Number(a.amount) - Number(b.amount));
    if (!allRates.length) {
      return json({ error: "No rates returned from Shippo.", shipment_id: shipment.object_id }, 502);
    }
    const uspsRates = allRates.filter((r: any) => (r.provider || "").toUpperCase() === "USPS");
    const rate = uspsRates[0] || allRates[0];
    const usedFallback = !uspsRates.length;

    const summary: any = {
      ok: true,
      dry_run: DRY_RUN,
      order_name: order.name,
      order_id: String(order.id),
      carrier: rate.provider || "USPS",
      service: rate.servicelevel?.name || rate.provider || "USPS",
      cost: `${rate.amount} ${rate.currency}`,
      estimated_days: rate.estimated_days ?? null,
      used_non_usps_fallback: usedFallback,
      ship_to_city: shipTo.city && shipTo.province_code ? `${shipTo.city}, ${shipTo.province_code}` : (shipTo.city || ""),
      customer_email: order.email || null,
    };

    if (DRY_RUN) {
      return json({
        ...summary,
        label_url: null,
        tracking_number: null,
        tracking_url: null,
        shopify_fulfillment_id: null,
        note: "DRY_RUN=true. No label purchased. Set FLOW_DRY_RUN=false in Supabase secrets to buy real labels.",
      });
    }

    /* 4. Buy the label */
    const tx = await shippo("/transactions/", {
      rate: rate.object_id,
      label_file_type: "PDF",
      async: false,
    });

    if (tx.status !== "SUCCESS") {
      return json({
        error: "Shippo label purchase failed.",
        shippo_status: tx.status,
        shippo_messages: tx.messages,
      }, 502);
    }

    const trackingNumber = tx.tracking_number;
    const labelUrl       = tx.label_url;
    const trackingUrl    = tx.tracking_url_provider;

    /* 5. Create Shopify Fulfillment with tracking so Shopify auto-emails the customer.
          Non-fatal: if this fails we still return the label so Dan/BJ can print and ship. */
    let fulfillmentId: string | null = null;
    let fulfillmentError: string | null = null;
    try {
      const { fulfillment_orders } = await shopifyGet(db, `/orders/${orderId}/fulfillment_orders.json`);
      const openFo = (fulfillment_orders || []).find(
        (f: any) => f.status === "open" || f.status === "in_progress"
      );
      if (openFo) {
        const fulRes = await shopifyPost(db, `/fulfillments.json`, {
          fulfillment: {
            message: "Shipped via USPS.",
            notify_customer: true,
            tracking_info: { number: trackingNumber, url: trackingUrl, company: "USPS" },
            line_items_by_fulfillment_order: [{ fulfillment_order_id: openFo.id }],
          },
        });
        fulfillmentId = fulRes?.fulfillment?.id ? String(fulRes.fulfillment.id) : null;
      } else {
        fulfillmentError = "No open fulfillment_order for this order.";
      }
    } catch (e: any) {
      fulfillmentError = e?.message || String(e);
      console.error("[ship-paid-order] fulfillment create failed:", fulfillmentError);
    }

    return json({
      ...summary,
      label_url: labelUrl,
      tracking_number: trackingNumber,
      tracking_url: trackingUrl,
      shopify_fulfillment_id: fulfillmentId,
      fulfillment_error: fulfillmentError,
    });

  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error("[ship-paid-order] failed:", msg);
    return json({ error: msg }, 502);
  }
});
