/* =====================================================================
   The Reflect Co — AI Assistant Edge Function
   Runs on Supabase Edge Runtime (Deno). Receives a chat history from the
   browser, calls Anthropic's Claude API with a tool-calling loop, queries
   Supabase as the user (RLS preserved), returns the final answer.
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MODEL = Deno.env.get("ANTHROPIC_MODEL") ?? "claude-haiku-4-5-20251001"; // cheap default; swap to claude-sonnet-4-6 for higher quality
const MAX_TURNS = 10;

const DEFAULT_ORIGINS = [
  "https://dnarsete.github.io",
  "https://thereflectco.com",
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
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!ANTHROPIC_KEY) return json({ error: "AI not configured (ANTHROPIC_API_KEY missing)." }, 500);

  try {
    const body = await req.json();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) return json({ error: "messages[] required" }, 400);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Authorization header required" }, 401);

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await sb.auth.getUser();
    if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
    const user = userData.user;

    const { data: profile } = await sb
      .from("profiles")
      .select("id, email, name, role, rep_id, commission, territory, disabled")
      .eq("id", user.id)
      .single();

    if (!profile) return json({ error: "Profile not found" }, 403);
    if (profile.disabled) return json({ error: "Account disabled" }, 403);

    const isAdmin = profile.role === "admin";
    const tools = buildTools(isAdmin);
    const system = buildSystemPrompt(profile, isAdmin);

    // Conversation loop with tool use
    let convo = [...messages];
    let totalTokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const resp = await callClaude(system, tools, convo);
      if (resp.error) return json({ error: resp.error }, 502);

      totalTokens.input += resp.usage?.input_tokens ?? 0;
      totalTokens.output += resp.usage?.output_tokens ?? 0;
      totalTokens.cache_read += resp.usage?.cache_read_input_tokens ?? 0;
      totalTokens.cache_creation += resp.usage?.cache_creation_input_tokens ?? 0;

      // Final answer (no more tool requests)
      if (resp.stop_reason === "end_turn") {
        const text = (resp.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        return json({ message: text, usage: totalTokens, turns: turn + 1 });
      }

      // Tool use requested
      const toolUses = (resp.content || []).filter((c: any) => c.type === "tool_use");
      if (!toolUses.length) {
        // Some text response without end_turn; return it
        const text = (resp.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("");
        return json({ message: text || "(no response)", usage: totalTokens, turns: turn + 1 });
      }

      const toolResults: any[] = [];
      for (const tu of toolUses) {
        try {
          const result = await runTool(tu.name, tu.input || {}, sb, profile, isAdmin);
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify(result).slice(0, 50_000), // safety cap
          });
        } catch (e: any) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: `Tool error: ${e?.message || e}`,
          });
        }
      }

      convo = [
        ...convo,
        { role: "assistant", content: resp.content },
        { role: "user", content: toolResults },
      ];
    }

    return json({ error: "Hit max tool-call iterations without an answer." }, 500);
  } catch (e: any) {
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

/* ----------------- Helpers ----------------- */

async function callClaude(system: any, tools: any[], messages: any[]) {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system,
        tools,
        messages,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { error: `Anthropic API ${res.status}: ${txt.slice(0, 500)}` };
    }
    return await res.json();
  } catch (e: any) {
    return { error: `Network error calling Anthropic: ${e?.message || e}` };
  }
}

/* ----------------- System prompt ----------------- */

