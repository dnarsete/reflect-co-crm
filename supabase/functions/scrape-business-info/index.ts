/* =====================================================================
   The Reflect Co — Scrape Business Info Edge Function
   Given a business website URL, fetches the homepage (and /contact if
   present), extracts phone, email, and US address from the plain text,
   and returns a structured object the CRM can drop straight into the
   New Account form. Zero third-party API — free, bounded cost.

   Expected input (POST):
     { "url": "https://example.com" }

   Response (always 200 on reachable URL):
     {
       phone:   "720-492-7150"     | null,
       email:   "info@example.com" | null,
       street:  "7200 E Dry Creek Rd" | null,
       suite:   "#E105"            | null,
       city:    "Centennial"       | null,
       state:   "CO"               | null,
       zip:     "80112"            | null,
       pages_scraped: ["https://example.com/", "https://example.com/contact"],
       warnings: [ ... ]
     }

   Auth: Supabase JWT (same gate as the other CRM edge functions).
   ===================================================================== */

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

/* Browser-like UA so small-business sites don't block us as a bot. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FETCH_TIMEOUT_MS = 8000;

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

/* ---------- US_STATES lookup for address parsing ---------- */
const US_STATES: [string, string][] = [
  ["AL","Alabama"],["AK","Alaska"],["AZ","Arizona"],["AR","Arkansas"],
  ["CA","California"],["CO","Colorado"],["CT","Connecticut"],["DE","Delaware"],
  ["DC","District of Columbia"],["FL","Florida"],["GA","Georgia"],["HI","Hawaii"],
  ["ID","Idaho"],["IL","Illinois"],["IN","Indiana"],["IA","Iowa"],
  ["KS","Kansas"],["KY","Kentucky"],["LA","Louisiana"],["ME","Maine"],
  ["MD","Maryland"],["MA","Massachusetts"],["MI","Michigan"],["MN","Minnesota"],
  ["MS","Mississippi"],["MO","Missouri"],["MT","Montana"],["NE","Nebraska"],
  ["NV","Nevada"],["NH","New Hampshire"],["NJ","New Jersey"],["NM","New Mexico"],
  ["NY","New York"],["NC","North Carolina"],["ND","North Dakota"],["OH","Ohio"],
  ["OK","Oklahoma"],["OR","Oregon"],["PA","Pennsylvania"],["RI","Rhode Island"],
  ["SC","South Carolina"],["SD","South Dakota"],["TN","Tennessee"],["TX","Texas"],
  ["UT","Utah"],["VT","Vermont"],["VA","Virginia"],["WA","Washington"],
  ["WV","West Virginia"],["WI","Wisconsin"],["WY","Wyoming"],
];
const STATE_CODES = new Set(US_STATES.map(s => s[0]));

/* ---------- helpers ---------- */

function normalizeUrl(raw: string): string | null {
  let s = String(raw || "").trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try { return new URL(s).toString(); } catch { return null; }
}

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<string | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml" },
      signal: ctl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml/i.test(ct)) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function htmlToText(html: string): string {
  /* Drop scripts, styles, SVG blocks (common source of noise) before
     stripping remaining tags. Decode a handful of entities so phone
     numbers aren't broken by &nbsp; etc. */
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/ /g, " ");
  s = s.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return s;
}

function extractPhone(text: string): string | null {
  /* US phones. Prefer the FIRST match in the text (usually the main
     contact phone shown prominently). Normalize to xxx-xxx-xxxx. */
  const rx = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})\b/g;
  let m;
  const seen = new Set<string>();
  const out: string[] = [];
  while ((m = rx.exec(text)) !== null) {
    const norm = `${m[1]}-${m[2]}-${m[3]}`;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
    if (out.length >= 5) break;
  }
  return out[0] || null;
}

function extractEmail(text: string): string | null {
  /* Prefer business-looking addresses (info@, contact@, hello@, book@).
     Reject obvious junk: images, scripts, sentry/tracking endpoints,
     example.com, wixpress noise, etc. */
  const rx = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
  const found: string[] = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    const e = m[1].toLowerCase();
    if (/\.(png|jpg|jpeg|gif|svg|webp|js|css)$/i.test(e)) continue;
    if (/sentry|wixpress|example\.com|localhost|@(sentry|cloudflare)/i.test(e)) continue;
    if (!found.includes(e)) found.push(e);
    if (found.length >= 10) break;
  }
  if (!found.length) return null;
  const preferred = found.find(e => /^(info|contact|hello|book|appointments|appt|front(desk)?|office|admin|team)@/i.test(e));
  return preferred || found[0];
}

