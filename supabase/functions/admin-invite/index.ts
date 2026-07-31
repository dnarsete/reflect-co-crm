/* =====================================================================
   The Reflect Co — Admin Invite Edge Function

   Admin-only. Given an email, creates the auth user (if new) and returns
   a one-click magic-link URL. Admin copies the URL and sends it however
   they want (text, email, Slack). Rep clicks the link → auto signed in.

   Why an Edge Function: creating auth users and generating admin magic
   links requires the service_role key, which cannot be exposed in the
   browser. This function verifies the caller is an admin via JWT before
   doing anything with service_role.

   POST body: { email: string, redirect_to?: string, name?: string }
   Response:  { ok: true, invite_url: string, email: string, is_new_user: bool }
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON  = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const DEFAULT_REDIRECT = "https://dnarsete.github.io/reflect-co-crm/";

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

  if (!SUPABASE_URL || !SUPABASE_ANON || !SERVICE_KEY) {
    return json({ error: "Supabase env not fully configured" }, 500);
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

  /* --- parse body --- */
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) return json({ error: "email required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email format" }, 400);
  const redirectTo = String(body?.redirect_to || DEFAULT_REDIRECT);

  /* --- service-role admin client --- */
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  /* --- Check if user already exists --- */
  let isNewUser = false;
  const listRes = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const existing = listRes.data?.users?.find((u: any) => (u.email || "").toLowerCase() === email);

  if (!existing) {
    /* Create the user auto-confirmed (no email verification step) */
    const createRes = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createRes.error) {
      return json({ error: "Create user failed: " + createRes.error.message }, 500);
    }
    isNewUser = true;
  }

  /* --- Generate a magic link (one-click sign in) --- */
  const linkRes = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (linkRes.error) {
    return json({ error: "Generate link failed: " + linkRes.error.message }, 500);
  }

  const inviteUrl = (linkRes.data as any)?.properties?.action_link
                 || (linkRes.data as any)?.action_link
                 || null;
  if (!inviteUrl) {
    return json({ error: "No action_link in generated link response" }, 500);
  }

  return json({
    ok: true,
    invite_url: inviteUrl,
    email,
    is_new_user: isNewUser,
  });
});