function buildSystemPrompt(profile: any, isAdmin: boolean) {
  const today = new Date().toISOString().slice(0, 10);
  const text = `You are the AI assistant for The Reflect Co's sales rep CRM.

# Today's user
- Name: ${profile.name || profile.email}
- Email: ${profile.email}
- Role: ${profile.role}
- Rep ID: ${profile.rep_id || "(none)"}
- Commission rate: ${profile.commission ?? 10}%
- Territory: ${(profile.territory || []).join(", ") || "(none set)"}

# Today's date: ${today}

# About The Reflect Co
The Reflect Co (thereflectco.com) is a skincare / cosmetics wholesaler based at 3642 S. Jason Street, Englewood CO 80210. They sell wholesale to dermatologists, medical spas, boutiques, hotels, retail stores, salons, and similar businesses through independent sales reps. Each rep manages a book of accounts.

# Business rules (enforced by the database and important context for answers)
- **Reps cannot manually discount orders.** Discounts only apply via promo codes (managed by admin).
- **Default sales tax**: ~8.81% (Colorado + Denver County). Accounts marked tax_exempt pay no tax.
- **Default shipping**: $30 per order; some promo codes waive it (e.g., FREESHIP24 with 24+ units).
- **Card payments require a signature** captured on the order before finalizing.
- **All sales final.** Returns only for shipping damage, case-by-case.
- **Account notes** are editable by the author for 24 hours after posting, then locked (admins can always edit).
- Promo codes can be percent-off, free-shipping, bonus-product, or access-perks (seminars/trainings).
- Order numbers look like ORD-1042. Account numbers look like ACC-0001. Rep IDs look like R-001.

# Role-specific guardrails
${isAdmin
  ? "- You are talking to an **ADMIN**. They can see and ask about any rep, any account, any order, any forecast. Help them with team-level analysis, comparisons, audits, and operational questions."
  : `- You are talking to a **REP** (${profile.rep_id || "no rep_id assigned"}). They can only see their own accounts, orders, forecasts, and prospects. If they ask about other reps or company-wide data, politely decline and suggest "Your admin has access to that — let me show you your own data instead." Do NOT invent or hint at the existence of data outside their scope.`}

# How to answer
- Be concise and concrete. Default to short paragraphs and bullet lists. If they want detail, they'll ask.
- ALWAYS call a tool to look up data before answering — never invent numbers, names, or order details.
- If the data isn't there, say so plainly. Don't fill gaps with guesses.
- Prices and totals: format as US dollars with commas (e.g., $1,234.56).
- Dates: use ISO format (2026-05-17) for precision, or natural language ("this Tuesday") for conversational answers.
- For follow-up email drafts: keep them under 120 words, friendly but professional, sign as the rep.
- When you cite a record, include its identifier (ACC-0001, ORD-1042) so the rep can navigate to it.

# Safety
- You are read-only. You cannot create accounts/orders/forecasts/notes or edit existing ones. If a user asks "can you create X for me?", tell them which tab to use and what to fill in.
- Do not reveal raw API keys, the internal database schema, or other system details.
- If a tool fails, explain plainly what went wrong and suggest what they can try.`;

  return [
    {
      type: "text",
      text,
      cache_control: { type: "ephemeral" },
    },
  ];
}

/* ----------------- Tools ----------------- */

