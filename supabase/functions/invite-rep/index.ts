/* =====================================================================
   The Reflect Co — Invite Rep Edge Function
   When admin adds a rep, this triggers Supabase to send them an official
   invitation email with a link to set their password and join the CRM.
   Admin-only. Their pre-set profile data (rep_id, role, commission,
   territory) is applied at signup by the on_auth_user_created trigger.

   POST { email }
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL   = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON  = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY    = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRM_URL        = Deno.env.get("CRM_URL") ?? "https://dnarsete.github.io/reflect-co-crm/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

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

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const email = String(body?.email || "").toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ error: "Valid email required" }, 400);
  }

  /* --- send the invite via Supabase Admin API --- */
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: CRM_URL,
  });

  if (error) {
    return json({ error: error.message }, 500);
  }
  return json({ ok: true, user_id: data?.user?.id });
});

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: cors });
}