interface Address { street: string; suite: string; city: string; state: string; zip: string; }

function extractAddress(text: string): Address | null {
  /* Walk every line, look for one that ends with a 5-digit ZIP preceded
     by a 2-letter state. That line is the full address — the street +
     suite are usually on the same line or the preceding line.
     Pre-process: normalize " - " and " | " separators to commas so
     "501 S. Cherry St - Suite 310 - Glendale, CO 80246" parses the
     same as the comma-separated form. Dashes without spaces (ZIP+4,
     Route 66-A) are left alone. */
  const lines = text.split(/\n/).map(l => l.replace(/\s+[-|]\s+/g, ', ').trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const zipMatch = /([A-Z]{2})\s*,?\s+(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|United States|US))?\s*$/i.exec(line);
    if (!zipMatch) continue;
    const stateCode = zipMatch[1].toUpperCase();
    if (!STATE_CODES.has(stateCode)) continue;
    const zip = zipMatch[2];
    /* Pull the city off the end of the chunk before "ST ZIP" */
    const before = line.slice(0, zipMatch.index).trim().replace(/,\s*$/, "");
    let city = "";
    let streetBlock = "";
    const commaSplit = before.split(",").map(s => s.trim()).filter(Boolean);
    if (commaSplit.length >= 2) {
      city = commaSplit.pop()!;
      streetBlock = commaSplit.join(", ");
    } else if (commaSplit.length === 1) {
      /* City on previous line, street block on this line */
      city = ""; streetBlock = commaSplit[0];
    }
    /* If street block is empty, pull from the preceding line */
    if (!streetBlock && i > 0) streetBlock = lines[i-1];
    if (!city && i > 0) {
      /* Try to pull city off the previous line if that line looks like "City, ST" */
      const prev = lines[i-1];
      const prevCityMatch = /^(.*),\s*([A-Z]{2})\s*$/i.exec(prev);
      if (prevCityMatch) { city = prevCityMatch[1].trim(); }
    }
    /* Peel suite marker off the street */
    let street = streetBlock.trim();
    let suite = "";
    const suiteRx = /[,\s]+(ste|suite|unit|apt|apartment|room|rm|floor|fl|bldg|building|#)\s*([\w-]+)\s*$/i.exec(street);
    if (suiteRx) {
      suite = suiteRx[0].replace(/^[,\s]+/, "").trim();
      street = street.slice(0, suiteRx.index).replace(/,\s*$/, "").trim();
    }
    if (!street || street.length > 120) continue; /* likely garbage */
    return { street, suite, city, state: stateCode, zip };
  }
  return null;
}

async function tryPages(baseUrl: string): Promise<{text: string, pagesScraped: string[]}> {
  const scraped: string[] = [];
  let combined = "";
  const u = new URL(baseUrl);
  const candidates = [
    u.toString(),
    new URL("/contact", u).toString(),
    new URL("/contact-us", u).toString(),
    new URL("/about", u).toString(),
  ];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    seen.add(c);
    const html = await fetchWithTimeout(c);
    if (!html) continue;
    scraped.push(c);
    combined += "\n" + htmlToText(html);
    /* Stop early if we already have both a phone and an address with ZIP. */
    if (extractPhone(combined) && extractAddress(combined)) break;
  }
  return { text: combined, pagesScraped: scraped };
}

/* ---------- handler ---------- */

serve(async (req: Request): Promise<Response> => {
  const cors = corsHeaders(req);
  const json = (obj: any, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: cors });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  /* Auth — same gate the AI assistant uses. */
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Authorization required" }, 401);
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Not authenticated" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }
  const url = normalizeUrl(body?.url);
  if (!url) return json({ error: "A valid URL is required." }, 400);

  const warnings: string[] = [];

  const { text, pagesScraped } = await tryPages(url);
  if (!pagesScraped.length) {
    return json({
      phone: null, email: null, street: null, suite: null, city: null, state: null, zip: null,
      pages_scraped: [],
      warnings: ["Could not reach the website (timed out, blocked, or returned a non-HTML response)."],
    });
  }

  const phone = extractPhone(text);
  const email = extractEmail(text);
  const addr = extractAddress(text);
  if (!phone)   warnings.push("No phone number found in the page text.");
  if (!email)   warnings.push("No visible email on the page (many sites use contact forms).");
  if (!addr)    warnings.push("No full address with ZIP found in the page text.");

  return json({
    phone,
    email,
    street: addr?.street || null,
    suite:  addr?.suite  || null,
    city:   addr?.city   || null,
    state:  addr?.state  || null,
    zip:    addr?.zip    || null,
    pages_scraped: pagesScraped,
    warnings,
  });
});
