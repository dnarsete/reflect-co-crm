/* =====================================================================
   The Reflect Co — Shopify Webhook Receiver
   Receives events Shopify pushes when things change on their side, and
   updates the CRM. Verifies the HMAC signature so only genuine Shopify
   requests are accepted.

   Subscribe these topics (in Shopify admin or via API):
     - inventory_levels/update  -> refresh products.stock
     - products/update          -> refresh product name/price/stock
     - orders/fulfilled         -> set order tracking + status
     - orders/updated           -> sync order financial/fulfillment status
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const WEBHOOK_SECRET = Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("Webhook secret not configured", { status: 500 });

  const raw = await req.text();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || "";
  const topic = req.headers.get("X-Shopify-Topic") || "";

  /* --- verify the request genuinely came from Shopify --- */
  const valid = await verifyHmac(raw, hmacHeader, WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid HMAC signature", { status: 401 });

  let data: any;
  try { data = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  try {
    switch (topic) {
      case "inventory_levels/update":
        await onInventoryUpdate(db, data);
        break;
      case "products/update":
        await onProductUpdate(db, data);
        break;
      case "orders/fulfilled":
      case "orders/updated":
      case "orders/paid":
        await onOrderUpdate(db, data);
        break;
      default:
        /* Unhandled topic — acknowledge so Shopify doesn't retry forever */
        break;
    }
    await db.from("shopify_sync_log").insert({
      action: `webhook:${topic}`, status: "success",
      detail: { id: data?.id ?? null },
    });
  } catch (e: any) {
    await db.from("shopify_sync_log").insert({
      action: `webhook:${topic}`, status: "error",
      detail: { message: String(e?.message || e) },
    });
    /* Still return 200 so Shopify doesn't hammer retries for a transient issue */
  }

  return new Response("ok", { status: 200 });
});

/* HMAC-SHA256 verification of the raw body against the shared secret */
async function verifyHmac(body: string, headerHmac: string, secret: string): Promise<boolean> {
  if (!headerHmac) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)));
  /* constant-time-ish compare */
  if (computed.length !== headerHmac.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ headerHmac.charCodeAt(i);
  return diff === 0;
}

async function onInventoryUpdate(db: any, data: any) {
  /* data: { inventory_item_id, location_id, available, updated_at } */
  const itemId = data?.inventory_item_id ? String(data.inventory_item_id) : null;
  if (!itemId) return;
  await db.from("products")
    .update({ stock: Number(data.available || 0), synced_at: new Date().toISOString() })
    .eq("shopify_inventory_item_id", itemId);
}

async function onProductUpdate(db: any, data: any) {
  /* data is a full product object */
  const pid = data?.id ? String(data.id) : null;
  if (!pid) return;
  for (const v of (data.variants || [])) {
    const sku = (v.sku || "").trim();
    if (!sku) continue;
    await db.from("products").update({
      name: data.title + (v.title && v.title !== "Default Title" ? ` — ${v.title}` : ""),
      price: Number(v.price || 0),
      active: data.status === "active",
      shopify_product_id: pid,
      shopify_variant_id: String(v.id),
      shopify_inventory_item_id: v.inventory_item_id ? String(v.inventory_item_id) : null,
      synced_at: new Date().toISOString(),
    }).eq("sku", sku);
  }
}

async function onOrderUpdate(db: any, data: any) {
  /* data is a full order object. Match to a CRM order by shopify_order_id
     or by the draft-order id it originated from. */
  const orderId = data?.id ? String(data.id) : null;
  if (!orderId) return;

  const tracking = (data.fulfillments || [])
    .flatMap((f: any) => f.tracking_numbers || [])
    .filter(Boolean);

  const update: any = {
    shopify_order_id: orderId,
    shopify_status: data.fulfillment_status || data.financial_status || "open",
  };
  if (tracking.length) update.tracking = tracking.join(", ");
  if (data.fulfillment_status === "fulfilled") update.status = "finalized";

  /* Try matching by shopify_order_id first */
  let { data: matched } = await db.from("orders").select("id").eq("shopify_order_id", orderId).maybeSingle();

  /* Else match by the draft order it was created from */
  if (!matched && data.draft_order_id) {
    const r = await db.from("orders").select("id")
      .eq("shopify_draft_order_id", String(data.draft_order_id)).maybeSingle();
    matched = r.data;
  }

  if (matched) {
    await db.from("orders").update(update).eq("id", matched.id);
  }
}