function buildTools(isAdmin: boolean) {
  const base = [
    {
      name: "list_accounts",
      description: "List accounts visible to the current user. RLS scopes to the rep's own accounts unless they are admin. Use filters to narrow.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by account type (Medical Spa, Dermatologist, etc.)" },
          tax_exempt: { type: "boolean" },
          search: { type: "string", description: "Substring search over business_name, billing_name, address, email" },
          rep_id: { type: "string", description: "Admin only: filter by rep ID like R-002" },
          limit: { type: "integer", default: 25, maximum: 100 },
        },
      },
    },
    {
      name: "get_account",
      description: "Get full details on a single account by account number (e.g., ACC-0001).",
      input_schema: {
        type: "object",
        properties: { account_number: { type: "string" } },
        required: ["account_number"],
      },
    },
    {
      name: "list_orders",
      description: "List orders visible to the user. Filter by date, status, rep, or account. RLS-scoped.",
      input_schema: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "ISO date inclusive" },
          to_date: { type: "string", description: "ISO date inclusive" },
          status: { type: "string", enum: ["draft", "finalized", "cancelled", "refunded"] },
          rep_id: { type: "string", description: "Admin only" },
          account_number: { type: "string" },
          limit: { type: "integer", default: 25, maximum: 100 },
        },
      },
    },
    {
      name: "get_order",
      description: "Get one order's full details by order number (e.g., ORD-1042).",
      input_schema: {
        type: "object",
        properties: { order_number: { type: "string" } },
        required: ["order_number"],
      },
    },
    {
      name: "revenue_summary",
      description: "Compute revenue, order count, average order, and commission for the current user (or any rep if admin) over a date range.",
      input_schema: {
        type: "object",
        properties: {
          from_date: { type: "string", description: "ISO date inclusive (defaults to start of current month)" },
          to_date: { type: "string", description: "ISO date inclusive (defaults to today)" },
          rep_id: { type: "string", description: "Admin only: target a specific rep" },
        },
      },
    },
    {
      name: "find_overdue_accounts",
      description: "Find accounts that haven't ordered in N+ days. Defaults to the system's reorder_due_days setting.",
      input_schema: {
        type: "object",
        properties: {
          days: { type: "integer", description: "Days since last order; defaults to ~45" },
          rep_id: { type: "string", description: "Admin only" },
          limit: { type: "integer", default: 25, maximum: 100 },
        },
      },
    },
    {
      name: "list_forecasts",
      description: "List forecasts. Filter by period (YYYY-MM-01), status, or rep.",
      input_schema: {
        type: "object",
        properties: {
          period_month: { type: "string", description: "First of month, YYYY-MM-01" },
          status: { type: "string", enum: ["open", "pending", "won", "lost"] },
          rep_id: { type: "string", description: "Admin only" },
          limit: { type: "integer", default: 50, maximum: 200 },
        },
      },
    },
    {
      name: "list_promotions",
      description: "List active promotion codes the team can use on orders.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "list_products",
      description: "List the product catalog (SKU, name, wholesale price, stock).",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "compare_periods",
      description: "Compare two date ranges side-by-side: revenue, order count, average order.",
      input_schema: {
        type: "object",
        properties: {
          a_from: { type: "string" },
          a_to: { type: "string" },
          b_from: { type: "string" },
          b_to: { type: "string" },
          rep_id: { type: "string", description: "Admin only" },
        },
        required: ["a_from", "a_to", "b_from", "b_to"],
      },
    },
  ];

  const adminTools = [
    {
      name: "list_reps",
      description: "Admin only: list all reps with rep_id, name, commission, territory.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "rep_performance_breakdown",
      description: "Admin only: compute revenue/orders/commission per rep for a date range.",
      input_schema: {
        type: "object",
        properties: {
          from_date: { type: "string" },
          to_date: { type: "string" },
        },
      },
    },
    {
      name: "forecast_rollup",
      description: "Admin only: aggregate forecasts across all reps for a period — total monthly, total weighted, cases of Appose Lip TX needed.",
      input_schema: {
        type: "object",
        properties: {
          period_month: { type: "string", description: "First of month, YYYY-MM-01" },
        },
      },
    },
  ];

  // Cache the tool definitions (they're stable across calls)
  const all = isAdmin ? [...base, ...adminTools] : base;
  // Anthropic prompt caching: last tool gets cache_control to cache everything up to it
  if (all.length > 0) (all[all.length - 1] as any).cache_control = { type: "ephemeral" };
  return all;
}

/* ----------------- Tool execution ----------------- */

