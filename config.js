/* =====================================================================
   Reflect CRM configuration
   Two environments — production and staging.

   Production is the default. To hit staging, append ?env=staging to the
   URL: https://dnarsete.github.io/reflect-co-crm/?env=staging
   A red banner appears across the top of the page whenever staging is
   active — you cannot accidentally confuse the two.

   Staging is where you test schema changes, new features, and risky
   pushes before promoting to production. See docs/STAGING.md.

   The publishable Supabase key is safe to expose in client code — real
   security comes from Row Level Security policies on the database.
   ===================================================================== */

/* ---------- PRODUCTION (default — real customer data) ---------- */
const PROD_CONFIG = {
  SUPABASE_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co',
  SUPABASE_KEY: 'sb_publishable_AVb4KY5cTUdtMbltuiRPUg_YOdfNVvi',

  AI_MODE: 'off',
  AI_FUNCTION_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co/functions/v1/ai-assistant',

  SHOPIFY_MODE: 'live',
  /* NOTE: the Edge Function's URL slug is 'bright-handler' — auto-generated
     at first deploy and immutable per Supabase. The display name was renamed
     to "shopify-sync" in the dashboard but the URL stayed. */
  SHOPIFY_SYNC_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co/functions/v1/bright-handler',

  INVITE_EMAILS: 'off',
  INVITE_FUNCTION_URL: 'https://clzpkjssxvmgvgloxehk.supabase.co/functions/v1/invite-rep'
};

/* ---------- STAGING (test data, safe to break) ----------
   Fill in the Supabase URL + key AFTER creating the staging project.
   Steps: docs/STAGING.md. Until this is filled in, ?env=staging just
   silently falls back to production so nothing breaks. */
const STAGING_CONFIG = {
  SUPABASE_URL: '',   /* e.g. 'https://xxxxxxxxxx.supabase.co' */
  SUPABASE_KEY: '',   /* e.g. 'sb_publishable_...' */

  /* All integrations start disabled in staging — enable only after you've
     wired the staging edge functions + secrets. */
  AI_MODE: 'off',
  AI_FUNCTION_URL: '',
  SHOPIFY_MODE: 'off',
  SHOPIFY_SYNC_URL: '',
  INVITE_EMAILS: 'off',
  INVITE_FUNCTION_URL: ''
};

/* ---------- Environment selection ----------
   Only three ways staging becomes active:
     1. ?env=staging in the URL query
     2. localStorage.reflect_env === 'staging' (persists across reloads)
     3. Hostname includes "staging" (e.g. staging.thereflectco.com if we ever host one)
   Otherwise production wins. */
(function pickEnv(){
  const params = new URLSearchParams(location.search);
  const queryEnv = params.get('env');
  const stored = (typeof localStorage !== 'undefined') ? localStorage.getItem('reflect_env') : null;
  const hostSays = /(^|\.)staging\./i.test(location.hostname);

  let env = 'prod';
  if (queryEnv === 'staging' || stored === 'staging' || hostSays) env = 'staging';
  if (queryEnv === 'prod') { env = 'prod'; try { localStorage.removeItem('reflect_env'); } catch(_){} }
  if (queryEnv === 'staging') { try { localStorage.setItem('reflect_env', 'staging'); } catch(_){} }

  /* Guard: if staging is selected but not configured, fall back to prod loudly */
  if (env === 'staging' && !STAGING_CONFIG.SUPABASE_URL) {
    console.warn('[REFLECT] Staging env requested but STAGING_CONFIG is empty — falling back to production. See docs/STAGING.md.');
    env = 'prod';
  }

  window.REFLECT_ENV = env;
  window.REFLECT_CONFIG = (env === 'staging') ? STAGING_CONFIG : PROD_CONFIG;

  /* Bright, unmistakable banner whenever we're on staging.
     Added on DOM-ready so it beats anything else the app renders. */
  if (env === 'staging') {
    const showBanner = () => {
      if (document.getElementById('reflect-env-banner')) return;
      const b = document.createElement('div');
      b.id = 'reflect-env-banner';
      b.textContent = '⚠ STAGING — test environment. Data here does NOT affect production. Click to exit.';
      b.title = 'Click to switch back to production';
      Object.assign(b.style, {
        position:'fixed', top:'0', left:'0', right:'0',
        background:'#c1272d', color:'#fff', textAlign:'center',
        padding:'6px 10px', fontWeight:'700', fontSize:'13px',
        letterSpacing:'0.02em', zIndex:'2147483647', cursor:'pointer',
        boxShadow:'0 2px 4px rgba(0,0,0,0.2)'
      });
      b.onclick = () => {
        try { localStorage.removeItem('reflect_env'); } catch(_){}
        const url = new URL(location.href);
        url.searchParams.delete('env');
        location.replace(url.toString());
      };
      document.body.prepend(b);
      /* Nudge the app content down so the banner doesn't overlap the header */
      document.body.style.paddingTop = (b.offsetHeight + 'px');
    };
    if (document.body) showBanner();
    else document.addEventListener('DOMContentLoaded', showBanner);
  }
})();
