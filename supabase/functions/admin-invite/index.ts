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

/* Paginated email lookup — walks auth.users 200 at a time until it finds a
   match or exhausts pages. Scales past the 1000-user limit of a single listUsers
   call. Returns the matching user object or null. */
async function findUserByEmail(admin: any, targetEmail: string): Promise<any | null> {
  const needle = targetEmail.toLowerCase();
  const perPage = 200;
  const maxPages = 100; /* backstop — 20,000 users covers Dan's foreseeable scale */
  for (let page = 1; page <= maxPages; page++) {
    const res = await admin.auth.admin.listUsers({ page, perPage });
    if (res.error) return null;
    const users = res.data?.users || [];
    if (!users.length) return null;
    const found = users.find((u: any) => (u.email || "").toLowerCase() === needle);
    if (found) return found;
    if (users.length < perPage) return null; /* last page */
  }
  return null;
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
  const mode = String(body?.mode || "invite");
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) return json({ error: "email required" }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Invalid email format" }, 400);
  const redirectTo = String(body?.redirect_to || DEFAULT_REDIRECT);

  /* --- service-role admin client --- */
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  /* --- Mode: delete_user --- permanently remove a rep from the system.
     Body: { mode: 'delete_user', user_id, email: user_email }.
     `email` is only used for the format check + logging clarity; the
     actual delete is by user_id. Cascades to profile via FK. */
  if (mode === "delete_user") {
    const userId = String(body?.user_id || "");
    if (!userId) return json({ error: "user_id required for delete_user" }, 400);
    /* Prevent an admin from deleting themselves via this endpoint */
    if (userId === userData.user.id) {
      return json({ error: "Cannot delete your own admin account" }, 400);
    }
    const del = await admin.auth.admin.deleteUser(userId);
    if (del.error) return json({ error: "Delete failed: " + del.error.message }, 500);
    /* Also clean up any pending invite that shares the email */
    const admDb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    await admDb.from("pending_invites").delete().eq("email", email);
    return json({ ok: true, mode: "delete_user", user_id: userId, email });
  }

  /* --- Mode: update_email --- change an existing user's email address.
     Body: { mode: 'update_email', user_id, email: new_email } */
  if (mode === "update_email") {
    const userId = String(body?.user_id || "");
    if (!userId) return json({ error: "user_id required for update_email" }, 400);

    /* Pre-flight: refuse if the new email is already owned by another user.
       updateUserById would fail with a cryptic message; give a clear one instead. */
    const clashCheck = await findUserByEmail(admin, email);
    if (clashCheck && clashCheck.id !== userId) {
      return json({ error: `Cannot change email — another user already exists with ${email}.` }, 409);
    }

    /* Look up the OLD email so we can clean any stale pending_invites for it. */
    const admDb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
    const oldProf = await admDb.from("profiles").select("email").eq("id", userId).maybeSingle();
    const oldEmail = (oldProf.data?.email || "").toLowerCase();

    const upd = await admin.auth.admin.updateUserById(userId, {
      email,
      email_confirm: true,
    });
    if (upd.error) return json({ error: "Auth email update failed: " + upd.error.message }, 500);
    /* Also update the profiles.email column so the app stays in sync */
    const profUpd = await admDb.from("profiles").update({ email }).eq("id", userId);
    if (profUpd.error) return json({ error: "Profile email update failed: " + profUpd.error.message }, 500);

    /* Clean up any pending_invites rows for the OLD or NEW email — they're
       stale now and would let a fresh admin add re-use unexpected data. */
    try {
      const emailsToClean = [email];
      if (oldEmail && oldEmail !== email) emailsToClean.push(oldEmail);
      await admDb.from("pending_invites").delete().in("email", emailsToClean);
    } catch (_) { /* non-fatal */ }

    /* Return a fresh magic link for the new email */
    const linkRes = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (linkRes.error) return json({ error: "Generate link failed: " + linkRes.error.message }, 500);
    const inviteUrl = (linkRes.data as any)?.properties?.action_link || (linkRes.data as any)?.action_link || null;
    return json({ ok: true, mode: "update_email", email, invite_url: inviteUrl });
  }

  /* --- Mode: invite (default) --- create user if new + generate magic link --- */
  let isNewUser = false;
  /* Paginate through auth.users instead of relying on a single 1000-user page.
     Previously beyond 1000 users this would fail to detect an existing user
     and hit "email already registered" on createUser. */
  const existing = await findUserByEmail(admin, email);

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
