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
     - orders/paid              -> mark as paid
     - orders/cancelled         -> mark CRM order cancelled
     - refunds/create           -> mark CRM order refunded
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

/* Webhook HMAC key.
   Dev Dashboard apps (post-2026) sign every webhook with the app's Client Secret.
   Prefer SHOPIFY_CLIENT_SECRET; fall back to the legacy SHOPIFY_WEBHOOK_SECRET
   for any deployment still using the old model.
   Reference: https://shopify.dev/docs/apps/build/webhooks/verify-deliveries */
const WEBHOOK_SECRET = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? Deno.env.get("SHOPIFY_WEBHOOK_SECRET") ?? "";
const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") return new Response("POST only", { status: 405 });
  if (!WEBHOOK_SECRET) return new Response("Webhook secret not configured (set SHOPIFY_CLIENT_SECRET)", { status: 500 });

  const raw = await req.text();
  const hmacHeader = req.headers.get("X-Shopify-Hmac-Sha256") || "";
  const topic = req.headers.get("X-Shopify-Topic") || "";

  /* --- verify the request genuinely came from Shopify --- */
  const valid = await verifyHmac(raw, hmacHeader, WEBHOOK_SECRET);
  if (!valid) return new Response("Invalid HMAC signature", { status: 401 });

  let data: any;
  try { data = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let handlerFailed = false;
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
      case "orders/cancelled":
        await onOrderTerminal(db, data, "cancelled");
        break;
      case "refunds/create":
        /* Refund payloads are shaped differently — data.order_id is the
           parent order. Look up by that and mark refunded. */
        await onRefund(db, data);
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
    handlerFailed = true;
    await db.from("shopify_sync_log").insert({
      action: `webhook:${topic}`, status: "error",
      detail: { message: String(e?.message || e) },
    });
  }

  /* Return 500 for genuine handler failures so Shopify retries with backoff.
     Previously we always returned 200 → a persistent bug in the receiver
     silently dropped events forever. Auth/HMAC/parse failures already
     returned non-200 codes above; this catches the runtime path. */
  return new Response(handlerFailed ? "handler error" : "ok", { status: handlerFailed ? 500 : 200 });
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
  /* Constant-time compare — no length-based short-circuit. Fold the length delta
     into the diff so mismatched lengths never bypass the loop. */
  const n = Math.max(computed.length, headerHmac.length);
  let diff = computed.length ^ headerHmac.length;
  for (let i = 0; i < n; i++) {
    diff |= (computed.charCodeAt(i) || 0) ^ (headerHmac.charCodeAt(i) || 0);
  }
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

/* Stable precedence for shopify_status — a stronger state must never regress
   to a weaker one. Higher number = further along the lifecycle. */
const STATUS_RANK: Record<string, number> = {
  "": 0, "open": 1, "pending": 2, "partially_paid": 3,
  "authorized": 4, "paid": 5, "partially_fulfilled": 6,
  "fulfilled": 7, "refunded": 8, "voided": 8, "cancelled": 9,
};

function nextShopifyStatus(current: string | null | undefined, incoming: string | null | undefined): string {
  const cur = String(current || "").toLowerCase();
  const inc = String(incoming || "open").toLowerCase();
  const curRank = STATUS_RANK[cur] ?? 0;
  const incRank = STATUS_RANK[inc] ?? 0;
  return incRank >= curRank ? inc : cur;
}

async function onOrderUpdate(db: any, data: any) {
  /* data is a full order object. Match to a CRM order by shopify_order_id
     or by the draft-order id it originated from. */
  const orderId = data?.id ? String(data.id) : null;
  if (!orderId) return;

  const tracking = (data.fulfillments || [])
    .flatMap((f: any) => f.tracking_numbers || [])
    .filter(Boolean);

  /* Try matching by shopify_order_id first */
  let { data: matched } = await db.from("orders").select("id, status, shopify_status")
    .eq("shopify_order_id", orderId).maybeSingle();

  /* Else match by the draft order it was created from */
  if (!matched && data.draft_order_id) {
    const r = await db.from("orders").select("id, status, shopify_status")
      .eq("shopify_draft_order_id", String(data.draft_order_id)).maybeSingle();
    matched = r.data;
  }

  if (!matched) return;

  /* Build the incoming status from the strongest signal Shopify sent. */
  const incoming =
    data.fulfillment_status ||
    data.financial_status ||
    "open";

  const update: any = {
    shopify_order_id: orderId,
    /* Never regress a stronger state. Prevents the paid → open flap when a
       later orders/updated arrives with fulfillment_status=null. */
    shopify_status: nextShopifyStatus(matched.shopify_status, incoming),
  };
  if (tracking.length) update.tracking = tracking.join(", ");

  /* Only lift status to 'finalized' if the CRM order is still in a
     pre-terminal state. Never overwrite a 'cancelled' or 'refunded' order
     back to 'finalized' — Shopify sometimes replays a fulfilled event after
     a cancellation and we must not resurrect the order. */
  if (data.fulfillment_status === "fulfilled" &&
      (matched.status === "draft" || matched.status === "finalized")) {
    update.status = "finalized";
  }

  await db.from("orders").update(update).eq("id", matched.id);
}

async function onOrderTerminal(db: any, data: any, terminalStatus: "cancelled" | "refunded") {
  const orderId = data?.id ? String(data.id) : null;
  if (!orderId) return;
  let { data: matched } = await db.from("orders").select("id, status")
    .eq("shopify_order_id", orderId).maybeSingle();
  if (!matched && data.draft_order_id) {
    const r = await db.from("orders").select("id, status")
      .eq("shopify_draft_order_id", String(data.draft_order_id)).maybeSingle();
    matched = r.data;
  }
  if (!matched) return;
  await db.from("orders").update({
    status: terminalStatus,
    shopify_status: terminalStatus,
  }).eq("id", matched.id);
}

async function onRefund(db: any, refund: any) {
  /* refunds/create payload: { id, order_id, ... }. Look up the parent order. */
  const parentOrderId = refund?.order_id ? String(refund.order_id) : null;
  if (!parentOrderId) return;
  const { data: matched } = await db.from("orders").select("id, status")
    .eq("shopify_order_id", parentOrderId).maybeSingle();
  if (!matched) return;
  await db.from("orders").update({
    status: "refunded",
    shopify_status: "refunded",
  }).eq("id", matched.id);
}