async function runTool(name: string, input: any, sb: any, profile: any, isAdmin: boolean) {
  switch (name) {
    case "list_accounts":
      return await tList(sb, "accounts", {
        type: input.type, tax_exempt: input.tax_exempt, rep_id: input.rep_id,
        search_cols: ["business_name", "billing_name", "business_address", "email", "account_number"],
        search: input.search,
        select: "id, account_number, business_name, type, business_address, email, business_phone, rep_id, tax_exempt, created_at",
        limit: clampLimit(input.limit, 25, 100),
        isAdmin,
      });
    case "get_account": {
      const r = await sb.from("accounts").select("*").ilike("account_number", input.account_number).maybeSingle();
      return r.error ? { error: r.error.message } : (r.data || { error: "Not found" });
    }
    case "list_orders":
      return await tListOrders(sb, input, isAdmin);
    case "get_order": {
      const r = await sb.from("orders").select("*, account:accounts(account_number, business_name, type)").ilike("order_number", input.order_number).maybeSingle();
      return r.error ? { error: r.error.message } : (r.data || { error: "Not found" });
    }
    case "revenue_summary":
      return await tRevenueSummary(sb, input, profile, isAdmin);
    case "find_overdue_accounts":
      return await tOverdue(sb, input, profile, isAdmin);
    case "list_forecasts":
      return await tListForecasts(sb, input, isAdmin);
    case "list_promotions": {
      const r = await sb.from("promotions").select("code, kind, value, min_qty, perks, active").eq("active", true).order("code");
      return r.error ? { error: r.error.message } : r.data;
    }
    case "list_products": {
      const r = await sb.from("products").select("sku, name, price, stock, active").order("name");
      return r.error ? { error: r.error.message } : r.data;
    }
    case "compare_periods":
      return await tComparePeriods(sb, input, profile, isAdmin);
    case "list_reps":
      if (!isAdmin) return { error: "Admin only" };
      return (await sb.from("profiles").select("rep_id, name, email, role, commission, territory, disabled").order("rep_id")).data;
    case "rep_performance_breakdown":
      if (!isAdmin) return { error: "Admin only" };
      return await tRepPerformance(sb, input);
    case "forecast_rollup":
      if (!isAdmin) return { error: "Admin only" };
      return await tForecastRollup(sb, input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function clampLimit(v: any, def: number, max: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

async function tList(sb: any, table: string, opts: any) {
  let q = sb.from(table).select(opts.select).limit(opts.limit).order("created_at", { ascending: false });
  if (opts.type) q = q.eq("type", opts.type);
  if (typeof opts.tax_exempt === "boolean") q = q.eq("tax_exempt", opts.tax_exempt);
  if (opts.isAdmin && opts.rep_id) q = q.eq("rep_id", opts.rep_id);
  if (opts.search && opts.search_cols?.length) {
    const orParts = opts.search_cols.map((c: string) => `${c}.ilike.%${opts.search}%`);
    q = q.or(orParts.join(","));
  }
  const r = await q;
  return r.error ? { error: r.error.message } : { count: r.data?.length || 0, rows: r.data };
}

async function tListOrders(sb: any, input: any, isAdmin: boolean) {
  let q = sb.from("orders").select("id, order_number, account_id, rep_id, placed_at, items, shipping, tax, discount, total, status, promo_code, tracking, account:accounts(account_number, business_name, type)")
    .order("placed_at", { ascending: false })
    .limit(clampLimit(input.limit, 25, 100));
  if (input.from_date) q = q.gte("placed_at", input.from_date);
  if (input.to_date) q = q.lte("placed_at", input.to_date + "T23:59:59");
  if (input.status) q = q.eq("status", input.status);
  if (isAdmin && input.rep_id) q = q.eq("rep_id", input.rep_id);
  if (input.account_number) {
    const a = await sb.from("accounts").select("id").ilike("account_number", input.account_number).maybeSingle();
    if (a.data?.id) q = q.eq("account_id", a.data.id);
  }
  const r = await q;
  return r.error ? { error: r.error.message } : { count: r.data?.length || 0, rows: r.data };
}

async function tRevenueSummary(sb: any, input: any, profile: any, isAdmin: boolean) {
  const today = new Date().toISOString().slice(0, 10);
  const monStart = new Date(); monStart.setDate(1);
  const from = input.from_date || monStart.toISOString().slice(0, 10);
  const to = input.to_date || today;
  let q = sb.from("orders").select("rep_id, items, shipping, tax, total").eq("status", "finalized").gte("placed_at", from).lte("placed_at", to + "T23:59:59");
  if (isAdmin && input.rep_id) q = q.eq("rep_id", input.rep_id);
  const r = await q;
  if (r.error) return { error: r.error.message };
  const rows = r.data || [];
  const revenue = rows.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
  const orders = rows.length;
  const avg = orders ? revenue / orders : 0;
  // Commission rate (current user's, or if admin querying a rep, that rep's)
  let commissionRate = profile.commission ?? 10;
  if (isAdmin && input.rep_id) {
    const p = await sb.from("profiles").select("commission").eq("rep_id", input.rep_id).maybeSingle();
    if (p.data) commissionRate = p.data.commission ?? 10;
  }
  const commission = rows.reduce(
    (s: number, o: any) => s + (Number(o.total || 0) - Number(o.shipping || 0) - Number(o.tax || 0)) * (commissionRate / 100),
    0,
  );
  return {
    from, to, rep_id: input.rep_id || profile.rep_id, commission_rate_pct: commissionRate,
    finalized_orders: orders,
    revenue: round2(revenue),
    average_order: round2(avg),
    commission_earned: round2(commission),
  };
}

async function tOverdue(sb: any, input: any, _profile: any, isAdmin: boolean) {
  const settings = await sb.from("settings").select("value").eq("key", "reorder_due_days").maybeSingle();
  const defaultDays = settings.data?.value ?? 45;
  const days = Number(input.days || defaultDays);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  let q = sb.from("accounts").select("id, account_number, business_name, type, rep_id, business_phone, email").limit(clampLimit(input.limit, 25, 100));
  if (isAdmin && input.rep_id) q = q.eq("rep_id", input.rep_id);
  const accs = await q;
  if (accs.error) return { error: accs.error.message };
  const results: any[] = [];
  for (const a of (accs.data || [])) {
    const last = await sb.from("orders").select("placed_at").eq("account_id", a.id).eq("status", "finalized").order("placed_at", { ascending: false }).limit(1);
    const lastDate = last.data?.[0]?.placed_at;
    if (!lastDate || new Date(lastDate) < new Date(cutoff)) {
      results.push({
        account_number: a.account_number,
        business_name: a.business_name,
        type: a.type, rep_id: a.rep_id,
        contact: { phone: a.business_phone, email: a.email },
        last_order_at: lastDate || null,
        days_since_last: lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : null,
      });
    }
  }
  return { threshold_days: days, count: results.length, accounts: results.slice(0, clampLimit(input.limit, 25, 100)) };
}

async function tListForecasts(sb: any, input: any, isAdmin: boolean) {
  let q = sb.from("forecasts").select("*, account:accounts(account_number, business_name, type), prospect:prospects(name, account_type)").order("period_month", { ascending: false }).limit(clampLimit(input.limit, 50, 200));
  if (input.period_month) q = q.eq("period_month", input.period_month);
  if (input.status) q = q.eq("status", input.status);
  if (isAdmin && input.rep_id) q = q.eq("rep_id", input.rep_id);
  const r = await q;
  return r.error ? { error: r.error.message } : { count: r.data?.length || 0, rows: r.data };
}

async function tComparePeriods(sb: any, input: any, profile: any, isAdmin: boolean) {
  const a = await tRevenueSummary(sb, { from_date: input.a_from, to_date: input.a_to, rep_id: input.rep_id }, profile, isAdmin);
  const b = await tRevenueSummary(sb, { from_date: input.b_from, to_date: input.b_to, rep_id: input.rep_id }, profile, isAdmin);
  const delta = (k: string) => {
    const av = a[k] ?? 0, bv = b[k] ?? 0;
    const diff = bv - av;
    const pct = av ? (diff / av) * 100 : null;
    return { a: av, b: bv, change: round2(diff), pct: pct === null ? null : round2(pct) };
  };
  return {
    period_a: { from: input.a_from, to: input.a_to },
    period_b: { from: input.b_from, to: input.b_to },
    revenue: delta("revenue"),
    finalized_orders: { a: a.finalized_orders, b: b.finalized_orders, change: b.finalized_orders - a.finalized_orders },
    average_order: delta("average_order"),
    commission_earned: delta("commission_earned"),
  };
}

async function tRepPerformance(sb: any, input: any) {
  const today = new Date().toISOString().slice(0, 10);
  const monStart = new Date(); monStart.setDate(1);
  const from = input.from_date || monStart.toISOString().slice(0, 10);
  const to = input.to_date || today;
  const reps = await sb.from("profiles").select("rep_id, name, commission").not("rep_id", "is", null).order("rep_id");
  if (reps.error) return { error: reps.error.message };
  const out: any[] = [];
  for (const rep of (reps.data || [])) {
    if (!rep.rep_id) continue;
    const r = await sb.from("orders").select("shipping, tax, total").eq("status", "finalized").eq("rep_id", rep.rep_id).gte("placed_at", from).lte("placed_at", to + "T23:59:59");
    const rows = r.data || [];
    const revenue = rows.reduce((s: number, o: any) => s + Number(o.total || 0), 0);
    const commission = rows.reduce((s: number, o: any) => s + (Number(o.total || 0) - Number(o.shipping || 0) - Number(o.tax || 0)) * ((rep.commission ?? 10) / 100), 0);
    out.push({
      rep_id: rep.rep_id, name: rep.name,
      orders: rows.length,
      revenue: round2(revenue),
      commission: round2(commission),
    });
  }
  out.sort((x, y) => y.revenue - x.revenue);
  return { from, to, reps: out };
}

async function tForecastRollup(sb: any, input: any) {
  const period = input.period_month;
  let q = sb.from("forecasts").select("rep_id, monthly_amount, quarterly_amount, close_probability, status, account:accounts(type), prospect:prospects(account_type)");
  if (period) q = q.eq("period_month", period);
  q = q.in("status", ["open", "pending"]);
  const r = await q;
  if (r.error) return { error: r.error.message };
  const rows = r.data || [];
  const casePriceSetting = await sb.from("settings").select("value").eq("key", "forecast_case_price").maybeSingle();
  const casePrice = Number(casePriceSetting.data?.value ?? 600);
  let totalMonthly = 0, totalQuarterly = 0, weighted = 0;
  const byRep: Record<string, any> = {};
  const byType: Record<string, any> = {};
  for (const f of rows) {
    const m = Number(f.monthly_amount || 0);
    const w = m * Number(f.close_probability || 0) / 100;
    totalMonthly += m; totalQuarterly += Number(f.quarterly_amount || 0); weighted += w;
    const repKey = f.rep_id || "(unassigned)";
    byRep[repKey] = byRep[repKey] || { count: 0, monthly: 0, weighted: 0 };
    byRep[repKey].count++; byRep[repKey].monthly += m; byRep[repKey].weighted += w;
    const typeKey = f.account?.type || f.prospect?.account_type || "Unknown";
    byType[typeKey] = byType[typeKey] || { count: 0, monthly: 0, weighted: 0 };
    byType[typeKey].count++; byType[typeKey].monthly += m; byType[typeKey].weighted += w;
  }
  return {
    period_month: period || "all",
    total_monthly: round2(totalMonthly),
    total_quarterly: round2(totalQuarterly),
    total_weighted: round2(weighted),
    case_price: casePrice,
    cases_appose_lip_tx_needed: casePrice > 0 ? Math.ceil(weighted / casePrice) : 0,
    by_rep: Object.entries(byRep).map(([rep_id, v]: any) => ({ rep_id, ...v, monthly: round2(v.monthly), weighted: round2(v.weighted) })),
    by_account_type: Object.entries(byType).map(([type, v]: any) => ({ type, ...v, monthly: round2(v.monthly), weighted: round2(v.weighted) })),
  };
}

function round2(n: number) { return Math.round(n * 100) / 100; }
