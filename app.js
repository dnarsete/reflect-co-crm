/* =========================================================
   The Reflect Co — Rep CRM
   Supabase-backed SPA. Phase 2: real shared data + real auth.
   ========================================================= */

const { createClient } = window.supabase;
const sb = createClient(
  window.REFLECT_CONFIG.SUPABASE_URL,
  window.REFLECT_CONFIG.SUPABASE_KEY,
  { auth: { persistSession: true, autoRefreshToken: true } }
);

/* ---------- small utils ---------- */
const fmt$ = n => '$' + (Number(n||0)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const todayISO = () => new Date().toISOString().slice(0,10);
const startOfMonth = () => { const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10) };
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* US-only phone normalization. Called from onblur on every phone input.
   Accepts any input (dashes, parens, dots, spaces, leading +1) and rewrites
   to a canonical XXX-XXX-XXXX. 11 digits starting with 1 → drop the 1.
   Anything else → left as typed so we don't destroy in-progress entries. */
function normalizeUSPhone(inputEl){
  if(!inputEl) return;
  const raw = String(inputEl.value || '').trim();
  if(!raw) return;
  const digits = raw.replace(/\D/g, '');
  let ten = digits;
  if(digits.length === 11 && digits.startsWith('1')) ten = digits.slice(1);
  if(ten.length !== 10) return; /* leave weird lengths alone — user may still be typing */
  inputEl.value = ten.slice(0,3) + '-' + ten.slice(3,6) + '-' + ten.slice(6);
}
/* Expose globally so inline onblur can call it without adding another prefix. */
window.normalizeUSPhone = normalizeUSPhone;

/* US state list — used to render dropdowns everywhere the CRM asks for a
   state. A dropdown eliminates typos, kills the browser-autofill hijack
   that was defaulting empty state fields to the user's saved profile
   state (which showed up in Shopify as e.g. "Colorado" on an Arizona
   address), and drops the placeholder-vs-value confusion entirely. */
const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],
  ['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],
  ['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],
  ['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],
  ['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],
  ['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],
  ['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],
  ['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],
  ['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],
  ['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],
  ['UT','Utah'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],
  ['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
  ['PR','Puerto Rico'],['VI','US Virgin Islands'],['GU','Guam'],['AS','American Samoa'],['MP','Northern Mariana Islands'],
];
function usStateOptions(selectedCode){
  const sel = String(selectedCode || '').toUpperCase();
  return '<option value="">— select —</option>' +
    US_STATES.map(([c,n]) => `<option value="${c}" ${c===sel?'selected':''}>${c} — ${n}</option>`).join('');
}
window.usStateOptions = usStateOptions;

/* Return a signature data URL only if it's a valid inline image; empty string otherwise.
   Prevents XSS via an attacker-controlled orders.payment.signature (see security audit). */
const safeSignature = s => (typeof s === 'string' && /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=]+$/.test(s)) ? s : '';

/* Whitelist Shopify invoice URLs before rendering them or opening them.
   Blocks javascript:, data:, and cross-origin URLs an attacker could store on the order. */
const safeShopifyUrl = u => (typeof u === 'string' && /^https:\/\/([a-z0-9-]+\.)*(myshopify\.com|shopify\.com)\//i.test(u)) ? u : '';

/* Timezone helper — the business runs on America/Denver. Reports date bounds
   are interpreted here so a rep setting "today" gets a full Denver day rather
   than a UTC day that leaks 6-7 hours of the next Denver day. */
const tz = {
  ZONE: 'America/Denver',
  _offsetMinutes(atUtcMs){
    /* Difference (in minutes) between wall-clock in ZONE and UTC at a moment. */
    const d = new Date(atUtcMs);
    const zoneStr = d.toLocaleString('en-US', { timeZone: tz.ZONE });
    const utcStr  = d.toLocaleString('en-US', { timeZone: 'UTC' });
    return (new Date(zoneStr).getTime() - new Date(utcStr).getTime()) / 60000;
  },
  startOfDayUTC(dateStr){
    /* dateStr = 'YYYY-MM-DD'. Returns ISO UTC for 00:00:00 that day in ZONE. */
    const [y,m,d] = dateStr.split('-').map(Number);
    const naive = Date.UTC(y, m-1, d, 0, 0, 0);
    const off = tz._offsetMinutes(naive);
    return new Date(naive - off*60000).toISOString();
  },
  endOfDayUTC(dateStr){
    const [y,m,d] = dateStr.split('-').map(Number);
    const naive = Date.UTC(y, m-1, d, 23, 59, 59, 999);
    const off = tz._offsetMinutes(naive);
    return new Date(naive - off*60000).toISOString();
  }
};

/* In-memory caches (populated on login, refreshed on demand) */
const cache = {
  me: null,            // profiles row for the current user
  reps: [],            // all profiles (for admin dropdowns); reps see only themselves
  accountTypes: [],
  products: [],
  promotions: [],
  settings: {},
  accountTypeList(){ return cache.accountTypes.map(t=>t.name); }
};

/* ---------- UI helpers ---------- */
const ui = {
  modal(html){
    document.getElementById('modal').innerHTML = html;
    document.getElementById('modal-back').classList.add('show');
    /* Push a history entry so a trackpad two-finger swipe (browser
       back-gesture) fires popstate — the global listener at the bottom
       of this file catches it and closes the modal instead of letting
       the browser navigate away and wipe the form. */
    try { history.pushState({ reflectModal: 'primary' }, ''); } catch(_) {}
  },
  closeModal(){
    const el = document.getElementById('modal-back');
    if(!el || !el.classList.contains('show')) return;
    el.classList.remove('show');
    /* If our pushed state is still on top of the history stack, pop it
       so a subsequent back-gesture doesn't try to close nothing. The
       popstate listener sees the modal is already hidden and no-ops. */
    try { if(history.state?.reflectModal === 'primary') history.back(); } catch(_) {}
  },
  /* Secondary modal layer — overlays on top of the primary modal without
     replacing it. Used by the signature pad so the order form survives
     while a signature is being captured. */
  modal2(html){
    document.getElementById('modal2').innerHTML = html;
    document.getElementById('modal2-back').classList.add('show');
    try { history.pushState({ reflectModal: 'secondary' }, ''); } catch(_) {}
  },
  closeModal2(){
    const el = document.getElementById('modal2-back');
    if(!el || !el.classList.contains('show')) return;
    el.classList.remove('show');
    try { if(history.state?.reflectModal === 'secondary') history.back(); } catch(_) {}
  },
  toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.remove('hide');
    clearTimeout(ui._tt); ui._tt = setTimeout(()=>t.classList.add('hide'), 2400);
  },
  err(e){
    const msg = (e && (e.message || e.error_description || JSON.stringify(e))) || 'Something went wrong';
    console.error(e);
    ui.toast('⚠ ' + msg);
  },
  busy(on){ document.body.style.cursor = on ? 'progress' : ''; }
};

/* ---------- AUTH ---------- */
const auth = {
  async login(){
    const errEl = document.getElementById('auth-err');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    const pass  = (document.getElementById('auth-pass').value||'');
    if(!email || !pass){
      errEl.textContent = 'Enter email and password.'; errEl.classList.remove('hide'); return;
    }
    ui.busy(true);
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    ui.busy(false);
    if(error){
      errEl.innerHTML = 'Sign-in failed: '+esc(error.message)+'.<br>If you don\'t have a password, close this section and use <b>✉️ Email me a sign-in link</b> above.';
      errEl.classList.remove('hide');
      return;
    }
    /* Check if MFA escalation is required */
    if(await security.needsMFA()){
      const r = await security.challengeForMFA();
      if(!r.ok){
        await sb.auth.signOut();
        errEl.textContent = 'Two-factor required: ' + (r.error || 'verification failed');
        errEl.classList.remove('hide');
        return;
      }
    }
    errEl.classList.add('hide');
    /* Fresh sign-in resets the absolute-timeout clock so a stale 12h+ timestamp
       in localStorage doesn't insta-log-out the user seconds after login. */
    try { absoluteTimeout.reset(); } catch(_){}
    await boot();
  },
  async signup(){
    const errEl = document.getElementById('auth-err');
    const extras = document.getElementById('signup-extras');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    const pass  = (document.getElementById('auth-pass').value||'');
    if(!email){
      errEl.classList.remove('ok'); errEl.classList.add('err');
      errEl.textContent = 'Email is required.';
      errEl.classList.remove('hide');
      return;
    }
    const strength = auth.passwordStrength(pass);
    if(!strength.ok){
      errEl.classList.remove('ok'); errEl.classList.add('err');
      errEl.textContent = strength.msg;
      errEl.classList.remove('hide');
      return;
    }
    /* Stage 1: expand the form to collect contact info */
    if(extras.classList.contains('hide')){
      extras.classList.remove('hide');
      document.getElementById('auth-signin-btn').classList.add('hide');
      document.getElementById('auth-signup-btn').textContent = 'Complete sign-up';
      errEl.classList.add('hide');
      setTimeout(()=>document.getElementById('su-name')?.focus(), 50);
      return;
    }
    /* Stage 2: validate required fields and submit */
    const name = (document.getElementById('su-name').value||'').trim();
    const cell = (document.getElementById('su-cell').value||'').trim();
    if(!name || !cell){
      errEl.classList.remove('ok'); errEl.classList.add('err');
      errEl.textContent = 'Full name and cell phone are required.';
      errEl.classList.remove('hide');
      return;
    }
    const metadata = {
      name,
      cell,
      company: (document.getElementById('su-company').value||'').trim(),
      street:  (document.getElementById('su-street').value||'').trim(),
      city:    (document.getElementById('su-city').value||'').trim(),
      state:   (document.getElementById('su-state').value||'').trim(),
      zip:     (document.getElementById('su-zip').value||'').trim()
    };
    ui.busy(true);
    const { error } = await sb.auth.signUp({ email, password: pass, options:{ data: metadata } });
    ui.busy(false);
    if(error){
      errEl.classList.remove('ok'); errEl.classList.add('err');
      errEl.textContent = 'Sign-up failed: '+error.message;
      errEl.classList.remove('hide');
      return;
    }
    errEl.classList.remove('err'); errEl.classList.add('ok');
    errEl.classList.remove('hide');
    errEl.innerHTML = 'Account created. Click <b>Sign in</b> with the same credentials.';
    /* Collapse the extras + restore the Sign-in button */
    extras.classList.add('hide');
    document.getElementById('auth-signin-btn').classList.remove('hide');
    document.getElementById('auth-signup-btn').textContent = 'Create account';
  },
  async logout(){
    absoluteTimeout.clear();
    await sb.auth.signOut();
    location.reload();
  },
  async resetPassword(){
    const errEl = document.getElementById('auth-err');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    if(!email){
      errEl.textContent = 'Enter your email above, then click "Forgot password?".'; errEl.classList.remove('hide'); return;
    }
    ui.busy(true);
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname + '#reset'
    });
    ui.busy(false);
    if(error){ errEl.textContent = 'Reset failed: '+error.message; errEl.classList.remove('hide'); return; }
    errEl.classList.remove('err'); errEl.classList.add('ok'); errEl.classList.remove('hide');
    errEl.innerHTML = '✉️ Check your inbox ('+esc(email)+') for a reset link. Open it on this device to set a new password.';
  },
  /* Passwordless sign-in via magic link. Rep enters their email, clicks the
     button, then clicks the link that lands in their inbox → auto signed in.
     Uses Supabase's built-in OTP flow with the email-link format.
     Requires "Email" auth provider enabled in the Supabase project (default). */
  async magicLink(){
    const errEl = document.getElementById('auth-err');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    if(!email){
      errEl.textContent = 'Enter your email above, then click "Email me a sign-in link".';
      errEl.classList.remove('hide'); errEl.classList.remove('ok'); errEl.classList.add('err');
      return;
    }
    ui.busy(true);
    /* Pre-check: skip the actual signInWithOtp call if the email isn't in
       our system. Prevents a mistyped address from consuming Supabase's
       per-IP rate limit — a shared IP (co-working, cafe) with one typo
       could otherwise lock every rep out for 60 seconds. */
    try {
      const preflight = await sb.rpc('email_exists', { p_email: email });
      if(preflight.error === null && preflight.data === false){
        ui.busy(false);
        errEl.textContent = "This email isn't in our system yet. Ask your admin to add you from the Reps tab — you'll get a fresh invite link.";
        errEl.classList.remove('hide'); errEl.classList.remove('ok'); errEl.classList.add('err');
        return;
      }
      /* If the RPC doesn't exist yet (migration not run), fall through to the
         real signInWithOtp call — Supabase will still gate on shouldCreateUser. */
    } catch(_) { /* fall through */ }
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: location.origin + location.pathname,
        /* shouldCreateUser: false means the link will only work for existing
           users. Set true to allow first-time sign-in via magic link — but
           note: for a rep-first CRM you probably want admin to add reps
           explicitly, so keep this false. */
        shouldCreateUser: false
      }
    });
    ui.busy(false);
    if(error){
      /* Translate Supabase's cryptic errors into actionable messages. */
      const raw = String(error.message || '');
      let human = 'Sign-in link failed: ' + raw;
      if(/Signups not allowed|not authorized/i.test(raw)){
        human = "This email isn't in our system yet. Ask your admin to add you from the Reps tab — you'll get a fresh invite link.";
      } else if(/security purposes|only request this after|rate limit|too many|for security/i.test(raw)){
        /* Extract the seconds-to-wait if Supabase told us. */
        const m = /after (\d+) seconds?/i.exec(raw);
        const wait = m ? m[1] : '60';
        human = `A sign-in link was just sent — check your inbox (and spam folder). If you need a new one, wait ${wait} seconds and click again. Old links are still valid for up to 1 hour.`;
      }
      errEl.textContent = human;
      errEl.classList.remove('hide'); errEl.classList.remove('ok'); errEl.classList.add('err');
      return;
    }
    errEl.classList.remove('err'); errEl.classList.add('ok'); errEl.classList.remove('hide');
    errEl.innerHTML = '✉️ Sign-in link sent to <b>'+esc(email)+'</b>. Open it on this device to sign in. Link expires in 1 hour.';
  },
  async applyRecoveryFlow(){
    /* Fires ONLY for password-reset links (type=recovery) or the manual
       #reset hash. Magic-link and invite links also carry access_token
       in the hash, but they must NOT trigger this modal — reps invited
       via magic link don't have (or need) a password. */
    const isRecovery = /(^|[#&])type=recovery(&|$)/.test(location.hash) || location.hash === '#reset';
    if(!isRecovery) return;
    /* SECURITY: hide both auth screen and app so the dashboard/data is
       not visible under the modal. Restored on submit via location.reload(). */
    auth._recoveryPending = true;
    document.getElementById('auth')?.classList.add('hide');
    document.getElementById('app')?.classList.add('hide');
    setTimeout(()=>{
      ui.modal(`
        <h3>Set a new password</h3>
        <p class="muted" style="font-size:13px;margin:0 0 12px">Choose a strong password — at least 12 characters, or 10+ with letters, numbers, and a symbol.</p>
        <div id="pwr-err" class="alert err hide" style="margin-bottom:10px"></div>
        <div style="margin-bottom:10px">
          <label>New password</label>
          <input id="pwr-new" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false"/>
        </div>
        <div style="margin-bottom:10px">
          <label>Confirm password</label>
          <input id="pwr-conf" type="password" autocomplete="new-password" autocapitalize="none" spellcheck="false"/>
        </div>
        <div class="row" style="gap:8px">
          <button class="icon-btn primary" onclick="auth.submitRecovery()">Set password</button>
        </div>
      `);
      setTimeout(()=>document.getElementById('pwr-new')?.focus(), 50);
    }, 200);
  },
  async submitRecovery(){
    const errEl = document.getElementById('pwr-err');
    const show = (m)=>{ errEl.textContent = m; errEl.classList.remove('hide'); };
    const p1 = document.getElementById('pwr-new').value || '';
    const p2 = document.getElementById('pwr-conf').value || '';
    if(p1 !== p2){ show('Passwords do not match.'); return; }
    const check = auth.passwordStrength(p1);
    if(!check.ok){ show(check.msg); return; }
    ui.busy(true);
    const { error } = await sb.auth.updateUser({ password: p1 });
    ui.busy(false);
    if(error){ show('Failed: '+error.message); return; }
    ui.closeModal();
    alert('Password updated. You are now signed in.');
    history.replaceState(null, '', location.pathname);
    location.reload();
  },
  /* Password policy: min 14 chars, or 10+ with ≥3 of {upper, lower, digit, symbol}.
     Also rejects the top few common patterns. Server-side breach checking is done
     by Supabase Auth (see HARDENING.md for the dashboard toggle). */
  passwordStrength(pw){
    pw = String(pw||'');
    if(pw.length < 10) return { ok:false, msg:'Password must be at least 10 characters.' };
    if(pw.length >= 12) return { ok:true };
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
    if(classes < 3) return { ok:false, msg:'Short passwords need 3 of: lowercase, uppercase, number, symbol. Or use 12+ characters.' };
    if(/^password|^123456|^qwerty|^letmein|^admin/i.test(pw)) return { ok:false, msg:'That password is too common. Pick something less predictable.' };
    return { ok:true };
  },
  user(){ return cache.me; },
  isAdmin(){ return !!cache.me && cache.me.role === 'admin'; },
  repId(){ return cache.me ? cache.me.rep_id : null; }
};

/* ---------- DATA: profiles ---------- */
const profiles = {
  async loadMe(uid){
    const { data, error } = await sb.from('profiles').select('*').eq('id', uid).single();
    if(error) throw error;
    cache.me = data;
    return data;
  },
  async loadReps(){
    /* reps_public() is a SECURITY DEFINER RPC that returns:
         - the caller's own row (for reps — zero visibility into other reps)
         - all rows (for admins — needed for rep management, reports, messaging).
       PII columns (cell, address, tax_id, commission) are never in this result;
       admins can get those via loadReps → cache.repsFull below.

       Falls back to a self-only query if the RPC hasn't been created yet
       (i.e. supabase/security-hardening.sql not yet run — see HARDENING.md).
       The fallback preserves the "reps see only themselves" behavior so the
       lockdown is effective even before the SQL migration is run. */
    let { data, error } = await sb.rpc('reps_public');
    if(error && /does not exist|not found|schema cache/i.test(error.message||'')){
      const uid = (await sb.auth.getUser()).data.user?.id;
      const isAdmin = !!(cache.me && cache.me.role === 'admin');
      const q = isAdmin
        ? await sb.from('profiles').select('id, rep_id, name, email, role, disabled, territory').order('name')
        : await sb.from('profiles').select('id, rep_id, name, email, role, disabled, territory').eq('id', uid);
      data = q.data; error = q.error;
    }
    if(error) throw error;
    cache.reps = data || [];
    /* Admins also fetch the full rows so commission math and management views work. */
    if(cache.me && cache.me.role === 'admin'){
      const full = await sb.from('profiles').select('*').order('name');
      cache.repsFull = full.data || [];
    } else {
      cache.repsFull = [];
    }
  },
  /* Commission % lookup. Only admins ever see other reps' commissions;
     a rep can only look up their own (which comes from cache.me). */
  commissionFor(repId){
    if(!repId) return 0;
    if(cache.repsFull && cache.repsFull.length){
      const f = cache.repsFull.find(r=>r.rep_id===repId);
      if(f && typeof f.commission === 'number') return f.commission;
    }
    if(cache.me && cache.me.rep_id === repId && typeof cache.me.commission === 'number'){
      return cache.me.commission;
    }
    return 0;
  }
};

/* ---------- DATA: reference (types, products, promos, settings) ---------- */
const ref = {
  async loadAll(){
    /* Products query tries the strict "live only" filter first (deleted_at
       IS NULL AND archived_at IS NULL). If the DB doesn't have those columns
       yet — because supabase/trash-system.sql (or products-trash.sql) hasn't
       been run — fall back to a plain select so the app still boots. */
    const productsQ = async () => {
      let r = await sb.from('products').select('*').is('deleted_at', null).is('archived_at', null).order('name');
      if(r.error && /archived_at/i.test(r.error.message||'')){
        r = await sb.from('products').select('*').is('deleted_at', null).order('name');
      }
      if(r.error && /deleted_at/i.test(r.error.message||'')){
        r = await sb.from('products').select('*').order('name');
      }
      return r;
    };
    const [t,p,pr,s] = await Promise.all([
      sb.from('account_types').select('*').order('sort_order'),
      productsQ(),
      sb.from('promotions').select('*').order('code'),
      sb.from('settings').select('*')
    ]);
    if(t.error) throw t.error;
    if(p.error) throw p.error;
    if(pr.error) throw pr.error;
    if(s.error) throw s.error;
    cache.accountTypes = t.data || [];
    cache.products = p.data || [];
    cache.promotions = pr.data || [];
    cache.settings = {};
    (s.data||[]).forEach(r => cache.settings[r.key] = r.value);
  },
  shipDefault(){ return Number(cache.settings.shipping_default ?? 30); },
  taxRateDefault(){ return Number(cache.settings.tax_rate_default ?? 0.0881); },
  taxLabelDefault(){ return String(cache.settings.tax_label_default ?? 'Colorado + Denver County'); },
  highDiscPct(){ return Number(cache.settings.high_discount_alert_pct ?? 20); },
  reorderDays(){ return Number(cache.settings.reorder_due_days ?? 45); },
  lowStock(){ return Number(cache.settings.low_stock_threshold ?? 25); },
  company(){ return cache.settings.company || {name:'The Reflect Co', website:'thereflectco.com', address:''} }
};

/* ---------- NAV ---------- */
const nav = {
  go(view){
    document.querySelectorAll('.view').forEach(v=>v.classList.add('hide'));
    document.getElementById('view-'+view).classList.remove('hide');
    document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
    if(view==='dashboard') dashboard.render();
    if(view==='accounts')  accounts.render();
    if(view==='orders')    orders.render();
    if(view==='promos')    promos.render();
    if(view==='reports')   reports.init();
    if(view==='forecast')  forecasts.render();
    if(view==='profile')   profile.render();
    if(view==='reps')      adminPanel.renderRepsAndInvites();
    if(view==='materials') materials.render();
    if(view==='cs')        cs.init();
    if(view==='admin')     adminPanel.render();
  }
};

/* ---------- DASHBOARD ---------- */
const dashboard = {
  async render(){
    document.getElementById('who').textContent = (cache.me.name || cache.me.email) + (auth.isAdmin()?' · Admin':' · Rep');
    document.getElementById('role-pill').textContent = auth.isAdmin()?'Admin':'Rep';

    /* Test-mode banner — persistent, top of screen, unmistakable. Only
       renders once; kept on every render so it survives view changes. */
    if(cache.me && cache.me.test_mode && cache.me.role !== 'admin'){
      if(!document.getElementById('reflect-testmode-banner')){
        const b = document.createElement('div');
        b.id = 'reflect-testmode-banner';
        b.textContent = '🧪 TEST MODE — orders you finalize will NOT push to Shopify. No invoices. No emails. No real transactions.';
        Object.assign(b.style, {
          position:'sticky', top:'0', left:'0', right:'0',
          background:'#8a5a00', color:'#fff', textAlign:'center',
          padding:'6px 10px', fontWeight:'600', fontSize:'12px',
          letterSpacing:'0.02em', zIndex:'2147483646',
          borderBottom:'2px solid #d4a017'
        });
        document.body.prepend(b);
      }
    } else {
      const existing = document.getElementById('reflect-testmode-banner');
      if(existing) existing.remove();
    }

    /* counts */
    const [accCount, mtdOrders] = await Promise.all([
      accounts.count(),
      orders.listMTD()
    ]);
    const rev = (mtdOrders||[]).reduce((s,o)=>s+Number(o.total||0),0);
    const comm = (mtdOrders||[]).reduce((s,o)=>{
      const repPct = profiles.commissionFor(o.rep_id)/100;
      return s + (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    }, 0);
    document.getElementById('kpi-accounts').textContent = accCount;
    document.getElementById('kpi-orders').textContent   = mtdOrders.length;
    document.getElementById('kpi-rev').textContent      = fmt$(rev);
    document.getElementById('kpi-comm').textContent     = fmt$(comm);

    /* alerts */
    const alertsEl = document.getElementById('alerts');
    const alerts = [];

    /* Admin-only: MFA enrollment nudge. Persistent until MFA is enrolled. */
    if(auth.isAdmin()){
      try{
        const factors = await security.listFactors();
        if(!factors.all.length){
          alerts.push({
            lvl:'warn', html:true,
            text:`🔐 <b>Two-factor authentication is required for admin accounts.</b> Tap <a href="#" onclick="security.openSettings();return false" style="color:var(--brand);text-decoration:underline">🔒 Security</a> to enroll (~60 sec).`
          });
        }
      } catch(_){}
    }

    /* Admin-only: low-stock product alerts. Reps don't see inventory levels. */
    if(auth.isAdmin()){
      const lowStock = cache.products.filter(p=>p.stock<=ref.lowStock());
      lowStock.forEach(p=>alerts.push({lvl:'warn', text:`Low stock — ${p.name} (${p.stock} left)`, html:false}));
    }

    /* Admin messages: todos, promos, announcements, 1-on-1 messages */
    try{
      const mr = await sb.from('rep_messages').select('id,kind,title,body,recipient_rep_id,created_at')
        .order('created_at',{ascending:false}).limit(10);
      if(!mr.error){
        (mr.data||[]).forEach(m=>{
          const icon = {announcement:'📢', promo:'🏷', todo:'✅', message:'💬'}[m.kind] || '📌';
          const lvl  = m.kind === 'todo' ? 'warn' : (m.kind === 'promo' ? 'ok' : 'info');
          const titleHtml = m.title ? `<b>${esc(m.title)}</b> · ` : '';
          alerts.push({ lvl, html:true, text: `${icon} ${titleHtml}${esc(m.body)}` });
        });
      }
    } catch(_){}

    /* Reorder + new-account alerts (relevant for reps and admin).
       Perf: fetch the most-recent placed_at for all 30 accounts in ONE query
       instead of 30 sequential lastForAccount() calls. */
    const myAccts = await accounts.list();
    const window = myAccts.slice(0, 30);
    const ids = window.map(a => a.id);
    const lastByAcct = {};
    if(ids.length){
      const or = await sb.from('orders')
        .select('account_id, placed_at')
        .in('account_id', ids)
        .not('is_test','is',true)
        .order('placed_at', { ascending: false });
      if(!or.error && or.data){
        or.data.forEach(o => {
          if(!lastByAcct[o.account_id]) lastByAcct[o.account_id] = o.placed_at;
        });
      }
    }
    for(const a of window){
      const last = lastByAcct[a.id];
      if(last){
        const days = Math.floor((Date.now()-new Date(last))/86400000);
        if(days>=ref.reorderDays()) alerts.push({lvl:'info', html:false, text:`${a.business_name||a.account_number} due for reorder (${days}d since last)`});
      } else {
        const days = Math.floor((Date.now()-new Date(a.created_at))/86400000);
        if(days>14) alerts.push({lvl:'info', html:false, text:`${a.business_name||a.account_number} has no orders yet (${days}d old)`});
      }
    }
    alertsEl.innerHTML = alerts.length
      ? alerts.slice(0,10).map(a=>{
          const lvlCls = a.lvl==='warn' ? 'warn' : (a.lvl==='ok' ? 'ok' : '');
          const content = a.html ? a.text : esc(a.text);
          return `<div class="alert ${lvlCls}">${content}</div>`;
        }).join('')
      : '<div class="muted">All clear.</div>';
  }
};

/* ---------- ACCOUNTS ---------- */
const accounts = {
  /* Safety net for reps who paste (or browser-autofill) a full comma-
     separated address into the Street field ("3300 E 1st Ave, 400,
     Denver, CO, 80206"). If City/State/ZIP are empty AND the street
     text looks like a multi-part address, split it into the right
     fields. Prefix `b` = business address, `l` = billing address. */
  _splitAddressIfPasted(prefix){
    const streetEl = document.getElementById(`f-${prefix}-street`);
    const suiteEl  = document.getElementById(`f-${prefix}-suite`);
    const cityEl   = document.getElementById(`f-${prefix}-city`);
    const stateEl  = document.getElementById(`f-${prefix}-state`);
    const zipEl    = document.getElementById(`f-${prefix}-zip`);
    if(!streetEl || !cityEl || !stateEl || !zipEl) return;
    /* Only auto-split if the other fields are empty — otherwise the rep
       already filled them and we shouldn't touch anything. */
    if(cityEl.value.trim() || stateEl.value.trim() || zipEl.value.trim()) return;
    const raw = streetEl.value.trim();
    if(!raw || raw.split(',').length < 3) return;
    /* Expected shapes:
         "123 Main St, Denver, CO 80210"
         "123 Main St, Ste 4, Denver, CO 80210"
         "123 Main St, 400, Denver, CO, 80206"           (commas around state)
         "123 Main St, Denver, CO, 80210, USA"           (country suffix)
       Strategy: strip a trailing country if present, then peel off zip,
       state, city from the end. Anything left over is street (+ suite). */
    let parts = raw.split(',').map(s => s.trim()).filter(Boolean);
    if(/^(usa|united states|us)$/i.test(parts[parts.length-1] || '')) parts.pop();
    if(parts.length < 3) return;
    /* Last chunk is zip (may be "80210" or "80210-1234"). */
    let zip = '';
    const lastZipMatch = /^(\d{5})(?:-\d{4})?$/.exec(parts[parts.length-1] || '');
    if(lastZipMatch){ zip = lastZipMatch[0]; parts.pop(); }
    else {
      /* Sometimes state and zip end up together: "CO 80210" */
      const combined = /^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/i.exec(parts[parts.length-1] || '');
      if(combined){
        stateEl.value = combined[1].toUpperCase();
        zipEl.value = combined[2];
        parts.pop();
        cityEl.value = parts[parts.length-1] || '';
        parts.pop();
        streetEl.value = parts.join(', ');
        if(parts.length >= 2 && !suiteEl?.value) {
          /* Second-to-last remaining part is likely a suite */
          suiteEl.value = parts[parts.length-1];
          streetEl.value = parts.slice(0, -1).join(', ');
        }
        return;
      }
      return;
    }
    if(parts.length < 2) return;
    /* Next chunk is state — 2-letter US code */
    if(/^[A-Za-z]{2}$/.test(parts[parts.length-1] || '')){
      stateEl.value = parts.pop().toUpperCase();
      zipEl.value = zip;
    } else { return; }
    if(!parts.length) return;
    /* Next chunk is city */
    cityEl.value = parts.pop();
    /* Whatever's left is street; if there are multiple, the LAST leftover
       is probably a suite number and everything before it is street. */
    if(parts.length >= 2 && !suiteEl?.value){
      suiteEl.value = parts.pop();
    }
    streetEl.value = parts.join(', ');
  },

  async count(){
    const { count, error } = await sb.from('accounts').select('*', { count:'exact', head:true });
    if(error){ ui.err(error); return 0; }
    return count || 0;
  },
  async list(){
    const { data, error } = await sb.from('accounts').select('*').order('created_at',{ascending:false});
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async render(){
    /* type filter */
    const tf = document.getElementById('acc-type-filter');
    const cur = tf.value;
    tf.innerHTML = '<option value="">All types</option>' + cache.accountTypeList().map(t=>`<option ${cur===t?'selected':''}>${t}</option>`).join('');

    const q = (document.getElementById('acc-search').value||'').toLowerCase();
    const type = tf.value;
    const list = (await accounts.list()).filter(a=>{
      const hay = [a.business_name,a.billing_name,a.business_address,a.email,a.account_number].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!type || a.type===type);
    });

    const wrap = document.getElementById('acc-list');
    if(!list.length){ wrap.innerHTML='<div class="muted">No accounts yet. Tap "+ New".</div>'; return; }
    wrap.innerHTML = list.map(a=>`
      <div class="list-item">
        <div class="grow">
          <div class="title">${esc(a.business_name||'(unnamed)')} <span class="badge info">${esc(a.type||'—')}</span></div>
          <div class="meta">${esc(a.account_number)} · ${esc(a.business_address||'no address')} · ${esc(a.email||'')}</div>
        </div>
        <button class="icon-btn" onclick="accounts.open('${a.id}')">Open</button>
      </div>
    `).join('');
  },
  async openNew(){ accounts.open(null) },
  async open(id){
    let a = null;
    if(id){
      const r = await sb.from('accounts').select('*').eq('id', id).single();
      if(r.error){ ui.err(r.error); return; }
      a = r.data;
    }
    const isNew = !a;
    const acc = a || {
      type:'Medical Spa', business_name:'', billing_name:'', business_address:'', billing_address:'',
      business_street:'', business_suite:'', business_city:'', business_state:'', business_zip:'',
      billing_street:'', billing_suite:'', billing_city:'', billing_state:'', billing_zip:'',
      billing_same_as_business:false,
      email:'', cell:'', business_phone:'', website:'', sales_tax_license:'', sales_tax_state:'',
      tax_exempt:false, opt_in:true, notes:[], rep_id: auth.repId()
    };
    /* Backfill new structured fields from the legacy single-line
       business_address / billing_address if the new fields are empty.
       Best-effort: whole string dropped into "street" so admin sees
       the data and can split it themselves. */
    if(!acc.business_street && acc.business_address){ acc.business_street = acc.business_address; }
    if(!acc.billing_street && acc.billing_address){ acc.billing_street = acc.billing_address; }
    const typeOpts = cache.accountTypeList().map(t=>`<option ${acc.type===t?'selected':''}>${t}</option>`).join('');
    const repOpts = cache.reps.length
      ? cache.reps.map(r=>`<option value="${esc(r.rep_id||'')}" ${acc.rep_id===r.rep_id?'selected':''}>${esc(r.name||r.email)} (${esc(r.rep_id||'no rep id')})</option>`).join('')
      : `<option>${esc(auth.repId()||'')}</option>`;
    ui.modal(`
      <h3>${isNew?'New account':'Account · '+esc(acc.account_number||'')}</h3>
      <div class="grid-2">
        <div><label>Business name</label><input id="f-bn" value="${esc(acc.business_name)}"/></div>
        <div><label>Account type</label><select id="f-type">${typeOpts}</select></div>
        <div><label>Billing responsible person</label><input id="f-rn" value="${esc(acc.billing_name)}"/></div>
        <div><label>Account email</label><input id="f-em" type="email" value="${esc(acc.email)}"/></div>
        <div><label>Cell (responsible)</label><input id="f-cell" type="tel" autocomplete="tel" inputmode="tel" placeholder="555-555-5555" value="${esc(acc.cell)}" onblur="normalizeUSPhone(this)"/></div>
        <div><label>Business phone</label><input id="f-bp" type="tel" autocomplete="tel" inputmode="tel" placeholder="555-555-5555" value="${esc(acc.business_phone)}" onblur="normalizeUSPhone(this)"/></div>
        <div style="grid-column:1/-1"><label>Website</label><input id="f-web" type="url" value="${esc(acc.website||'')}" placeholder="https://…" autocapitalize="none" spellcheck="false"/></div>
      </div>

      <!-- Business address block -->
      <div style="margin-top:12px;padding:10px;border:1px solid var(--line);background:var(--panel-2);border-radius:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">📍 Business address</div>
        <div class="grid-2" style="grid-template-columns:2fr 1fr">
          <div><label>Street address</label><input id="f-b-street" value="${esc(acc.business_street||'')}" autocomplete="address-line1" onblur="accounts._splitAddressIfPasted('b')"/></div>
          <div><label>Suite / Apt / Unit</label><input id="f-b-suite" value="${esc(acc.business_suite||'')}" autocomplete="address-line2" placeholder="Ste 202"/></div>
        </div>
        <div class="grid-3" style="margin-top:8px">
          <div><label>City</label><input id="f-b-city" value="${esc(acc.business_city||'')}" autocomplete="address-level2"/></div>
          <div><label>State</label><select id="f-b-state" autocomplete="address-level1">${usStateOptions(acc.business_state)}</select></div>
          <div><label>ZIP</label><input id="f-b-zip" value="${esc(acc.business_zip||'')}" autocomplete="postal-code"/></div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px">🇺🇸 United States</div>
      </div>

      <!-- "Same as" checkbox + billing block -->
      <div style="margin-top:8px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:8px 10px;background:rgba(80,200,120,0.08);border:1px solid var(--line);border-radius:6px">
          <input id="f-billing-same" type="checkbox" ${acc.billing_same_as_business?'checked':''} style="width:auto" onchange="accounts.toggleBillingSame(this.checked)"/>
          <span><b>Billing address is the same as business address</b> — auto-fills the billing block below when checked.</span>
        </label>
      </div>

      <div id="f-billing-block" style="margin-top:8px;padding:10px;border:1px solid var(--line);background:var(--panel-2);border-radius:8px">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px">💳 Billing address</div>
        <div class="grid-2" style="grid-template-columns:2fr 1fr">
          <div><label>Street address</label><input id="f-l-street" value="${esc(acc.billing_street||'')}" autocomplete="address-line1" onblur="accounts._splitAddressIfPasted('l')"/></div>
          <div><label>Suite / Apt / Unit</label><input id="f-l-suite" value="${esc(acc.billing_suite||'')}" autocomplete="address-line2" placeholder="Ste 202"/></div>
        </div>
        <div class="grid-3" style="margin-top:8px">
          <div><label>City</label><input id="f-l-city" value="${esc(acc.billing_city||'')}" autocomplete="address-level2"/></div>
          <div><label>State</label><select id="f-l-state" autocomplete="address-level1">${usStateOptions(acc.billing_state)}</select></div>
          <div><label>ZIP</label><input id="f-l-zip" value="${esc(acc.billing_zip||'')}" autocomplete="postal-code"/></div>
        </div>
        <div class="muted" style="font-size:11px;margin-top:6px">🇺🇸 United States</div>
      </div>

      <div class="grid-2" style="margin-top:12px">
        <div><label>Sales tax license #</label><input id="f-stl" value="${esc(acc.sales_tax_license)}"/></div>
        <div><label>License state</label><select id="f-sts">${usStateOptions(acc.sales_tax_state)}</select></div>
        <div><label>Tax exempt</label>
          <label class="toggle"><input type="checkbox" id="f-exempt" ${acc.tax_exempt?'checked':''}/> <span>Do not charge sales tax</span></label>
        </div>
        <div><label>Opt-in to comms</label>
          <select id="f-opt"><option value="true" ${acc.opt_in?'selected':''}>Opted in</option><option value="false" ${!acc.opt_in?'selected':''}>Opted out</option></select>
        </div>
        <div><label>Assigned rep</label><select id="f-rep" ${auth.isAdmin()?'':'disabled'}>${repOpts}</select></div>
      </div>
      ${!isNew ? `
      <div class="card" style="margin-top:10px">
        <h2>Call / visit log</h2>
        <p class="muted" style="font-size:12px;margin:0 0 8px">${auth.isAdmin() ? 'Admin: full control over all notes.' : 'You can edit or delete your own notes for 24 hours after posting. After that they are locked.'}</p>
        <div id="acc-notes"></div>
        <div class="row" style="gap:8px;margin-top:8px">
          <input id="note-text" placeholder="Add a note (call, visit, geo check-in…)" onkeydown="if(event.key==='Enter')accounts.addNote('${acc.id}')"/>
          <button class="icon-btn" onclick="accounts.addNote('${acc.id}')">Add</button>
        </div>
      </div>` : ''}
      ${!isNew && acc.shopify_customer_id ? `
      <div style="margin-top:12px;padding:10px;border:1px solid var(--line);background:rgba(212,160,23,0.06);border-radius:6px;font-size:12px">
        <div style="margin-bottom:6px"><b>Shopify link:</b> customer ID <code>${esc(acc.shopify_customer_id)}</code> · <span class="muted">If Shopify returns "Record is invalid" on this account's orders, the customer may have been deleted or merged in Shopify. Reset the link to fall back to email-based checkout.</span></div>
        <button class="icon-btn ghost" onclick="accounts.resetShopifyLink('${acc.id}')">🔗 Reset Shopify link</button>
      </div>` : ''}
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="accounts.save('${acc.id||''}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="accounts.remove('${acc.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
    /* Trigger the "same as" initial state — if the checkbox is
       checked on open, disable the billing fields visually. */
    if(document.getElementById('f-billing-same')?.checked){
      accounts.toggleBillingSame(true);
    }
    if(!isNew){
      accounts.renderNotes(acc.id);
    }
  },
  async renderNotes(accountId){
    const nw = document.getElementById('acc-notes'); if(!nw) return;
    const { data, error } = await sb.from('account_notes')
      .select('id, account_id, author_id, rep_id, text, created_at, updated_at')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if(error){ nw.innerHTML = '<div class="muted">Could not load notes.</div>'; ui.err(error); return; }
    const notes = data || [];
    if(!notes.length){ nw.innerHTML = '<div class="muted">No notes yet.</div>'; return; }
    const me = (await sb.auth.getUser()).data.user;
    const isAdmin = auth.isAdmin();
    const profileById = {}; (cache.reps||[]).forEach(p => profileById[p.id] = p);
    nw.innerHTML = notes.map(n => {
      const ageMs = Date.now() - new Date(n.created_at).getTime();
      const isMine = me && n.author_id === me.id;
      const withinWindow = ageMs < 24*60*60*1000;
      const canEdit = isAdmin || (isMine && withinWindow);
      const prof = profileById[n.author_id];
      const author = prof?.name || prof?.email || (n.author_id ? 'Unknown user' : 'Legacy note');
      const when = new Date(n.created_at).toLocaleString();
      const edited = (new Date(n.updated_at).getTime() - new Date(n.created_at).getTime() > 5000)
        ? ` · edited ${new Date(n.updated_at).toLocaleString()}` : '';
      let statusBadge = '';
      if(isMine && withinWindow){
        const hrsLeft = Math.max(0, 24 - ageMs/3600000);
        statusBadge = ` <span class="badge warn">${hrsLeft.toFixed(1)}h left to edit</span>`;
      } else if(isMine && !withinWindow){
        statusBadge = ` <span class="badge">🔒 locked</span>`;
      } else if(isAdmin && !isMine){
        statusBadge = ` <span class="badge info">admin override</span>`;
      }
      const safeText = esc(n.text).replace(/\n/g,'<br>');
      const editBtn = canEdit
        ? `<button class="icon-btn ghost" onclick="accounts.editNote('${n.id}','${accountId}')">Edit</button>` : '';
      const delBtn  = canEdit
        ? `<button class="icon-btn danger" onclick="accounts.deleteNote('${n.id}','${accountId}')">✕</button>` : '';
      return `<div class="list-item">
        <div class="grow">
          <div>${safeText}</div>
          <div class="meta">${esc(author)} · ${esc(when)}${edited}${statusBadge}</div>
        </div>
        ${editBtn}${delBtn}
      </div>`;
    }).join('');
  },
  async addNote(accountId){
    const text = (document.getElementById('note-text').value||'').trim();
    if(!text) return;
    const userId = (await sb.auth.getUser()).data.user.id;
    const r = await sb.from('account_notes').insert({
      account_id: accountId,
      text,
      author_id: userId,
      rep_id: auth.repId() || null
    });
    if(r.error){ ui.err(r.error); return; }
    document.getElementById('note-text').value = '';
    accounts.renderNotes(accountId);
    ui.toast('Note saved.');
  },
  async editNote(noteId, accountId){
    /* fetch the current text first so prompt is prefilled */
    const cur = await sb.from('account_notes').select('text').eq('id', noteId).single();
    if(cur.error){ ui.err(cur.error); return; }
    const newText = prompt('Edit note:', cur.data.text);
    if(newText === null) return;
    if(!newText.trim()){ ui.toast('Note cannot be empty'); return; }
    const r = await sb.from('account_notes')
      .update({ text: newText.trim(), updated_at: new Date().toISOString() })
      .eq('id', noteId);
    if(r.error){
      const msg = /row-level security|permission/i.test(r.error.message)
        ? 'Cannot edit this note — past the 24-hour window or not your note.'
        : r.error.message;
      ui.err({ message: msg });
      return;
    }
    accounts.renderNotes(accountId);
  },
  async deleteNote(noteId, accountId){
    if(!confirm('Delete this note? This cannot be undone.')) return;
    const r = await sb.from('account_notes').delete().eq('id', noteId).select();
    if(r.error){
      const msg = /row-level security|permission/i.test(r.error.message)
        ? 'Cannot delete this note — past the 24-hour window or not your note.'
        : r.error.message;
      ui.err({ message: msg });
      return;
    }
    /* Supabase returns [] with no error when RLS silently blocks (past 24h window
       or not your note). Surface that instead of pretending it worked. */
    if(!r.data || r.data.length === 0){
      ui.err({ message: 'Cannot delete this note — past the 24-hour window or not your note.' });
      return;
    }
    accounts.renderNotes(accountId);
  },
  /* Toggle called from the "billing same as business" checkbox.
     When checked: copy business address fields into billing, then
     visually disable billing fields so admin knows they mirror.
     When unchecked: re-enable billing fields for independent editing. */
  toggleBillingSame(checked){
    const bStreet = document.getElementById('f-b-street').value;
    const bSuite  = document.getElementById('f-b-suite')?.value || '';
    const bCity   = document.getElementById('f-b-city').value;
    const bState  = document.getElementById('f-b-state').value;
    const bZip    = document.getElementById('f-b-zip').value;
    const ids = ['f-l-street','f-l-suite','f-l-city','f-l-state','f-l-zip'];
    if(checked){
      /* Auto-fill billing from business */
      document.getElementById('f-l-street').value = bStreet;
      if(document.getElementById('f-l-suite')) document.getElementById('f-l-suite').value = bSuite;
      document.getElementById('f-l-city').value = bCity;
      document.getElementById('f-l-state').value = bState;
      document.getElementById('f-l-zip').value = bZip;
      ids.forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        el.disabled = true;
        el.style.opacity = '0.55';
      });
      const block = document.getElementById('f-billing-block');
      if(block) block.style.borderStyle = 'dashed';
    } else {
      ids.forEach(id => {
        const el = document.getElementById(id);
        if(!el) return;
        el.disabled = false;
        el.style.opacity = '';
      });
      const block = document.getElementById('f-billing-block');
      if(block) block.style.borderStyle = '';
    }
  },
  async save(id, isNew){
    const get = i => document.getElementById(i).value;
    /* Preflight: if a rep is creating a NEW account and they have no rep_id
       assigned on their profile, the RLS policy will reject the insert with
       a cryptic "new row violates row-level security policy" error. Block
       here with a message they can actually act on. Admins can create
       accounts freely (RLS admin-all bypasses this). */
    if(isNew && !auth.isAdmin() && !auth.repId()){
      alert("Your profile doesn't have a Rep ID assigned yet, so you can't create accounts.\n\nAsk your admin to open the Reps tab → Edit your profile → set a Rep ID → Save. Then sign out and back in.");
      return;
    }
    const same = document.getElementById('f-billing-same').checked;
    /* If "same as" is checked, copy business fields into billing at save time
       (belt+suspenders — the checkbox onchange already did this, but re-copy
       in case business fields were edited after checking the box). */
    const bStreet = get('f-b-street').trim();
    const bSuite  = (document.getElementById('f-b-suite')?.value || '').trim();
    const bCity   = get('f-b-city').trim();
    const bState  = get('f-b-state').trim();
    const bZip    = get('f-b-zip').trim();
    const lStreet = same ? bStreet : get('f-l-street').trim();
    const lSuite  = same ? bSuite  : (document.getElementById('f-l-suite')?.value || '').trim();
    const lCity   = same ? bCity   : get('f-l-city').trim();
    const lState  = same ? bState  : get('f-l-state').trim();
    const lZip    = same ? bZip    : get('f-l-zip').trim();
    /* Concatenate into legacy single-line address columns so anything
       reading those (invoice, dashboard summary, etc.) still works
       during the transition. Format: "street[, suite], city, state zip" */
    const joinAddr = (s, su, c, st, z) => [
      [s, su].filter(Boolean).join(', '),
      [c, st].filter(Boolean).join(', '),
      z
    ].filter(Boolean).join(', ');
    const businessAddressLine = joinAddr(bStreet, bSuite, bCity, bState, bZip);
    const billingAddressLine  = joinAddr(lStreet, lSuite, lCity, lState, lZip);
    const payload = {
      business_name:get('f-bn'), type:get('f-type'), billing_name:get('f-rn'),
      email:get('f-em'),
      business_street: bStreet, business_suite: bSuite, business_city: bCity, business_state: bState, business_zip: bZip,
      billing_street: lStreet, billing_suite: lSuite, billing_city: lCity, billing_state: lState, billing_zip: lZip,
      billing_same_as_business: same,
      business_address: businessAddressLine, billing_address: billingAddressLine,
      cell:get('f-cell'), business_phone:get('f-bp'),
      website: (document.getElementById('f-web')?.value || '').trim() || null,
      sales_tax_license:get('f-stl'), sales_tax_state:get('f-sts'),
      tax_exempt: document.getElementById('f-exempt').checked,
      opt_in:get('f-opt')==='true', rep_id: (get('f-rep').trim() || auth.repId() || null)
    };
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('accounts').insert(payload).select().single();
    } else {
      q = await sb.from('accounts').update(payload).eq('id', id).select().single();
    }
    /* Graceful fallback: if the DB doesn't have the new structured
       columns yet (Dan hasn't run the address SQL migration), retry
       with a legacy-only payload so the save still succeeds. */
    if(q.error && /business_street|business_suite|billing_street|billing_suite|billing_same_as_business|billing_city|billing_state|billing_zip|business_city|business_state|business_zip|website/.test(q.error.message||'')){
      const {
        business_street, business_suite, business_city, business_state, business_zip,
        billing_street, billing_suite, billing_city, billing_state, billing_zip,
        billing_same_as_business, website,
        ...legacyPayload
      } = payload;
      /* void the destructured vars so the linter doesn't complain */
      void business_street; void business_city; void business_state; void business_zip;
      void billing_street; void billing_city; void billing_state; void billing_zip;
      void billing_same_as_business; void website;
      if(isNew){
        q = await sb.from('accounts').insert(legacyPayload).select().single();
      } else {
        q = await sb.from('accounts').update(legacyPayload).eq('id', id).select().single();
      }
      if(!q.error){
        ui.toast('Saved (structured address migration not yet run — using legacy columns).');
      }
    }
    if(q.error){ ui.err(q.error); return; }
    /* If Shopify integration is live AND the current rep is NOT in test mode,
       mirror the account as a Shopify customer. Test-mode reps must never
       create real Shopify customers (matches the order-push gate). */
    const inTestMode = !!(cache.me && cache.me.test_mode && cache.me.role !== 'admin');
    if(isNew && shopify.mode() === 'live' && !inTestMode){
      try { await shopify.call('push_account', { account_id: q.data.id }); }
      catch(e){ console.warn('shopify push_account failed:', e); }
    }
    /* On UPDATE (not isNew), if the account has a shopify_customer_id, push the
       updated fields so Shopify stays in sync. Fixes the class of bug where
       adding an email to an existing account never reached Shopify. */
    else if(!isNew && shopify.mode() === 'live' && !inTestMode && q.data.shopify_customer_id){
      try { await shopify.call('update_account', { account_id: q.data.id }); }
      catch(e){ console.warn('shopify update_account failed:', e); }
    }
    ui.closeModal(); ui.toast(isNew?'Account created':'Saved'); accounts.render(); dashboard.render();
  },
  async remove(id){
    /* Look up whether this account is linked to a Shopify customer so we can
       warn the admin about the orphan risk before they delete. */
    const linkCheck = await sb.from('accounts').select('shopify_customer_id').eq('id', id).maybeSingle();
    const isLinked = !!linkCheck.data?.shopify_customer_id;
    const warning = isLinked
      ? 'Delete this account?\n\nOrders keep their reference, but the linked Shopify customer record is NOT deleted — it stays in Shopify with its order history. If a rep later re-creates an account with the same email, a duplicate Shopify customer will be created unless the CRM already dedupes on email.'
      : 'Delete this account? Orders will keep their reference.';
    if(!confirm(warning)) return;
    /* .select() so we can see which rows Supabase actually deleted.
       If RLS silently blocks the delete, it returns [] (no error, no rows).
       Without this check we'd falsely tell the user "Deleted" while the
       account is still there. */
    const r = await sb.from('accounts').delete().eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){
      alert(
        "Delete did not go through. Nothing was removed.\n\n" +
        "Most likely cause: your account isn't recognized as admin by " +
        "the database (role must be 'admin' and not disabled), so the " +
        "row-level security policy blocked the delete silently.\n\n" +
        "Fix: open the Reps tab → find yourself → confirm Role = admin " +
        "and Disabled is unchecked. Then sign out and back in and try again."
      );
      return;
    }
    ui.closeModal(); ui.toast('Deleted'); accounts.render();
  },
  /* Clears the stored Shopify customer ID on an account.
     Use when Shopify returns "Record is invalid" because the customer
     was deleted/merged in Shopify. Next order pushes via email path. */
  async resetShopifyLink(id){
    if(!confirm('Reset Shopify customer link for this account?\n\nThe next order for this account will create a fresh Shopify customer via the email path. Existing Shopify orders for this account are not affected.')) return;
    const r = await sb.from('accounts').update({ shopify_customer_id: null }).eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){ alert('Reset did not go through — check your admin role.'); return; }
    ui.toast('Shopify link reset. Next order will create a fresh customer.');
    /* Refresh the modal by re-opening the account edit */
    ui.closeModal();
    accounts.open(id);
  }
};

/* ---------- ORDERS ---------- */
/* Test-mode orders (is_test = true) are excluded from every list here so
   they never inflate KPIs, dashboards, commissions, or the Orders list.
   `is_test IS NOT true` catches both false and null (older orders that
   pre-date the column). */
const orders = {
  async listMTD(){
    const from = startOfMonth();
    const { data, error } = await sb.from('orders').select('*').eq('status','finalized').gte('placed_at', from).not('is_test','is',true);
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async lastForAccount(accountId){
    const { data, error } = await sb.from('orders').select('*').eq('account_id', accountId).not('is_test','is',true).order('placed_at',{ascending:false}).limit(1);
    if(error){ return null; }
    return (data && data[0]) || null;
  },
  async listAll(){
    const { data, error } = await sb.from('orders').select('*').not('is_test','is',true).order('placed_at',{ascending:false});
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async render(){
    const q = (document.getElementById('ord-search').value||'').toLowerCase();
    const accts = await accounts.list();
    const acctMap = {}; accts.forEach(a=>acctMap[a.id]=a);
    const list = (await orders.listAll()).filter(o=>{
      const a = acctMap[o.account_id];
      const hay = [o.order_number||'', a?.business_name, a?.account_number, o.rep_id].join(' ').toLowerCase();
      return !q || hay.includes(q);
    });
    const wrap = document.getElementById('ord-list');
    if(!list.length){ wrap.innerHTML='<div class="muted">No orders yet.</div>'; return; }
    wrap.innerHTML = list.map(o=>{
      const a = acctMap[o.account_id];
      const status = o.status==='finalized' ? 'ok' : (o.status==='draft' ? 'warn':'info');
      let shopBadge = '';
      if(o.shopify_status==='paid'){ shopBadge = ' <span class="badge ok">Shopify: paid</span>'; }
      else if(o.shopify_status==='fulfilled'){ shopBadge = ' <span class="badge ok">Shopify: fulfilled</span>'; }
      else if(o.shopify_draft_order_id){ shopBadge = ' <span class="badge info">Shopify: draft sent</span>'; }
      const invUrl = safeShopifyUrl(o.shopify_invoice_url);
      return `<div class="list-item">
        <div class="grow">
          <div class="title">${esc(o.order_number||'(draft)')} <span class="badge ${status}">${esc(o.status)}</span>${shopBadge}</div>
          <div class="meta">${esc(a?.business_name||'—')} · ${new Date(o.placed_at).toLocaleDateString()} · ${fmt$(o.total)}${invUrl?` · <a href="${esc(invUrl)}" target="_blank" rel="noopener">Invoice link</a>`:''}</div>
        </div>
        <button class="icon-btn" onclick="orders.open('${o.id}')">Open</button>
      </div>`;
    }).join('');
  },
  _draft:null,
  _taxRate:0, _taxLabel:'',
  async openNew(){ orders.open(null) },
  async open(id){
    let o = null;
    if(id){
      const r = await sb.from('orders').select('*').eq('id', id).single();
      if(r.error){ ui.err(r.error); return; }
      o = r.data;
      if(o.account_id){
        const ar = await sb.from('accounts').select('sales_tax_license, sales_tax_state').eq('id', o.account_id).single();
        if(!ar.error){
          o._stl = ar.data?.sales_tax_license || '';
          o._sts = ar.data?.sales_tax_state || '';
        }
      }
    }
    const isNew = !o;
    orders._draft = o || {
      account_id:'', rep_id:auth.repId(),
      items:[], shipping:ref.shipDefault(), tax:0, tax_label:ref.taxLabelDefault(),
      promo_code:'', promo_effect:'', discount:0,
      payment:{method:'Visa', last4:'', esign:false},
      status:'draft', total:0, tax_exempt:false,
      _stl:'', _sts:''
    };
    orders._lastAccountId = null;
    const accs = await accounts.list();
    const accOpts = accs.map(a=>`<option value="${a.id}" ${orders._draft.account_id===a.id?'selected':''}>${esc(a.account_number)} — ${esc(a.business_name||'(unnamed)')}</option>`).join('');
    const repOpts = cache.reps.length
      ? cache.reps.map(r=>`<option value="${esc(r.rep_id||'')}" ${orders._draft.rep_id===r.rep_id?'selected':''}>${esc(r.name||r.email)} (${esc(r.rep_id||'no id')})</option>`).join('')
      : `<option>${esc(auth.repId()||'')}</option>`;
    const prodOpts = cache.products.map(p=>`<option value="${p.sku}" data-price="${p.price}" data-name="${esc(p.name)}">${p.sku} · ${esc(p.name)} · ${fmt$(p.price)} (stock ${p.stock})</option>`).join('');

    ui.modal(`
      <h3>${isNew?'New order':'Order · '+esc(orders._draft.order_number||'(draft)')}</h3>
      <div class="grid-2">
        <div><label>Account</label><select id="o-acc" onchange="orders.refresh()">${accOpts || '<option value="">— no accounts —</option>'}</select></div>
        <div><label>Rep</label><select id="o-rep" ${auth.isAdmin()?'':'disabled'}>${repOpts}</select></div>
      </div>

      <div class="card" style="margin-top:10px">
        <h2>Items</h2>
        <div class="row" style="gap:8px;margin-bottom:8px">
          <select id="o-sku" style="flex:2">${prodOpts}</select>
          <input id="o-qty" type="number" min="1" value="1" style="max-width:90px"/>
          <button class="icon-btn" onclick="orders.addItem()">Add</button>
        </div>
        <div id="o-items"></div>
      </div>

      <div class="card">
        <h2>Promotion / shipping / tax</h2>
        <div class="grid-3">
          <div><label>Promo code</label>
            <div class="row" style="gap:6px">
              <input id="o-promo" value="${esc(orders._draft.promo_code||'')}" placeholder="e.g. WELCOME10"/>
              <button class="icon-btn" onclick="orders.applyPromo()">Apply</button>
            </div>
            <div class="muted" id="o-promo-msg" style="font-size:12px;margin-top:4px">${esc(orders._draft.promo_effect||'No code applied')}</div>
          </div>
          <div><label>Shipping <span class="muted" style="font-size:11px">(pick a preset or type custom on the right)</span></label>
            <div class="row" style="gap:6px;align-items:stretch">
              <select id="o-ship-preset" style="flex:1" onchange="orders._shipPresetChanged()">
                ${orders._shipOptions(orders._draft.shipping)}
              </select>
              <input id="o-ship" type="number" step="0.01" min="0" placeholder="Or $"
                     style="width:100px"
                     value="${(orders._draft.shipping!=null && !orders._isShipPreset(orders._draft.shipping)) ? Number(orders._draft.shipping) : ''}"
                     onchange="orders.recompute()"
                     oninput="orders.recompute()"/>
            </div>
          </div>
          <div><label>Tax (auto)</label><input id="o-tax" readonly value="${Number(orders._draft.tax||0).toFixed(2)}"/></div>
        </div>
        <div class="muted" id="o-tax-note" style="font-size:12px;margin-top:6px"></div>
      </div>

      <div class="card">
        <h2>Tax exempt status</h2>
        <div class="grid-3">
          <div>
            <label>Tax exempt</label>
            <label class="toggle"><input type="checkbox" id="o-exempt" ${orders._draft.tax_exempt?'checked':''} onchange="orders.refresh()"/> <span>Do not charge sales tax</span></label>
          </div>
          <div><label>Sales tax license #</label><input id="o-stl" value="${esc(orders._draft._stl||'')}" placeholder="Optional documentation"/></div>
          <div><label>License state</label><input id="o-sts" value="${esc(orders._draft._sts||'')}" placeholder="CO"/></div>
        </div>
        <div class="muted" style="font-size:12px;margin-top:6px">Saving the order updates the account so future orders for the same account inherit these settings.</div>
      </div>

      <div class="card">
        <h2>Payment</h2>
        <div class="grid-3">
          <div><label>Method</label>
            <select id="o-pay-method">
              ${['Visa','Mastercard','Amex','Apple Pay','Venmo','PayPal','ACH'].map(m=>`<option ${orders._draft.payment?.method===m?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>
          <div><label>Card last 4 (if card)</label><input id="o-pay-l4" value="${esc(orders._draft.payment?.last4||'')}" maxlength="4"/></div>
          <div><label>Authorization signature <span class="muted" style="font-size:11px;font-weight:400">(optional)</span></label>
            <div id="o-sig-wrap"></div>
          </div>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0 0">All sales final. No payment terms. Returns only for shipping damage (case-by-case). Card data is never stored in the CRM — production uses Shopify Payments / tokenized vault.</p>
      </div>

      <div class="card">
        <div class="grow">
          <div><b>Subtotal</b> <span id="o-sub">$0.00</span></div>
          <div><b>Discount</b> <span id="o-disc">$0.00</span></div>
          <div><b>Shipping</b> <span id="o-shipv">$0.00</span></div>
          <div><b>Tax</b> <span id="o-taxv">$0.00</span> <span class="muted" id="o-taxlbl"></span></div>
          <div style="font-size:18px;margin-top:6px"><b>Total</b> <span id="o-total">$0.00</span></div>
        </div>
      </div>

      <div class="row" style="gap:8px;margin-top:6px">
        ${orders._draft.status !== 'finalized' ? `<button class="icon-btn" onclick="orders.saveDraft('${orders._draft.id||''}', ${isNew})">Save draft</button>` : ''}
        ${orders._draft.status !== 'finalized' ? `<button class="icon-btn primary" onclick="orders.finalize('${orders._draft.id||''}', ${isNew})">${(cache.me && cache.me.test_mode && cache.me.role !== 'admin') ? '🧪 Complete (test only)' : 'Finalize & invoice'}</button>` : ''}
        ${!isNew && shopify.mode()==='live' && !(cache.me && cache.me.test_mode && cache.me.role !== 'admin') ? `<button class="icon-btn" onclick="orders.pushToShopify('${orders._draft.id}')">Push to Shopify</button>`:''}
        ${!isNew && orders._draft.status === 'draft' ? `<button class="icon-btn danger" onclick="orders.remove('${orders._draft.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
      ${!isNew && orders._draft.status === 'finalized' ? '<p class="muted" style="font-size:12px;margin-top:8px">📋 This order is finalized — read-only. To void or refund, do it in Shopify. To create a similar new order, use "+ New Order".</p>' : ''}
    `);
    /* For existing orders, mark account as already-loaded so refresh() doesn't overwrite the order's saved tax_exempt */
    if(!isNew && orders._draft.account_id){
      orders._lastAccountId = orders._draft.account_id;
    }
    orders.renderItems();
    orders.renderSig();
    orders.refresh();
  },
  renderSig(){
    const wrap = document.getElementById('o-sig-wrap'); if(!wrap) return;
    const sig = safeSignature(orders._draft.payment?.signature);
    if(sig){
      const when = orders._draft.payment.signed_at ? new Date(orders._draft.payment.signed_at).toLocaleString() : '';
      wrap.innerHTML = `
        <div style="background:white;border-radius:6px;padding:4px;margin-bottom:4px">
          <img src="${sig}" style="display:block;width:100%;max-height:50px;object-fit:contain"/>
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:4px">Signed ${esc(when)}</div>
        <button class="icon-btn" onclick="orders.getSignature()" style="width:100%">Re-sign</button>`;
    } else {
      wrap.innerHTML = `<button class="icon-btn" onclick="orders.getSignature()" style="width:100%">Get signature</button>`;
    }
  },
  async getSignature(){
    const accId = document.getElementById('o-acc').value;
    const accList = await accounts.list();
    const acc = accList.find(a=>a.id===accId);
    const method = document.getElementById('o-pay-method').value;
    const last4 = document.getElementById('o-pay-l4').value;
    /* Make sure total is current */
    orders.recompute();
    const total = orders._draft.total || 0;
    const r = await sigpad.open({
      customer: acc?.billing_name || acc?.business_name || '',
      method, last4,
      amount: fmt$(total)
    });
    if(r.signed){
      orders._draft.payment = orders._draft.payment || {};
      orders._draft.payment.signature = r.dataUrl;
      orders._draft.payment.signed_at = r.signedAt;
      orders.renderSig();
      ui.toast('Signature captured');
    }
  },
  async refresh(){
    const accId = document.getElementById('o-acc').value;
    const acc = (await accounts.list()).find(a=>a.id===accId);
    /* When the account picker changes, repopulate the form's tax-exempt/license/state from the account */
    if(acc && orders._lastAccountId !== acc.id){
      orders._lastAccountId = acc.id;
      const ex = document.getElementById('o-exempt');
      const stl = document.getElementById('o-stl');
      const sts = document.getElementById('o-sts');
      if(ex)  ex.checked = !!acc.tax_exempt;
      if(stl) stl.value  = acc.sales_tax_license || '';
      if(sts) sts.value  = acc.sales_tax_state || '';
    }
    const exempt = document.getElementById('o-exempt')?.checked;
    const stl = (document.getElementById('o-stl')?.value || '').trim();
    const sts = (document.getElementById('o-sts')?.value || '').trim();
    let rate = ref.taxRateDefault(), label = ref.taxLabelDefault();
    let note = `Default: ${label} (${(rate*100).toFixed(2)}%).`;
    if(exempt){
      rate = 0;
      label = stl ? `Tax-exempt (license ${stl}${sts?', '+sts:''})` : 'Tax-exempt';
      note = `Tax exempt — no sales tax collected.`;
    }
    orders._taxRate = rate; orders._taxLabel = label;
    document.getElementById('o-tax-note').textContent = note;
    orders.recompute();
  },
  renderItems(){
    const wrap = document.getElementById('o-items');
    const items = orders._draft.items || [];
    if(!items.length){ wrap.innerHTML='<div class="muted">No items yet.</div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table>
      <tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Line</th><th></th></tr>
      ${items.map((it,i)=>`
        <tr>
          <td class="nowrap">${esc(it.sku)}</td>
          <td>${esc(it.name)}</td>
          <td><input type="number" min="1" value="${it.qty}" style="width:80px" onchange="orders.setQty(${i}, this.value)"/></td>
          <td>${fmt$(it.price)}</td>
          <td>${fmt$(it.qty*it.price)}</td>
          <td><button class="icon-btn ghost" onclick="orders.removeItem(${i})">✕</button></td>
        </tr>`).join('')}
    </table></div>`;
  },
  addItem(){
    const sel = document.getElementById('o-sku');
    const opt = sel.selectedOptions[0]; if(!opt) return;
    const qty = Math.max(1, parseInt(document.getElementById('o-qty').value||'1',10));
    const stock = parseInt(opt.dataset.stock || '0', 10);
    /* Stock warning — reps see a caution when ordering more than what's in
       stock so they don't accidentally oversell. Admin sees the same warning
       but can proceed. Non-admin gets a hard block. */
    /* Only warn when stock is a POSITIVE number being exceeded. stock=0 is
       ambiguous — could mean "actually out" or "inventory tracking disabled in
       Shopify" or "sync ran before stock was entered." Blocking on 0 caused
       reps to be locked out of ordering perfectly-available items. Merchant
       controls oversell prevention in Shopify itself. */
    if(stock > 0 && qty > stock){
      const msg = `Only ${stock} units of ${opt.dataset.name} in stock. Ordering ${qty} exceeds available inventory.`;
      if(!auth.isAdmin()){ ui.toast(msg); return; }
      if(!confirm(msg + '\n\nProceed anyway?')) return;
    }
    (orders._draft.items ||= []).push({sku:opt.value, name:opt.dataset.name, price:parseFloat(opt.dataset.price), qty});
    orders.renderItems(); orders.recompute();
  },
  setQty(i,v){
    const newQty = Math.max(1, parseInt(v||'1',10));
    const item = orders._draft.items[i];
    /* Same stock guard applies when the qty is edited later. */
    const prod = cache.products?.find(p => p.sku === item?.sku);
    const stock = prod ? Number(prod.stock || 0) : -1;
    /* Same rule as addItem: stock=0 is ambiguous, only warn on positive stock. */
    if(stock > 0 && newQty > stock){
      const msg = `Only ${stock} units of ${item.name} in stock. ${newQty} exceeds available inventory.`;
      if(!auth.isAdmin()){ ui.toast(msg); orders.renderItems(); return; }
      if(!confirm(msg + '\n\nProceed anyway?')) { orders.renderItems(); return; }
    }
    item.qty = newQty;
    orders.renderItems(); orders.recompute();
  },
  removeItem(i){ orders._draft.items.splice(i,1); orders.renderItems(); orders.recompute(); },
  applyPromo(){
    const code = (document.getElementById('o-promo').value||'').trim().toUpperCase();
    document.getElementById('o-promo').value = code;
    const p = cache.promotions.find(x=>x.code===code && x.active);
    const items = orders._draft.items || [];
    const qty = items.reduce((s,i)=>s+i.qty,0);
    if(!p){
      orders._draft.promo_code=''; orders._draft.promo_effect=''; orders._draft.discount=0;
      document.getElementById('o-promo-msg').textContent = code ? 'Code not found / inactive' : 'No code applied';
      orders.recompute(); return;
    }
    if(p.min_qty && qty < p.min_qty){
      orders._draft.promo_code=''; orders._draft.promo_effect=''; orders._draft.discount=0;
      document.getElementById('o-promo-msg').textContent = `Requires ${p.min_qty}+ units (current ${qty}).`;
      orders.recompute(); return;
    }
    orders._draft.promo_code = p.code;
    if(p.kind==='percent') orders._draft.promo_effect = `${p.value}% off subtotal`;
    else if(p.kind==='shipping') orders._draft.promo_effect = 'Free shipping';
    else if(p.kind==='bonus') orders._draft.promo_effect = 'Bonus product included with shipment';
    else if(p.kind==='access') orders._draft.promo_effect = p.perks || 'Access perk';
    document.getElementById('o-promo-msg').textContent = orders._draft.promo_effect;
    orders.recompute();
  },
  /* --- Shipping presets --- $0, $30 (minimum), $50 (expedited), and Other
     for anything else. "Other" reveals focus on the small text input next
     to the dropdown so the rep can type any amount. */
  _SHIP_PRESETS: [
    { value: 0,  label: 'Free ($0.00)' },
    { value: 30, label: 'Minimum ($30.00)' },
    { value: 50, label: 'Expedited ($50.00)' },
  ],
  _isShipPreset(v){
    const n = Number(v || 0);
    return orders._SHIP_PRESETS.some(p => Math.abs(p.value - n) < 0.005);
  },
  _shipOptions(currentVal){
    const cur = Number(currentVal || 0);
    const isCustom = currentVal != null && currentVal !== '' && !orders._isShipPreset(currentVal);
    const opts = orders._SHIP_PRESETS.map(p => {
      const sel = (!isCustom && Math.abs(cur - p.value) < 0.005) ? 'selected' : '';
      return `<option value="${p.value}" ${sel}>${p.label}</option>`;
    }).join('');
    return opts + `<option value="__custom" ${isCustom?'selected':''}>Other (type on the right →)</option>`;
  },
  _shipPresetChanged(){
    const sel = document.getElementById('o-ship-preset');
    if(!sel) return;
    if(sel.value === '__custom'){
      const custom = document.getElementById('o-ship');
      if(custom){ custom.focus(); }
    } else {
      /* Preset picked — clear the custom input so it defers to the preset. */
      const custom = document.getElementById('o-ship');
      if(custom) custom.value = '';
    }
    orders.recompute();
  },
  recompute(){
    const d = orders._draft; if(!d) return;
    const items = d.items || [];
    const sub = items.reduce((s,i)=>s+i.qty*i.price,0);
    const p = cache.promotions.find(x=>x.code===d.promo_code);
    /* Shipping resolution: custom input wins if filled; otherwise use the
       dropdown preset. Blank/0 = no charge. Never falls back to shipDefault. */
    const customRaw = document.getElementById('o-ship')?.value ?? '';
    const presetRaw = document.getElementById('o-ship-preset')?.value ?? '';
    let ship;
    if(customRaw !== ''){
      ship = parseFloat(customRaw) || 0;
    } else if(presetRaw && presetRaw !== '__custom'){
      ship = parseFloat(presetRaw) || 0;
    } else {
      ship = 0;
    }
    let disc = 0;
    if(p?.kind==='percent') disc = sub * (Number(p.value)/100);
    if(p?.kind==='shipping') ship = 0;
    const taxable = Math.max(0, sub - disc);
    const tax = taxable * (orders._taxRate||0);
    const total = taxable + ship + tax;
    d.discount = disc; d.shipping = ship; d.tax = tax;
    d.tax_label = orders._taxLabel; d.total = total;
    document.getElementById('o-sub').textContent = fmt$(sub);
    document.getElementById('o-disc').textContent = fmt$(disc);
    document.getElementById('o-shipv').textContent = fmt$(ship);
    document.getElementById('o-taxv').textContent = fmt$(tax);
    document.getElementById('o-taxlbl').textContent = orders._taxLabel ? `(${orders._taxLabel})` : '';
    document.getElementById('o-total').textContent = fmt$(total);
    document.getElementById('o-tax').value = tax.toFixed(2);
  },
  collect(){
    const d = orders._draft;
    d.account_id = document.getElementById('o-acc').value || null;
    d.rep_id = document.getElementById('o-rep').value || auth.repId();
    /* Same resolution rule as recompute: custom input wins if filled;
       else preset dropdown; else 0. */
    const cShipCustom = document.getElementById('o-ship')?.value ?? '';
    const cShipPreset = document.getElementById('o-ship-preset')?.value ?? '';
    if(cShipCustom !== '') d.shipping = parseFloat(cShipCustom) || 0;
    else if(cShipPreset && cShipPreset !== '__custom') d.shipping = parseFloat(cShipPreset) || 0;
    else d.shipping = 0;
    const pm = orders._draft.payment || {};
    pm.method = document.getElementById('o-pay-method').value;
    pm.last4 = document.getElementById('o-pay-l4').value;
    pm.authorized = false;
    d.payment = pm;
    d.tax_exempt = document.getElementById('o-exempt').checked;
    d._stl = (document.getElementById('o-stl').value||'').trim();
    d._sts = (document.getElementById('o-sts').value||'').trim();
    return d;
  },
  buildPayload(d){
    return {
      account_id: d.account_id, rep_id: d.rep_id, items: d.items||[],
      shipping: Number(d.shipping||0), tax: Number(d.tax||0), tax_label: d.tax_label,
      promo_code: d.promo_code, promo_effect: d.promo_effect, discount: Number(d.discount||0),
      payment: d.payment, status: d.status, total: Number(d.total||0),
      tax_exempt: !!d.tax_exempt
    };
  },
  async syncTaxToAccount(d){
    if(!d.account_id) return;
    const r = await sb.from('accounts').select('tax_exempt, sales_tax_license, sales_tax_state').eq('id', d.account_id).single();
    if(r.error) return;
    const cur = r.data;
    const next = {
      tax_exempt: !!d.tax_exempt,
      sales_tax_license: d._stl || null,
      sales_tax_state: d._sts || null
    };
    const changed = cur.tax_exempt !== next.tax_exempt
      || (cur.sales_tax_license||'') !== (next.sales_tax_license||'')
      || (cur.sales_tax_state||'') !== (next.sales_tax_state||'');
    if(changed){
      await sb.from('accounts').update(next).eq('id', d.account_id);
    }
  },
  async saveDraft(id, isNew){
    const d = orders.collect(); d.status='draft';
    const payload = orders.buildPayload(d);
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('orders').insert(payload).select().single();
    } else {
      q = await sb.from('orders').update(payload).eq('id', id).select().single();
    }
    if(q.error){ ui.err(q.error); return; }
    await orders.syncTaxToAccount(d);
    ui.closeModal(); ui.toast('Draft saved'); orders.render();
  },
  async finalize(id, isNew){
    const d = orders.collect();
    if(!d.account_id){ ui.toast('Pick an account first'); return; }
    if(!(d.items||[]).length){ ui.toast('Add at least one item'); return; }
    /* Signature is optional — reps can capture one if the customer is
       present, but it's not required to Finalize. Shopify captures its
       own consent when the customer pays via the invoice link. */

    /* Test mode: the rep is a training/testing account. Order is marked
       complete in the CRM but never pushes to Shopify — no invoice email,
       no real Shopify draft, no real money. */
    const inTestMode = !!(cache.me && cache.me.test_mode && cache.me.role !== 'admin');

    /* Non-test orders push to Shopify. Shopify will refuse checkout ("Shipping
       not available") if the account has no complete shipping address, and the
       shipping charge silently disappears. Enforce a full City/State/ZIP up
       front so no order goes out with a broken shipping address. Admins in
       test mode skip this — nothing pushes to Shopify anyway. */
    if(!inTestMode){
      const acctRes = await sb.from('accounts')
        .select('business_name, business_street, business_address, business_city, business_state, business_zip')
        .eq('id', d.account_id).single();
      const a = acctRes.data || {};
      const hasStreet = !!(a.business_street || a.business_address);
      const missing = [];
      if(!hasStreet)      missing.push('Street address');
      if(!a.business_city)  missing.push('City');
      if(!a.business_state) missing.push('State');
      if(!a.business_zip)   missing.push('ZIP');
      if(missing.length){
        ui.modal(`
          <h3 style="margin:0 0 10px">⚠️ Shipping address incomplete</h3>
          <p style="margin:0 0 8px">Before this order can be invoiced, the account <b>${esc(a.business_name||'')}</b> needs a complete business address.</p>
          <p style="margin:0 0 8px"><b>Missing:</b> ${missing.join(', ')}</p>
          <p style="margin:0 0 12px">Fix it: open <b>Accounts</b> → this account → fill in the missing fields → <b>Save</b>. Then come back and finalize the order.</p>
          <div class="row" style="gap:8px">
            <button class="icon-btn primary" onclick="ui.closeModal();accounts.open('${esc(d.account_id).replace(/'/g,'&#39;')}')">Open account now</button>
            <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
          </div>
        `);
        return;
      }
    }

    const sub = d.items.reduce((s,i)=>s+i.qty*i.price,0);
    const discPct = sub>0 ? (Number(d.discount)/sub*100) : 0;
    const adminFlag = discPct >= ref.highDiscPct() ? `High discount (${discPct.toFixed(1)}%) — admin will be notified.\n` : '';
    const confirmText = inTestMode
      ? adminFlag + '🧪 TEST MODE — complete this order?\n\nOrder is marked finalized in the CRM. No Shopify draft is created. No invoice is sent. No card is charged.'
      : adminFlag + 'Finalize this order? This generates an order #, invoice, and charges payment.';
    if(!confirm(confirmText)) return;

    d.status='finalized';
    /* payment.authorized should only be true when the rep actually captured
       a signature (or the rep is admin, who can bypass). Setting it true
       unconditionally made the field meaningless — no signature backing on
       disputes. */
    d.payment.authorized = !!(d.payment?.signature) || auth.isAdmin();
    const payload = orders.buildPayload(d);
    if(inTestMode) payload.is_test = true;
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('orders').insert(payload).select().single();
    } else {
      q = await sb.from('orders').update(payload).eq('id', id).select().single();
    }
    if(q.error){ ui.err(q.error); return; }
    await orders.syncTaxToAccount(d);
    /* Push to Shopify only when integration is live AND the rep is NOT in
       test mode. Test-mode reps never push to Shopify — the whole point of
       test mode is to prevent real orders from leaving the CRM. */
    if(shopify.mode() === 'live' && !inTestMode){
      /* Attempt to push the draft to Shopify. On a Shopify "Record is
         invalid" error (usually caused by a stale/deleted customer ID),
         auto-null the stored shopify_customer_id and retry once with
         the email fallback path. Self-heals the class of failure we hit
         when a Shopify customer gets deleted or merged. */
      const pushOnce = () => shopify.call('create_draft_order', { order_id: q.data.id });
      const looksLikeInvalidCustomer = e => {
        const m = (e?.message || '').toLowerCase();
        return m.includes('record is invalid') || m.includes('customer') && m.includes('invalid');
      };
      let sr = null;
      try {
        sr = await pushOnce();
      } catch(e){
        if(looksLikeInvalidCustomer(e) && d.account_id){
          console.warn('Shopify rejected — auto-healing by nulling stored customer ID and retrying', e);
          try {
            /* Verify the update actually took (RLS could silently 0-row it
               if the account isn't owned by this rep) before retrying. */
            const upd = await sb.from('accounts').update({ shopify_customer_id: null }).eq('id', d.account_id).select('id');
            if(upd.error || !upd.data || upd.data.length === 0){
              ui.toast('Order finalized. Shopify push failed and auto-heal could not reset the customer link — ask an admin to open this account and click "Reset Shopify link".');
              console.warn('auto-heal update returned 0 rows or error:', upd.error);
            } else {
              ui.toast('Shopify link auto-reset (stale customer) — retrying push…');
              sr = await pushOnce();
            }
          } catch(retryErr){
            ui.toast('Order finalized but Shopify push failed even after auto-reset: ' + (retryErr?.message || retryErr) + '. Use "Push to Shopify" on the order to retry manually.');
            console.warn('auto-heal retry failed:', retryErr);
          }
        } else {
          ui.toast('Order finalized but Shopify push failed. Use "Push to Shopify" on the order to retry.');
          console.warn('shopify push failed:', e);
        }
      }
      if(sr){
        if(sr.invoice_url){ q.data.shopify_invoice_url = sr.invoice_url; }
        if(sr.invoice_sent){
          ui.toast('Order finalized. Shopify has emailed the invoice to the customer.');
        } else if(sr.invoice_send_error){
          ui.toast('Order finalized + draft created, but invoice email failed: ' + sr.invoice_send_error);
        } else {
          ui.toast('Order finalized + Shopify draft created. Invoice link ready.');
        }
      }
    } else if(inTestMode){
      ui.toast('Test order saved — no Shopify draft created.');
    }
    ui.closeModal();
    invoice.show(q.data);
    dashboard.render(); orders.render();
  },
  async pushToShopify(id){
    if(shopify.mode() !== 'live'){ ui.toast('Shopify integration is off. Enable it in config.js first.'); return; }
    /* Verify this order isn't marked as a test order before touching Shopify.
       The Finalize button hides for test-mode reps, but an admin viewing the
       same order sees the Push button — without this gate an admin could
       push a rep's test order and generate a real invoice. */
    const chk = await sb.from('orders').select('is_test, account_id, status').eq('id', id).single();
    if(chk.data?.is_test === true){
      alert('This order is marked TEST. Cannot push to Shopify — test orders must never reach production.');
      return;
    }
    /* Same shipping-address gate as finalize. Without a full address Shopify
       returns 'Record is invalid' or checkout fails with 'Shipping not available'. */
    if(chk.data?.account_id){
      const acctRes = await sb.from('accounts')
        .select('business_name, business_street, business_address, business_city, business_state, business_zip')
        .eq('id', chk.data.account_id).single();
      const a = acctRes.data || {};
      const missing = [];
      if(!(a.business_street || a.business_address)) missing.push('Street address');
      if(!a.business_city)  missing.push('City');
      if(!a.business_state) missing.push('State');
      if(!a.business_zip)   missing.push('ZIP');
      if(missing.length){
        alert(`Cannot push to Shopify: ${a.business_name||'account'} is missing ${missing.join(', ')}.\n\nOpen the account and fill in the missing fields, then try again.`);
        return;
      }
    }
    ui.busy(true);
    try {
      const r = await shopify.call('create_draft_order', { order_id: id });
      const msg = r.already_linked
        ? 'Order already linked to Shopify draft.'
        : `Shopify draft created${r.invoice_url ? '. Invoice link ready.' : '.'}`;
      ui.toast(msg);
      const safeUrl = safeShopifyUrl(r.invoice_url);
      if(safeUrl){
        if(confirm(msg + '\n\nOpen the Shopify invoice link now?')){
          window.open(safeUrl, '_blank', 'noopener');
        }
      }
      orders.render();
      /* If the order detail modal is still open on this order, re-open it so
         the freshly-populated Shopify badge/invoice link is visible without
         a manual close/reopen. */
      const modalOpen = document.getElementById('modal-back')?.classList.contains('show');
      if(modalOpen && orders._draft && orders._draft.id === id){
        try { await orders.open(id, false); } catch(_){}
      }
    } catch(e){ ui.err(e); }
    ui.busy(false);
  },
  async remove(id){
    /* Local guard: RLS only allows deleting drafts. Show the reason up front
       rather than silently no-op when the delete hits the DB. */
    if(orders._draft && orders._draft.id === id && orders._draft.status !== 'draft'){
      alert('Only draft orders can be deleted. This one is ' + orders._draft.status + '.');
      return;
    }
    if(!confirm('Delete this order? Any linked Shopify draft will become orphaned unless you also delete it in Shopify.')) return;
    const r = await sb.from('orders').delete().eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){
      alert('Delete did not go through — the database blocked it. Likely because the order isn\'t a draft, or it belongs to another rep.');
      return;
    }
    ui.closeModal(); ui.toast('Deleted'); orders.render();
  }
};

/* ---------- SIGNATURE PAD ----------
   Canvas-based signature capture. Modal-driven; returns a data URL on confirm.
*/
const sigpad = {
  _resolve:null, _drawn:false,
  open(context){
    return new Promise(resolve=>{
      sigpad._resolve = resolve; sigpad._drawn = false;
      const customer = esc(context.customer || 'the cardholder');
      const method = esc(context.method || 'card');
      const last4 = esc(context.last4 || '____');
      const amount = esc(context.amount || 'the order total');
      const co = ref.company();
      ui.modal2(`
        <h3>Credit card authorization</h3>
        <p class="muted" style="font-size:13px;margin:0 0 12px">
          By signing below, <b>${customer}</b> authorizes ${esc(co.name||'The Reflect Co')} to charge ${method} ending in ${last4} for <b>${amount}</b> on ${new Date().toLocaleDateString()}. All sales final.
        </p>
        <div style="background:white;border-radius:8px;padding:6px">
          <canvas id="sig-canvas" width="900" height="240" style="display:block;width:100%;height:200px;touch-action:none;background:white;border-radius:4px;cursor:crosshair"></canvas>
          <div class="muted" style="font-size:11px;text-align:center;padding:4px 0;color:#666">Sign above with your finger or trackpad</div>
        </div>
        <div class="row" style="gap:8px;margin-top:10px">
          <button class="icon-btn ghost" onclick="sigpad.clear()">Clear</button>
          <div class="grow"></div>
          <button class="icon-btn" onclick="sigpad.cancel()">Cancel</button>
          <button class="icon-btn primary" onclick="sigpad.confirm()">I authorize</button>
        </div>
      `);
      sigpad._init();
    });
  },
  _init(){
    const c = document.getElementById('sig-canvas'); if(!c) return;
    const ctx = c.getContext('2d');
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height);
    let drawing = false;
    const pos = e => {
      const r = c.getBoundingClientRect();
      return { x: (e.clientX - r.left) * (c.width/r.width), y: (e.clientY - r.top) * (c.height/r.height) };
    };
    c.addEventListener('pointerdown', e=>{
      drawing = true; c.setPointerCapture(e.pointerId);
      const { x,y } = pos(e);
      ctx.beginPath(); ctx.moveTo(x,y);
    });
    c.addEventListener('pointermove', e=>{
      if(!drawing) return;
      const { x,y } = pos(e);
      ctx.lineTo(x,y); ctx.stroke();
      sigpad._drawn = true;
    });
    const stop = ()=> drawing = false;
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointerleave', stop);
    c.addEventListener('pointercancel', stop);
  },
  clear(){
    const c = document.getElementById('sig-canvas'); if(!c) return;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,c.width,c.height);
    sigpad._drawn = false;
  },
  confirm(){
    if(!sigpad._drawn){ ui.toast('Please sign before authorizing'); return; }
    const c = document.getElementById('sig-canvas');
    const dataUrl = c.toDataURL('image/png');
    ui.closeModal2();
    if(sigpad._resolve){ const r = sigpad._resolve; sigpad._resolve = null; r({ signed:true, dataUrl, signedAt:new Date().toISOString() }); }
  },
  cancel(){
    ui.closeModal2();
    if(sigpad._resolve){ const r = sigpad._resolve; sigpad._resolve = null; r({ signed:false }); }
  }
};

/* ---------- INVOICE ---------- */
const invoice = {
  async show(o){
    const accR = await sb.from('accounts').select('*').eq('id', o.account_id).single();
    const acc = accR.data || {};
    const rep = cache.reps.find(r=>r.rep_id===o.rep_id);
    const items = o.items || [];
    const sub = items.reduce((s,i)=>s+i.qty*i.price,0);
    const co = ref.company();
    ui.modal(`
      <h3>Invoice · ${esc(o.order_number||'(draft)')}</h3>
      <div class="muted" style="margin-bottom:8px">${new Date(o.placed_at).toLocaleString()} · Rep ${esc(rep?.name||o.rep_id||'')}</div>
      <div class="grid-2">
        <div><b>Bill to</b><br>${esc(acc.billing_name||'')}<br>${esc(acc.business_name||'')}<br>${esc(acc.billing_address||'')}<br>${esc(acc.email||'')}</div>
        <div><b>From</b><br>${esc(co.name||'')}<br>${esc(co.address||'')}<br>${esc(co.website||'')}</div>
      </div>
      <div class="table-wrap" style="margin-top:10px">
        <table><tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Line</th></tr>
          ${items.map(i=>`<tr><td>${esc(i.sku)}</td><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmt$(i.price)}</td><td>${fmt$(i.qty*i.price)}</td></tr>`).join('')}
        </table>
      </div>
      <div style="margin-top:10px">
        <div>Subtotal: ${fmt$(sub)}</div>
        ${o.discount?`<div>Discount (${esc(o.promo_code)}): -${fmt$(o.discount)}</div>`:''}
        <div>Shipping: ${fmt$(o.shipping)}</div>
        <div>Tax (${esc(o.tax_label||'')}): ${fmt$(o.tax)}</div>
        <div style="font-size:18px;margin-top:4px"><b>Total: ${fmt$(o.total)}</b></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">Payment: ${esc(o.payment?.method||'')} ${o.payment?.last4?'····'+esc(o.payment.last4):''}<br>Tracking will be emailed to ${esc(acc.email||'the account')} when shipped.</div>
      ${safeSignature(o.payment?.signature) ? `
        <div style="margin-top:10px">
          <div class="muted" style="font-size:11px;margin-bottom:4px">Authorization signature</div>
          <div style="background:white;border-radius:6px;padding:4px;max-width:320px">
            <img src="${safeSignature(o.payment.signature)}" style="display:block;width:100%;max-height:80px;object-fit:contain"/>
          </div>
          <div class="muted" style="font-size:11px;margin-top:2px">Signed ${o.payment.signed_at ? new Date(o.payment.signed_at).toLocaleString() : ''}</div>
        </div>` : ''}
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="icon-btn primary" onclick="window.print()">Print / Save PDF</button>
        <button class="icon-btn" onclick="ui.closeModal()">Done</button>
      </div>
    `);
  }
};

/* ---------- PROMOTIONS (admin) ---------- */
const promos = {
  async refresh(){
    const { data, error } = await sb.from('promotions').select('*').order('code');
    if(error){ ui.err(error); return; }
    cache.promotions = data || [];
  },
  async render(){
    await promos.refresh();
    const wrap = document.getElementById('promo-list');
    if(!cache.promotions.length){ wrap.innerHTML='<div class="muted">No promotions.</div>'; return; }
    wrap.innerHTML = cache.promotions.map(p=>`
      <div class="list-item">
        <div class="grow">
          <div class="title">${esc(p.code)} <span class="badge ${p.active?'ok':'err'}">${p.active?'active':'off'}</span> <span class="badge info">${esc(p.kind)}</span></div>
          <div class="meta">${esc(p.perks||'')} · min ${p.min_qty||0} units${p.kind==='percent'?` · ${p.value}% off`:''}</div>
        </div>
        <button class="icon-btn" onclick="promos.open('${p.id}')">Edit</button>
      </div>
    `).join('');
  },
  openNew(){ promos.open(null) },
  open(id){
    const p = id ? cache.promotions.find(x=>x.id===id) : null;
    const isNew = !p;
    const promo = p || { code:'', kind:'percent', value:10, perks:'', min_qty:0, active:true };
    ui.modal(`
      <h3>${isNew?'New promotion':'Edit promotion'}</h3>
      <div class="grid-2">
        <div><label>Code</label><input id="p-code" value="${esc(promo.code)}"/></div>
        <div><label>Kind</label>
          <select id="p-kind">
            ${['percent','shipping','bonus','access'].map(k=>`<option ${promo.kind===k?'selected':''}>${k}</option>`).join('')}
          </select>
        </div>
        <div><label>Percent (if % off)</label><input id="p-val" type="number" step="0.1" value="${promo.value||0}"/></div>
        <div><label>Min units</label><input id="p-min" type="number" step="1" value="${promo.min_qty||0}"/></div>
        <div style="grid-column:1/-1"><label>Perk description</label><input id="p-perk" value="${esc(promo.perks||'')}"/></div>
        <div><label>Status</label>
          <select id="p-act"><option value="true" ${promo.active?'selected':''}>Active</option><option value="false" ${!promo.active?'selected':''}>Inactive</option></select>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="icon-btn primary" onclick="promos.save('${promo.id||''}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="promos.remove('${promo.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
  },
  async save(id, isNew){
    const get = i => document.getElementById(i).value;
    const payload = {
      code: get('p-code').trim().toUpperCase(),
      kind: get('p-kind'),
      value: parseFloat(get('p-val')||'0'),
      min_qty: parseInt(get('p-min')||'0',10),
      perks: get('p-perk'),
      active: get('p-act')==='true'
    };
    const q = isNew
      ? await sb.from('promotions').insert(payload).select().single()
      : await sb.from('promotions').update(payload).eq('id', id).select().single();
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal(); promos.render();
  },
  async remove(id){
    if(!confirm('Delete promotion?')) return;
    const r = await sb.from('promotions').delete().eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){
      alert('Delete did not go through. Promotions are admin-only — confirm your role is admin.');
      return;
    }
    ui.closeModal(); promos.render();
  }
};

/* ---------- REPORTS ---------- */
const reports = {
  _mode: 'standard',  /* or 'yoy' */
  setActivePreset(preset){
    const wrap = document.getElementById('rep-presets'); if(!wrap) return;
    wrap.querySelectorAll('button[data-preset]').forEach(b => {
      b.classList.toggle('active-preset', b.dataset.preset === preset);
    });
  },
  setRange(preset){
    const d = new Date();
    const iso = x => x.toISOString().slice(0,10);
    const monStart = (yr, mo) => new Date(yr, mo, 1);
    const monEnd   = (yr, mo) => new Date(yr, mo+1, 0);
    let from, to;
    reports._mode = 'standard';
    switch(preset){
      case 'today':       from = to = iso(d); break;
      case 'week': {
        const dow = d.getDay() || 7; /* Mon=1..Sun=7 */
        const mon = new Date(d); mon.setDate(d.getDate() - (dow-1));
        from = iso(mon); to = iso(d); break;
      }
      case 'month':       from = iso(monStart(d.getFullYear(), d.getMonth())); to = iso(d); break;
      case 'lastmonth':   from = iso(monStart(d.getFullYear(), d.getMonth()-1));
                          to   = iso(monEnd  (d.getFullYear(), d.getMonth()-1)); break;
      case 'quarter': {
        const q = Math.floor(d.getMonth()/3);
        from = iso(monStart(d.getFullYear(), q*3)); to = iso(d); break;
      }
      case 'lastquarter': {
        const q = Math.floor(d.getMonth()/3) - 1;
        const yr = q < 0 ? d.getFullYear()-1 : d.getFullYear();
        const qm = q < 0 ? 9 : q*3;
        from = iso(monStart(yr, qm)); to = iso(monEnd(yr, qm+2)); break;
      }
      case 'ytd':         from = iso(monStart(d.getFullYear(), 0));  to = iso(d); break;
      case 'yoy':
        reports._mode = 'yoy';
        from = iso(monStart(d.getFullYear(), 0));  to = iso(d); break;
      case 'all': {
        /* "All time" = from the relevant person's start date (when they joined the company),
           not the literal beginning of time. */
        let startISO = null;
        if(!auth.isAdmin()){
          /* Rep view: their own join date */
          startISO = cache.me?.created_at;
        } else {
          /* Admin view: if a rep filter is set, use that rep's join date.
             Otherwise use the earliest rep on the team (effective company history). */
          const repFilter = document.getElementById('rep-rep')?.value;
          if(repFilter){
            const profile = cache.reps.find(r => r.rep_id === repFilter);
            startISO = profile?.created_at;
          } else {
            startISO = cache.reps.reduce((min, r) => {
              if(!r.created_at) return min;
              return (!min || r.created_at < min) ? r.created_at : min;
            }, null);
          }
        }
        from = startISO ? iso(new Date(startISO)) : '2000-01-01';
        to = iso(d);
        break;
      }
      default: return;
    }
    document.getElementById('rep-from').value = from;
    document.getElementById('rep-to').value = to;
    reports.setActivePreset(preset);
    reports.run();
  },
  async init(){
    document.getElementById('rep-from').value = startOfMonth();
    document.getElementById('rep-to').value = todayISO();
    reports.setActivePreset('month');
    /* Clear active preset if user manually edits either date */
    ['rep-from','rep-to'].forEach(id => {
      const el = document.getElementById(id);
      if(el && !el._presetClearBound){
        el.addEventListener('change', () => reports.setActivePreset(null));
        el._presetClearBound = true;
      }
    });
    /* When admin changes rep filter, re-apply the active preset (so "All time" recomputes for the picked rep's join date) */
    const repSel2 = document.getElementById('rep-rep');
    if(repSel2 && !repSel2._presetReapplyBound){
      repSel2.addEventListener('change', () => {
        const activeBtn = document.querySelector('#rep-presets button.active-preset');
        if(activeBtn) reports.setRange(activeBtn.dataset.preset);
      });
      repSel2._presetReapplyBound = true;
    }
    const repSel = document.getElementById('rep-rep');
    repSel.innerHTML = '<option value="">All reps</option>' + cache.reps.filter(r=>r.rep_id).map(r=>`<option value="${esc(r.rep_id)}">${esc(r.name||r.email)} (${esc(r.rep_id)})</option>`).join('');
    if(!auth.isAdmin()){ repSel.value = auth.repId() || ''; repSel.disabled = true; } else { repSel.disabled = false; }
    const typeSel = document.getElementById('rep-type');
    typeSel.innerHTML = '<option value="">All</option>' + cache.accountTypeList().map(t=>`<option>${esc(t)}</option>`).join('');
    reports.run();
  },
  async filter(){
    const from = document.getElementById('rep-from').value;
    const to   = document.getElementById('rep-to').value;
    const repId= document.getElementById('rep-rep').value;
    const acct = document.getElementById('rep-acct').value.trim().toUpperCase();
    const ord  = document.getElementById('rep-ord').value.trim().toUpperCase();
    const typ  = document.getElementById('rep-type').value;
    let q = sb.from('orders').select('*, account:accounts(account_number,business_name,type)').eq('status','finalized').not('is_test','is',true);
    /* Both bounds interpreted in America/Denver (the business timezone) so
       a rep setting "today" gets a full Denver day, not a UTC day that
       includes several extra hours of the next day. */
    if(from) q = q.gte('placed_at', tz.startOfDayUTC(from));
    if(to)   q = q.lte('placed_at', tz.endOfDayUTC(to));
    if(repId) q = q.eq('rep_id', repId);
    if(ord) q = q.ilike('order_number', `%${ord}%`);
    const { data, error } = await q.order('placed_at',{ascending:true});
    if(error){ ui.err(error); return []; }
    return (data||[]).filter(o=>{
      if(acct && !((o.account?.account_number||'').toUpperCase().includes(acct))) return false;
      if(typ && o.account?.type!==typ) return false;
      return true;
    });
  },
  async run(){
    const list = await reports.filter();
    const rev = list.reduce((s,o)=>s+Number(o.total||0),0);
    const comm = list.reduce((s,o)=>{
      const repPct = profiles.commissionFor(o.rep_id)/100;
      return s + (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    }, 0);
    document.getElementById('rep-k-orders').textContent = list.length;
    document.getElementById('rep-k-rev').textContent = fmt$(rev);
    document.getElementById('rep-k-avg').textContent = fmt$(list.length?rev/list.length:0);
    document.getElementById('rep-k-comm').textContent = fmt$(comm);

    const grp = {};
    list.forEach(o=>{
      const t = o.account?.type || 'Unknown';
      grp[t] = grp[t] || {orders:0, units:0, rev:0};
      grp[t].orders++;
      grp[t].units += (o.items||[]).reduce((s,i)=>s+i.qty,0);
      grp[t].rev += Number(o.total||0);
    });
    const rowsT = Object.entries(grp).map(([t,v])=>`<tr><td>${esc(t)}</td><td>${v.orders}</td><td>${v.units}</td><td>${fmt$(v.rev)}</td></tr>`).join('');
    document.getElementById('rep-bytype').innerHTML = rowsT ? `<table><tr><th>Type</th><th>Orders</th><th>Units</th><th>Revenue</th></tr>${rowsT}</table>` : '<div class="muted">No data.</div>';

    /* Pipeline & conversion — admin only */
    await reports.renderPipeline();

    /* Leaderboard — admin only */
    await reports.renderLeaderboard(list);

    /* By rep — admin only */
    const byRepWrap = document.getElementById('rep-byrep-wrap');
    if(auth.isAdmin() && byRepWrap){
      byRepWrap.classList.remove('hide');
      const byRep = {};
      list.forEach(o=>{
        const k = o.rep_id || '(unassigned)';
        byRep[k] = byRep[k] || { orders:0, units:0, rev:0, comm:0 };
        byRep[k].orders++;
        byRep[k].units += (o.items||[]).reduce((s,i)=>s+i.qty,0);
        byRep[k].rev += Number(o.total||0);
        const repPct = profiles.commissionFor(o.rep_id)/100;
        byRep[k].comm += (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
      });
      const byRepRows = Object.entries(byRep)
        .sort((a,b)=>b[1].rev - a[1].rev)
        .map(([repId, v])=>{
          const r = cache.reps.find(x=>x.rep_id===repId);
          const display = r ? `${esc(r.name||r.email)} <span class="muted" style="font-size:11px">(${esc(repId)})</span>` : esc(repId);
          const avg = v.orders ? v.rev/v.orders : 0;
          return `<tr><td>${display}</td><td>${v.orders}</td><td>${v.units}</td><td>${fmt$(v.rev)}</td><td>${fmt$(avg)}</td><td>${fmt$(v.comm)}</td></tr>`;
        }).join('');
      document.getElementById('rep-byrep').innerHTML = byRepRows
        ? `<table><tr><th>Rep</th><th>Orders</th><th>Units</th><th>Revenue</th><th>Avg order</th><th>Commission</th></tr>${byRepRows}</table>`
        : '<div class="muted">No orders in this period.</div>';
    } else if(byRepWrap){
      byRepWrap.classList.add('hide');
    }

    /* trend over time (auto-hidden for short ranges) */
    reports.renderTrend(list);

    /* Year-over-year comparison card */
    await reports.renderYoY(list);

    const rows = list.map(o=>{
      return `<tr>
        <td class="nowrap">${o.placed_at.slice(0,10)}</td>
        <td>${esc(o.order_number||'')}</td>
        <td>${esc(o.account?.account_number||'')}</td>
        <td>${esc(o.account?.business_name||'')}</td>
        <td>${esc(o.account?.type||'')}</td>
        <td>${esc(o.rep_id||'')}</td>
        <td>${fmt$(o.total)}</td>
      </tr>`;
    }).join('');
    document.getElementById('rep-detail').innerHTML = rows ? `<table><tr><th>Date</th><th>Order</th><th>Account #</th><th>Account</th><th>Type</th><th>Rep</th><th>Total</th></tr>${rows}</table>` : '<div class="muted">No orders match.</div>';
    reports._lastList = list;
  },
  async renderLeaderboard(orderList){
    const wrap = document.getElementById('rep-leaderboard-wrap');
    const tbl  = document.getElementById('rep-leaderboard');
    if(!wrap || !tbl) return;
    if(!auth.isAdmin()){ wrap.classList.add('hide'); return; }
    wrap.classList.remove('hide');

    const fromStr = document.getElementById('rep-from').value;
    const toStr   = document.getElementById('rep-to').value;
    if(!fromStr || !toStr){ tbl.innerHTML='<div class="muted">Pick a range first.</div>'; return; }
    const fromIso = fromStr + 'T00:00:00';
    const toIso   = toStr   + 'T23:59:59';

    /* Aggregate from the already-loaded order list */
    const repStats = {};
    (orderList || []).forEach(o => {
      const k = o.rep_id || '(unassigned)';
      repStats[k] = repStats[k] || { rep_id:k, revenue:0, orders:0, comm:0 };
      const sub = (o.items||[]).reduce((s,i)=>s+i.qty*i.price,0);
      const repPct = profiles.commissionFor(k)/100;
      repStats[k].revenue += Number(o.total||0);
      repStats[k].orders++;
      repStats[k].comm += (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    });

    /* Leads + conversions in same range for close-rate ranking */
    const pq = await sb.from('prospects')
      .select('rep_id, converted_account_id')
      .gte('created_at', fromIso).lte('created_at', toIso);
    (pq.data || []).forEach(p => {
      const k = p.rep_id || '(unassigned)';
      repStats[k] = repStats[k] || { rep_id:k, revenue:0, orders:0, comm:0 };
      repStats[k].leads = (repStats[k].leads||0) + 1;
      if(p.converted_account_id) repStats[k].closed = (repStats[k].closed||0) + 1;
    });

    const reps = Object.values(repStats).map(r => {
      const profile = cache.reps.find(p => p.rep_id === r.rep_id);
      r.name = profile ? (profile.name || profile.email) : r.rep_id;
      r.avgDeal = r.orders ? r.revenue / r.orders : 0;
      r.closeRate = r.leads ? (r.closed||0) / r.leads * 100 : null;
      return r;
    });

    if(!reps.length){ tbl.innerHTML='<div class="muted">No activity in this period.</div>'; return; }

    /* Standard competition ranking (1, 2, 2, 4). Treat missing values as worst rank. */
    const rankBy = (key, descending = true) => {
      const sorted = [...reps].sort((a,b)=>{
        const av = a[key] == null ? -Infinity : a[key];
        const bv = b[key] == null ? -Infinity : b[key];
        return descending ? bv - av : av - bv;
      });
      let lastVal = null, lastRank = 0;
      sorted.forEach((r, idx) => {
        const v = r[key] == null ? -Infinity : r[key];
        const rank = (v === lastVal) ? lastRank : (idx + 1);
        r[`rank_${key}`] = rank;
        lastVal = v; lastRank = rank;
      });
    };
    rankBy('revenue');
    rankBy('orders');
    rankBy('avgDeal');
    rankBy('closeRate');

    const N = reps.length;
    reps.forEach(r => {
      /* If a rep had no leads, give them the worst rank in close rate so it doesn't tank their overall score unfairly — use N */
      const closeRank = r.closeRate == null ? N : r.rank_closeRate;
      r.overall = r.rank_revenue + r.rank_orders + r.rank_avgDeal + closeRank;
    });
    reps.sort((a,b)=> a.overall - b.overall || b.revenue - a.revenue);

    const medal = pos => pos === 1 ? '🥇' : pos === 2 ? '🥈' : pos === 3 ? '🥉' : `#${pos}`;
    const dimRank = r => `<span class="muted" style="font-size:11px">#${r}</span>`;
    const rows = reps.map((r, idx) => `
      <tr>
        <td><b>${medal(idx+1)}</b> ${esc(r.name)} <span class="muted" style="font-size:11px">(${esc(r.rep_id)})</span></td>
        <td>${fmt$(r.revenue)} ${dimRank(r.rank_revenue)}</td>
        <td>${r.orders} ${dimRank(r.rank_orders)}</td>
        <td>${fmt$(r.avgDeal)} ${dimRank(r.rank_avgDeal)}</td>
        <td>${r.closeRate == null ? '—' : (r.closeRate.toFixed(0) + '% ' + dimRank(r.rank_closeRate))}</td>
        <td>${fmt$(r.comm)}</td>
      </tr>
    `).join('');

    tbl.innerHTML = `<table>
      <tr><th>Rep</th><th>Revenue</th><th>Orders</th><th>Avg deal</th><th>Close rate</th><th>Commission</th></tr>
      ${rows}
    </table>`;
  },
  async renderPipeline(){
    const wrap = document.getElementById('rep-pipeline-wrap'); if(!wrap) return;
    if(!auth.isAdmin()){ wrap.classList.add('hide'); return; }
    wrap.classList.remove('hide');

    const fromStr = document.getElementById('rep-from').value;
    const toStr   = document.getElementById('rep-to').value;
    if(!fromStr || !toStr) return;
    const fromIso = fromStr + 'T00:00:00';
    const toIso   = toStr   + 'T23:59:59';
    const dayMs = 86400000;

    /* Leads (prospects) created in window */
    const lq = await sb.from('prospects')
      .select('id, rep_id, created_at, status, converted_account_id')
      .gte('created_at', fromIso).lte('created_at', toIso);
    const leads = lq.error ? [] : (lq.data || []);

    /* Accounts created in window */
    const aq = await sb.from('accounts')
      .select('id, rep_id, created_at')
      .gte('created_at', fromIso).lte('created_at', toIso);
    const accts = aq.error ? [] : (aq.data || []);
    const acctById = {}; accts.forEach(a => acctById[a.id] = a);

    /* For time-to-close, we need converted prospects whose linked account exists.
       Pull all converted prospects (any time) so we can compute close times even
       if the prospect was created before the window. */
    const cq = await sb.from('prospects')
      .select('id, rep_id, created_at, converted_account_id')
      .not('converted_account_id', 'is', null);
    const allConverted = cq.error ? [] : (cq.data || []);

    /* Fetch the linked accounts for those converted prospects to know close date */
    const linkedIds = [...new Set(allConverted.map(p => p.converted_account_id).filter(Boolean))];
    let linkedAccts = {};
    if(linkedIds.length){
      const la = await sb.from('accounts').select('id, created_at').in('id', linkedIds);
      (la.data || []).forEach(a => linkedAccts[a.id] = a);
    }

    /* Closed-in-window = converted prospects where the linked account was created in window */
    const closedInWindow = allConverted.filter(p => {
      const a = linkedAccts[p.converted_account_id];
      return a && a.created_at >= fromIso && a.created_at <= toIso;
    });

    /* Conversion rate scoping: of leads CREATED in window, how many ever converted? */
    const leadsCreatedConverted = leads.filter(l => l.converted_account_id);
    const conversionRate = leads.length ? (leadsCreatedConverted.length / leads.length * 100) : 0;

    /* Avg time-to-close: across all closed-in-window deals */
    let ttcDays = null;
    if(closedInWindow.length){
      const total = closedInWindow.reduce((s,p) => {
        const start = new Date(p.created_at).getTime();
        const end = new Date(linkedAccts[p.converted_account_id].created_at).getTime();
        return s + Math.max(0, (end - start) / dayMs);
      }, 0);
      ttcDays = total / closedInWindow.length;
    }

    document.getElementById('pl-leads').textContent = leads.length;
    document.getElementById('pl-accts').textContent = accts.length;
    document.getElementById('pl-rate').textContent = leads.length ? conversionRate.toFixed(1)+'%' : '—';
    document.getElementById('pl-ttc').textContent = ttcDays === null ? '—' : ttcDays.toFixed(1)+' days';

    /* By-rep breakdown */
    const byRep = {};
    leads.forEach(l => {
      const k = l.rep_id || '(unassigned)';
      byRep[k] = byRep[k] || { leads:0, closed:0, totalDays:0, closedCount:0 };
      byRep[k].leads++;
      if(l.converted_account_id) byRep[k].closed++;
    });
    closedInWindow.forEach(p => {
      const k = p.rep_id || '(unassigned)';
      byRep[k] = byRep[k] || { leads:0, closed:0, totalDays:0, closedCount:0 };
      const a = linkedAccts[p.converted_account_id];
      const days = Math.max(0, (new Date(a.created_at) - new Date(p.created_at)) / dayMs);
      byRep[k].totalDays += days;
      byRep[k].closedCount++;
    });
    const rows = Object.entries(byRep).sort((a,b)=>b[1].closed-a[1].closed).map(([repId, v]) => {
      const r = cache.reps.find(x => x.rep_id === repId);
      const name = r ? `${esc(r.name||r.email)} <span class="muted" style="font-size:11px">(${esc(repId)})</span>` : esc(repId);
      const rate = v.leads ? (v.closed/v.leads*100).toFixed(1)+'%' : '—';
      const avgTtc = v.closedCount ? (v.totalDays/v.closedCount).toFixed(1)+'d' : '—';
      return `<tr><td>${name}</td><td>${v.leads}</td><td>${v.closed}</td><td>${rate}</td><td>${avgTtc}</td></tr>`;
    }).join('');
    document.getElementById('pl-byrep').innerHTML = rows
      ? `<table><tr><th>Rep</th><th>Leads created</th><th>Closed</th><th>Conv. %</th><th>Avg time to close</th></tr>${rows}</table>`
      : '<div class="muted">No prospect activity in this range.</div>';
  },
  async renderYoY(currentList){
    const card = document.getElementById('rep-yoy-card');
    if(!card) return;
    if(reports._mode !== 'yoy'){ card.classList.add('hide'); return; }

    const fromStr = document.getElementById('rep-from').value;
    const toStr   = document.getElementById('rep-to').value;
    const from = new Date(fromStr); const to = new Date(toStr);
    /* Same range, one year earlier */
    const pf = new Date(from); pf.setFullYear(pf.getFullYear()-1);
    const pt = new Date(to);   pt.setFullYear(pt.getFullYear()-1);
    const pfIso = pf.toISOString().slice(0,10);
    const ptIso = pt.toISOString().slice(0,10);

    /* Fetch prior-year same-period orders */
    const repId = document.getElementById('rep-rep').value;
    let q = sb.from('orders').select('rep_id, total, shipping, tax').eq('status','finalized').not('is_test','is',true)
      .gte('placed_at', pfIso).lte('placed_at', new Date(ptIso + 'T23:59:59').toISOString());
    if(repId) q = q.eq('rep_id', repId);
    const r = await q;
    if(r.error){ card.classList.add('hide'); return; }
    const priorRows = r.data || [];
    const priorRev = priorRows.reduce((s,o)=>s+Number(o.total||0),0);
    const priorOrders = priorRows.length;
    const priorComm = priorRows.reduce((s,o)=>{
      const repPct = profiles.commissionFor(o.rep_id)/100;
      return s + (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    }, 0);

    const curRev = currentList.reduce((s,o)=>s+Number(o.total||0),0);
    const curOrders = currentList.length;
    const curComm = currentList.reduce((s,o)=>{
      const repPct = profiles.commissionFor(o.rep_id)/100;
      return s + (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    }, 0);

    const pct = (now, then) => {
      if(!then) return now ? '+∞%' : '0.0%';
      const v = ((now-then)/then) * 100;
      return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
    };
    const ratio = (now, then) => then ? (now/then).toFixed(2) : '—';
    const klass = v => v.startsWith('-') ? 'err' : (v === '0.0%' ? '' : 'ok');

    card.classList.remove('hide');
    const yrThis = from.getFullYear();
    const yrPrev = pf.getFullYear();
    document.getElementById('rep-yoy-body').innerHTML = `
      <div class="muted" style="font-size:12px;margin-bottom:8px">
        Comparing <b>${fromStr} → ${toStr}</b> (${yrThis}) vs <b>${pfIso} → ${ptIso}</b> (${yrPrev})
      </div>
      <div class="table-wrap"><table>
        <tr><th>Metric</th><th>${yrPrev}</th><th>${yrThis}</th><th>Change</th><th>Ratio</th></tr>
        <tr><td>Revenue</td><td>${fmt$(priorRev)}</td><td>${fmt$(curRev)}</td><td><span class="badge ${klass(pct(curRev,priorRev))}">${pct(curRev,priorRev)}</span></td><td>${ratio(curRev,priorRev)}x</td></tr>
        <tr><td>Orders</td><td>${priorOrders}</td><td>${curOrders}</td><td><span class="badge ${klass(pct(curOrders,priorOrders))}">${pct(curOrders,priorOrders)}</span></td><td>${ratio(curOrders,priorOrders)}x</td></tr>
        <tr><td>Commission</td><td>${fmt$(priorComm)}</td><td>${fmt$(curComm)}</td><td><span class="badge ${klass(pct(curComm,priorComm))}">${pct(curComm,priorComm)}</span></td><td>${ratio(curComm,priorComm)}x</td></tr>
      </table></div>
      ${priorOrders === 0 ? '<div class="muted" style="font-size:12px;margin-top:8px">No orders in the prior-year period — ratios shown as ∞.</div>' : ''}
    `;
  },
  renderTrend(list){
    const fromStr = document.getElementById('rep-from').value;
    const toStr   = document.getElementById('rep-to').value;
    const titleEl = document.getElementById('rep-trend-title');
    const wrap    = document.getElementById('rep-trend');
    const trendWrap = document.getElementById('rep-trend-wrap');
    if(!fromStr || !toStr){ trendWrap.classList.add('hide'); return; }
    const from = new Date(fromStr + 'T00:00:00');
    const to   = new Date(toStr   + 'T23:59:59');
    const dayMs = 86400000;
    const days = Math.max(1, Math.ceil((to - from) / dayMs) + 1);
    /* Hide trend for short ranges — summary tiles already show the total */
    if(days <= 31){ trendWrap.classList.add('hide'); return; }
    trendWrap.classList.remove('hide');
    const bucketBy = days <= 120 ? 'week' : 'month';
    titleEl.textContent = 'Revenue trend — by ' + bucketBy;

    const buckets = new Map();
    const keyFor = d => {
      if(bucketBy === 'day'){
        return { key: d.toISOString().slice(0,10), label: d.toLocaleDateString(undefined,{month:'short', day:'numeric'}) };
      }
      if(bucketBy === 'week'){
        const dow = d.getDay() || 7;
        const mon = new Date(d); mon.setDate(d.getDate() - (dow-1)); mon.setHours(0,0,0,0);
        return { key: mon.toISOString().slice(0,10), label: 'Wk of ' + mon.toLocaleDateString(undefined,{month:'short', day:'numeric'}) };
      }
      const m = new Date(d.getFullYear(), d.getMonth(), 1);
      return { key: m.toISOString().slice(0,10), label: m.toLocaleDateString(undefined,{month:'short', year:'numeric'}) };
    };

    const stepper = new Date(from);
    if(bucketBy === 'day'){
      while(stepper <= to){
        const k = keyFor(new Date(stepper));
        buckets.set(k.key, { label:k.label, orders:0, revenue:0 });
        stepper.setDate(stepper.getDate()+1);
      }
    } else if(bucketBy === 'week'){
      const dow = stepper.getDay() || 7;
      stepper.setDate(stepper.getDate() - (dow-1));
      while(stepper <= to){
        const k = keyFor(new Date(stepper));
        buckets.set(k.key, { label:k.label, orders:0, revenue:0 });
        stepper.setDate(stepper.getDate()+7);
      }
    } else {
      stepper.setDate(1);
      while(stepper <= to){
        const k = keyFor(new Date(stepper));
        buckets.set(k.key, { label:k.label, orders:0, revenue:0 });
        stepper.setMonth(stepper.getMonth()+1);
      }
    }

    list.forEach(o=>{
      const k = keyFor(new Date(o.placed_at));
      const b = buckets.get(k.key) || { label:k.label, orders:0, revenue:0 };
      b.orders++;
      b.revenue += Number(o.total||0);
      buckets.set(k.key, b);
    });

    const arr = Array.from(buckets.entries()).map(([key,v])=>({key, ...v}));
    if(!arr.length){ wrap.innerHTML = '<div class="muted">No data.</div>'; return; }
    const maxRev = Math.max(1, ...arr.map(x=>x.revenue));
    const totalRev = arr.reduce((s,x)=>s+x.revenue,0);

    const rows = arr.map(b=>{
      const pct = (b.revenue / maxRev) * 100;
      return `<tr>
        <td class="nowrap">${esc(b.label)}</td>
        <td>${b.orders}</td>
        <td class="nowrap">${fmt$(b.revenue)}</td>
        <td style="min-width:140px;width:100%">
          <div style="position:relative;background:#0c1117;border:1px solid var(--line);border-radius:4px;height:18px">
            <div style="position:absolute;left:0;top:0;height:100%;background:linear-gradient(90deg,var(--brand-2),var(--brand));width:${pct.toFixed(1)}%;border-radius:4px"></div>
          </div>
        </td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `<table><tr><th>Period</th><th>Orders</th><th>Revenue</th><th></th></tr>${rows}<tr><td><b>Total</b></td><td><b>${list.length}</b></td><td colspan="2"><b>${fmt$(totalRev)}</b></td></tr></table>`;
  },
  async exportCsv(){
    if(!auth.isAdmin()){
      /* Log the attempted export even though we block it */
      try{ await sb.rpc('log_export', { p_table_name:'orders_report', p_record_count:0, p_filter_desc:'BLOCKED — rep attempted' }); } catch(_){}
      ui.toast('Exports are limited to admins. All this data is visible on screen for you.');
      return;
    }
    const list = reports._lastList || [];
    const from = document.getElementById('rep-from').value;
    const to = document.getElementById('rep-to').value;
    const rep = document.getElementById('rep-rep').value;
    const filterDesc = `Orders ${from} → ${to}${rep?' · rep '+rep:''}`;
    /* Audit log */
    try{ await sb.rpc('log_export', { p_table_name:'orders_report', p_record_count: list.length, p_filter_desc: filterDesc }); } catch(_){}
    const rows = [
      ...csvWatermark(filterDesc),
      ['Date','Order','AccountNumber','Account','Type','Rep','Subtotal','Discount','Shipping','Tax','Total','Commission']
    ];
    list.forEach(o=>{
      const sub = (o.items||[]).reduce((s,i)=>s+i.qty*i.price,0);
      const repPct = profiles.commissionFor(o.rep_id)/100;
      const comm = (Number(o.total)-Number(o.shipping)-Number(o.tax))*repPct;
      rows.push([
        o.placed_at.slice(0,10), o.order_number||'',
        o.account?.account_number||'', o.account?.business_name||'',
        o.account?.type||'', o.rep_id||'',
        sub.toFixed(2), Number(o.discount).toFixed(2),
        Number(o.shipping).toFixed(2), Number(o.tax).toFixed(2),
        Number(o.total).toFixed(2), comm.toFixed(2)
      ]);
    });
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `reflectco-report-${todayISO()}.csv`; a.click();
    URL.revokeObjectURL(url);
  },
  monthly(){
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth()-1, 1);
    const last  = new Date(d.getFullYear(), d.getMonth(), 0);
    document.getElementById('rep-from').value = first.toISOString().slice(0,10);
    document.getElementById('rep-to').value   = last.toISOString().slice(0,10);
    reports.run();
    ui.toast('Last month loaded — export CSV to send commissions.');
  }
};

/* ---------- CUSTOMER SERVICE (rule-based OR live AI via Edge Function) ---------- */
/* ---------- MARKETING MATERIALS (Supabase Storage) ---------- */
const materials = {
  BUCKET: 'materials',
  CATEGORIES: ['Product Sheets', 'Sell Sheets', 'Brand Assets', 'Order Forms', 'Training', 'Other'],
  _files: [],

  /* Load all files across every category folder. Signed download URLs are
     generated on click, not up-front, so this stays fast even at 100+ files.
     Parallelizes the 6 category listings so total wait ~= slowest single
     bucket call, not sum-of-6. Cuts first-tap latency from ~2s to ~350ms. */
  async loadAll(){
    const listOne = async (cat) => {
      const { data, error } = await sb.storage.from(materials.BUCKET).list(cat, {
        limit: 500, sortBy: { column: 'name', order: 'asc' }
      });
      if(error) return [];
      return (data||[])
        .filter(f => f.name && f.name !== '.emptyFolderPlaceholder')
        .map(f => ({ ...f, category: cat, path: `${cat}/${f.name}` }));
    };
    const results = await Promise.all(materials.CATEGORIES.map(listOne));
    materials._files = results.flat();
  },

  async render(){
    const wrap = document.getElementById('mat-list'); if(!wrap) return;
    /* Populate the category filter once */
    const catSel = document.getElementById('mat-cat-filter');
    if(catSel && catSel.options.length <= 1){
      catSel.innerHTML = '<option value="">All categories</option>' +
        materials.CATEGORIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    }
    wrap.innerHTML = '<div class="muted">Loading…</div>';
    try { await materials.loadAll(); }
    catch(e){ wrap.innerHTML = `<div class="alert err">Load failed: ${esc(e.message||e)}</div>`; return; }

    const q = (document.getElementById('mat-search')?.value||'').toLowerCase().trim();
    const catF = document.getElementById('mat-cat-filter')?.value || '';
    const filtered = materials._files.filter(f => {
      if(catF && f.category !== catF) return false;
      if(!q) return true;
      return (f.name+' '+f.category).toLowerCase().includes(q);
    });
    if(!filtered.length){
      wrap.innerHTML = `<div class="muted">${materials._files.length===0 ? 'No materials uploaded yet.' : 'No materials match the search / filter.'}</div>`;
      return;
    }
    /* Group by category for display */
    const groups = {};
    filtered.forEach(f => { (groups[f.category] = groups[f.category]||[]).push(f); });
    wrap.innerHTML = Object.keys(groups).sort().map(cat => `
      <div style="margin-bottom:14px">
        <h3 style="margin:0 0 6px 0;font-size:14px;color:var(--muted)">${esc(cat)}</h3>
        ${groups[cat].map(f => {
          const ext = (f.name.split('.').pop()||'').toLowerCase();
          const icon = ({pdf:'📄',png:'🖼',jpg:'🖼',jpeg:'🖼',gif:'🖼',mp4:'🎬',mov:'🎬',doc:'📃',docx:'📃',xls:'📊',xlsx:'📊',ppt:'📽',pptx:'📽',zip:'🗜'}[ext] || '📎');
          const kb = f.metadata?.size ? (f.metadata.size < 1024*1024 ? (f.metadata.size/1024).toFixed(0)+' KB' : (f.metadata.size/1024/1024).toFixed(1)+' MB') : '';
          const when = f.created_at ? new Date(f.created_at).toLocaleDateString() : '';
          const p = esc(f.path).replace(/'/g,'&#39;');
          return `<div class="list-item">
            <div class="grow">
              <div class="title">${icon} ${esc(f.name)}</div>
              <div class="meta">${esc(cat)}${kb?' · '+esc(kb):''}${when?' · uploaded '+esc(when):''}</div>
            </div>
            <button class="icon-btn primary" onclick="materials.view('${p}')">👁 View</button>
            ${auth.isAdmin()?`<button class="icon-btn" onclick="materials.download('${p}')">⬇ Download</button>`:''}
            ${auth.isAdmin()?`<button class="icon-btn danger" onclick="materials.remove('${p}')">Delete</button>`:''}
          </div>`;
        }).join('')}
      </div>
    `).join('');
  },

  openUpload(){
    if(!auth.isAdmin()){ ui.toast('Admin only.'); return; }
    ui.modal(`
      <h3>Upload marketing material</h3>
      <p class="muted" style="font-size:13px;margin:0 0 12px">PDFs, images, videos, docs. Max 50 MB per file.</p>
      <div class="grid-2">
        <div style="grid-column:1/-1">
          <label>File <span style="color:var(--brand)">*</span></label>
          <input id="mat-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.gif,.mp4,.mov,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"/>
        </div>
        <div>
          <label>Category <span style="color:var(--brand)">*</span></label>
          <select id="mat-cat">
            ${materials.CATEGORIES.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label>Rename to (optional)</label>
          <input id="mat-name" placeholder="Leave blank to keep original filename"/>
        </div>
      </div>
      <div id="mat-err" class="alert err hide" style="margin-top:10px"></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="materials.submitUpload()">Upload</button>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Cancel</button>
      </div>
    `);
  },

  async submitUpload(){
    const errEl = document.getElementById('mat-err');
    const show = m => { errEl.textContent = m; errEl.classList.remove('hide'); };
    const fileInput = document.getElementById('mat-file');
    const file = fileInput?.files?.[0];
    if(!file){ show('Pick a file first.'); return; }
    if(file.size > 50 * 1024 * 1024){ show('File is larger than 50 MB. Compress it or split it.'); return; }
    const cat = document.getElementById('mat-cat').value;
    const renameTo = (document.getElementById('mat-name').value||'').trim();
    /* Sanitize filename — strip risky chars, keep the extension */
    const rawName = renameTo || file.name;
    const safeName = rawName.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, '_');
    const path = `${cat}/${safeName}`;

    ui.busy(true);
    const { error } = await sb.storage.from(materials.BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: true,
      contentType: file.type || 'application/octet-stream'
    });
    ui.busy(false);
    if(error){ show('Upload failed: '+error.message); return; }
    ui.closeModal();
    ui.toast('Uploaded');
    materials.render();
  },

  /* View — opens the file in a new tab so browsers render PDFs, images,
     and videos inline. What every rep uses to actually read/show a doc. */
  async view(path){
    const { data, error } = await sb.storage.from(materials.BUCKET).createSignedUrl(path, 300);
    if(error){ ui.err(error); return; }
    /* Try to open in a new tab. If popup blocker interferes, show a modal
       with a click-through link so we NEVER navigate the current tab away —
       protecting any in-progress order form the rep may have open. */
    const w = window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
    if(!w){
      ui.modal(`
        <h3>Popup was blocked</h3>
        <p style="margin:0 0 12px">Your browser blocked the new-tab popup for this material. Click the link below to open it — it opens in a new tab so any work you have in progress stays intact.</p>
        <p style="margin:0 0 12px"><a href="${esc(data.signedUrl)}" target="_blank" rel="noopener noreferrer" class="icon-btn primary" style="display:inline-block;text-decoration:none">Open material in new tab</a></p>
        <div class="muted" style="font-size:12px;margin-bottom:12px">Tip: allow popups for this site in your browser settings so future clicks open directly.</div>
        <div class="row"><button class="icon-btn ghost" onclick="ui.closeModal()">Close</button></div>
      `);
    }
  },

  /* Download — forces the browser to save the file locally rather than
     open inline. Admin-only. Uses the ?download query param that Supabase
     Storage honors to set Content-Disposition: attachment. */
  async download(path){
    if(!auth.isAdmin()){ ui.toast('Admin only — use View to open.'); return; }
    const filename = path.split('/').pop() || 'file';
    const { data, error } = await sb.storage.from(materials.BUCKET).createSignedUrl(path, 300, { download: filename });
    if(error){ ui.err(error); return; }
    const a = document.createElement('a');
    a.href = data.signedUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  async remove(path){
    if(!auth.isAdmin()){ ui.toast('Admin only.'); return; }
    if(!confirm(`Delete "${path.split('/').pop()}"? Reps will no longer be able to download it.`)) return;
    const { error } = await sb.storage.from(materials.BUCKET).remove([path]);
    if(error){ ui.err(error); return; }
    ui.toast('Deleted');
    materials.render();
  }
};

const cs = {
  _history: [],
  _modeBadge(){
    const mode = window.REFLECT_CONFIG?.AI_MODE || 'off';
    if(mode === 'live') return '<span class="badge ok">AI: live</span>';
    return '<span class="badge">AI: rule-based</span>';
  },
  init(){
    document.getElementById('chat-log').innerHTML='';
    cs._history = [];
    const mode = window.REFLECT_CONFIG?.AI_MODE || 'off';
    const badge = document.getElementById('cs-mode-badge');
    if(badge) badge.innerHTML = cs._modeBadge();
    if(mode === 'live'){
      cs.bot("Hi! Ask me anything about your accounts, orders, forecasts, or performance. I can look up records and reason about them.");
    } else {
      cs.bot("Hi! I'm in rule-based mode. Try \"orders for ACC-0001\", \"promo BOGO48\", or \"tax for license\". Real AI mode is coded and ready — flip AI_MODE to 'live' in config.js when your Anthropic API key is set up.");
    }
  },
  async send(){
    const inp = document.getElementById('chat-in');
    const text = inp.value.trim(); if(!text) return;
    inp.value=''; cs.user(text);
    const mode = window.REFLECT_CONFIG?.AI_MODE || 'off';
    if(mode === 'live'){
      await cs.sendToAI(text);
    } else {
      cs.bot(await cs.answer(text));
    }
  },
  async sendToAI(text){
    const log = document.getElementById('chat-log');
    /* loading indicator */
    const loading = document.createElement('div');
    loading.className = 'bubble bot';
    loading.textContent = '…thinking';
    log.appendChild(loading); log.scrollTop = log.scrollHeight;
    cs._history.push({ role: 'user', content: text });
    try{
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if(!token){ throw new Error('Not signed in'); }
      const url = window.REFLECT_CONFIG.AI_FUNCTION_URL;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'apikey': window.REFLECT_CONFIG.SUPABASE_KEY
        },
        body: JSON.stringify({ messages: cs._history })
      });
      const body = await res.json();
      loading.remove();
      if(!res.ok || body.error){
        cs.bot('⚠ ' + (body.error || `HTTP ${res.status}`));
        return;
      }
      cs._history.push({ role: 'assistant', content: body.message });
      cs.bot(body.message);
    } catch(e){
      loading.remove();
      cs.bot('⚠ ' + (e.message || 'Request failed'));
    }
  },
  user(t){ cs.push('user', t) },
  bot(t){ cs.push('bot', t) },
  push(who,t){
    const log = document.getElementById('chat-log');
    const div = document.createElement('div');
    div.className = 'bubble '+who; div.textContent = t;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
  },
  async answer(q){
    const s = q.toLowerCase();
    const accM = q.match(/ACC-\d{4}/i);
    const ordM = q.match(/ORD-\d+/i);
    const codeM = q.match(/[A-Z0-9]{4,}/);
    if(accM){
      const r = await sb.from('accounts').select('*').ilike('account_number', accM[0]).maybeSingle();
      if(!r.data) return 'No account with that number.';
      const last = await orders.lastForAccount(r.data.id);
      return `${r.data.business_name} (${r.data.type}) — rep ${r.data.rep_id}. Last order: ${last?last.order_number+' on '+last.placed_at.slice(0,10):'none yet'}.`;
    }
    if(ordM){
      const r = await sb.from('orders').select('*, account:accounts(business_name)').ilike('order_number', ordM[0]).maybeSingle();
      if(!r.data) return 'No such order.';
      return `${r.data.order_number} for ${r.data.account?.business_name||'—'}: ${fmt$(r.data.total)} (${r.data.status}). Promo: ${r.data.promo_code||'none'}.`;
    }
    if(s.includes('promo') || s.includes('code')){
      if(codeM){
        const p = cache.promotions.find(x=>x.code===codeM[0].toUpperCase());
        if(p) return `${p.code}: ${p.perks} (min ${p.min_qty||0} units, ${p.active?'active':'off'}).`;
      }
      return 'Active codes: ' + cache.promotions.filter(p=>p.active).map(p=>p.code).join(', ');
    }
    if(s.includes('tax')){
      return `Default tax is ${(ref.taxRateDefault()*100).toFixed(2)}% (${ref.taxLabelDefault()}). Accounts with a sales-tax license on file are not charged tax.`;
    }
    if(s.includes('ship')){
      return `Default shipping is ${fmt$(ref.shipDefault())}. Some volume promos (e.g. FREESHIP24) waive it.`;
    }
    if(s.includes('hi')||s.includes('help')){
      return 'I can look up an account # (ACC-0001), an order # (ORD-1001), or a promo code. Ask about tax, shipping, or reorder due.';
    }
    return 'Rule-based for now. Plug Claude API in to handle freeform questions.';
  }
};

/* ---------- PROFILE (my own contact info) ---------- */
const profile = {
  render(){
    const me = cache.me; if(!me) return;
    const set = (id, val) => { const el = document.getElementById(id); if(el) el.value = val ?? ''; };
    set('p-name', me.name);
    set('p-email', me.email);
    set('p-cell', me.cell);
    set('p-company', me.company);
    set('p-tax-id', me.tax_id);
    set('p-street', me.street);
    set('p-city', me.city);
    set('p-state', me.state);
    set('p-zip', me.zip);
    set('p-ro-repid', me.rep_id || '(not assigned)');
    set('p-ro-role', me.role);
    set('p-ro-comm', (me.commission ?? 0) + '%');
    set('p-ro-terr', (me.territory || []).join(', ') || '—');
    /* Onboarding banner: show if first time */
    const banner = document.getElementById('onboard-banner');
    if(banner) banner.classList.toggle('hide', !!me.onboarded);
  },
  async save(){
    const get = i => (document.getElementById(i)?.value || '').trim();
    const name = get('p-name'); const cell = get('p-cell');
    if(!name || !cell){
      ui.toast('Full name and cell phone are required.');
      return;
    }
    /* Email change flow */
    const newEmail = get('p-email').toLowerCase();
    const currentEmail = (cache.me.email || '').toLowerCase();
    let emailChangeNote = '';
    if(newEmail && newEmail !== currentEmail){
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)){
        ui.toast('Please enter a valid email address.'); return;
      }
      if(!confirm(`Change your email from "${currentEmail}" to "${newEmail}"?\n\nSupabase will send confirmation links to BOTH email addresses. The change takes effect only after you click the link in your new inbox. You can keep signing in with your current email until then.`)){
        document.getElementById('p-email').value = currentEmail;
        return;
      }
      const er = await sb.auth.updateUser({ email: newEmail });
      if(er.error){
        /* Revert the input so the user isn't misled into thinking the change stuck. */
        document.getElementById('p-email').value = currentEmail;
        ui.err(er.error);
        return;
      }
      emailChangeNote = ' Verification email sent to ' + newEmail + '.';
    }
    /* Profile fields (everything except email, which is handled via auth) */
    const payload = {
      name, cell,
      company: get('p-company') || null,
      tax_id: get('p-tax-id') || null,
      street: get('p-street') || null,
      city: get('p-city') || null,
      state: get('p-state') || null,
      zip: get('p-zip') || null,
      onboarded: true
    };
    const r = await sb.from('profiles').update(payload).eq('id', cache.me.id).select().single();
    if(r.error){ ui.err(r.error); return; }
    cache.me = r.data;
    document.getElementById('onboard-banner')?.classList.add('hide');
    ui.toast('Profile saved.' + emailChangeNote);
    profile.render();
  }
};

/* ---------- PROSPECTS ---------- */
const prospects = {
  async list(){
    const { data, error } = await sb.from('prospects').select('*').order('created_at',{ascending:false});
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async create(payload){
    payload.rep_id = payload.rep_id || auth.repId();
    payload.created_by = (await sb.auth.getUser()).data.user.id;
    const { data, error } = await sb.from('prospects').insert(payload).select().single();
    if(error){ ui.err(error); return null; }
    return data;
  },
  /* Convert a prospect to a real account. Creates the account, links it back, marks converted. */
  async convertToAccount(prospectId){
    const pr = await sb.from('prospects').select('*').eq('id', prospectId).single();
    if(pr.error){ ui.err(pr.error); return null; }
    const p = pr.data;
    if(p.status === 'converted'){ ui.toast('Already converted to ' + (p.converted_account_id || 'an account')); return null; }
    if(!confirm(`Convert "${p.name}" to a real account?\n\nThis creates an account with the prospect's info, then links them so reports can measure time-to-close.`)) return null;
    const userId = (await sb.auth.getUser()).data.user.id;
    /* Create the account from prospect fields */
    const acctPayload = {
      business_name: p.name,
      billing_name: p.primary_contact || null,
      email: p.email || null,
      cell: p.phone || null,
      business_address: p.city ? [p.city, p.state].filter(Boolean).join(', ') : null,
      type: p.account_type || 'Other',
      rep_id: p.rep_id || auth.repId(),
      created_by: userId
    };
    const ar = await sb.from('accounts').insert(acctPayload).select().single();
    if(ar.error){ ui.err(ar.error); return null; }
    /* Mark prospect converted with the new account ID. If this second write
       fails (RLS, network), roll back the just-created account so we don't
       leave a duplicate/orphan account with no prospect link. */
    const upd = await sb.from('prospects').update({
      status: 'converted',
      converted_account_id: ar.data.id
    }).eq('id', prospectId).select();
    if(upd.error || !upd.data || upd.data.length === 0){
      try { await sb.from('accounts').delete().eq('id', ar.data.id); } catch(_){}
      ui.err(upd.error || { message: 'Prospect update blocked by RLS. The just-created account has been rolled back — try again or contact your admin.' });
      return null;
    }
    ui.toast(`Converted to ${ar.data.account_number}`);
    return ar.data;
  }
};

/* ---------- FORECASTS ---------- */
const forecasts = {
  monthStart(d){ const x = d ? new Date(d) : new Date(); return new Date(x.getFullYear(), x.getMonth(), 1).toISOString().slice(0,10); },
  async list(filter){
    let q = sb.from('forecasts').select('*, account:accounts(business_name,account_number,type), prospect:prospects(name,account_type)').order('period_month',{ascending:false}).order('created_at',{ascending:false});
    if(filter?.period) q = q.eq('period_month', filter.period);
    if(filter?.rep_id) q = q.eq('rep_id', filter.rep_id);
    if(filter?.status) q = q.eq('status', filter.status);
    const { data, error } = await q;
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  weighted(f){ return Number(f.monthly_amount||0) * Number(f.close_probability||0)/100 },
  async render(){
    /* period filter */
    const periodSel = document.getElementById('fc-period');
    const cur = periodSel.value || forecasts.monthStart();
    periodSel.innerHTML = forecasts._periodOptions(cur);
    /* rep filter (admin only) */
    const repSel = document.getElementById('fc-rep');
    repSel.parentElement.style.display = auth.isAdmin() ? '' : 'none';
    if(auth.isAdmin()){
      const curR = repSel.value;
      repSel.innerHTML = '<option value="">All reps</option>' + cache.reps.filter(r=>r.rep_id).map(r=>`<option value="${esc(r.rep_id)}" ${curR===r.rep_id?'selected':''}>${esc(r.name||r.email)} (${esc(r.rep_id)})</option>`).join('');
    }
    const filter = { period: cur };
    if(auth.isAdmin() && repSel.value) filter.rep_id = repSel.value;
    const list = await forecasts.list(filter);

    /* summary tiles */
    const open = list.filter(f=>f.status==='open' || f.status==='pending');
    const totalMonthly = open.reduce((s,f)=>s+Number(f.monthly_amount||0),0);
    const totalQuarterly = open.reduce((s,f)=>s+Number(f.quarterly_amount||0),0);
    const weighted = open.reduce((s,f)=>s+forecasts.weighted(f),0);
    const casePrice = Number(cache.settings.forecast_case_price || 600);
    const casesNeeded = casePrice>0 ? Math.ceil(weighted/casePrice) : 0;

    document.getElementById('fc-k-monthly').textContent = fmt$(totalMonthly);
    document.getElementById('fc-k-quarterly').textContent = fmt$(totalQuarterly);
    document.getElementById('fc-k-weighted').textContent = fmt$(weighted);
    document.getElementById('fc-k-cases').textContent = casesNeeded + ' cases';

    /* admin rollup */
    const rollupWrap = document.getElementById('fc-admin-rollup');
    if(auth.isAdmin()){
      rollupWrap.parentElement.classList.remove('hide');
      const byRep = {}; const byType = {};
      open.forEach(f=>{
        const k = f.rep_id || '(unassigned)';
        byRep[k] = byRep[k] || {monthly:0,weighted:0,count:0};
        byRep[k].monthly += Number(f.monthly_amount||0);
        byRep[k].weighted += forecasts.weighted(f);
        byRep[k].count++;
        const t = f.account_type || f.account?.type || f.prospect?.account_type || 'Unknown';
        byType[t] = byType[t] || {monthly:0,weighted:0,count:0};
        byType[t].monthly += Number(f.monthly_amount||0);
        byType[t].weighted += forecasts.weighted(f);
        byType[t].count++;
      });
      const repRows = Object.entries(byRep).sort((a,b)=>b[1].weighted-a[1].weighted).map(([k,v])=>{
        const r = cache.reps.find(x=>x.rep_id===k);
        const cases = casePrice>0 ? Math.ceil(v.weighted/casePrice) : 0;
        return `<tr><td>${esc((r?.name||r?.email||k))}</td><td>${v.count}</td><td>${fmt$(v.monthly)}</td><td>${fmt$(v.weighted)}</td><td>${cases}</td></tr>`;
      }).join('');
      const typeRows = Object.entries(byType).sort((a,b)=>b[1].weighted-a[1].weighted).map(([k,v])=>{
        const cases = casePrice>0 ? Math.ceil(v.weighted/casePrice) : 0;
        return `<tr><td>${esc(k)}</td><td>${v.count}</td><td>${fmt$(v.monthly)}</td><td>${fmt$(v.weighted)}</td><td>${cases}</td></tr>`;
      }).join('');
      document.getElementById('fc-admin-rollup').innerHTML = `
        <h3 style="margin-top:0">By rep</h3>
        ${repRows ? `<table><tr><th>Rep</th><th># Forecasts</th><th>Monthly</th><th>Weighted</th><th>Cases Appose Lip TX</th></tr>${repRows}</table>` : '<div class="muted">No forecasts.</div>'}
        <h3 style="margin-top:14px">By account type</h3>
        ${typeRows ? `<table><tr><th>Type</th><th># Forecasts</th><th>Monthly</th><th>Weighted</th><th>Cases</th></tr>${typeRows}</table>` : '<div class="muted">No data.</div>'}
      `;
    } else {
      rollupWrap.parentElement.classList.add('hide');
    }

    /* detail list */
    const wrap = document.getElementById('fc-list');
    if(!list.length){ wrap.innerHTML = '<div class="muted">No forecasts for this period yet. Tap "+ New Forecast".</div>'; return; }
    wrap.innerHTML = list.map(f=>{
      const name = f.account?.business_name || f.prospect?.name || '(unlinked)';
      const tag = f.account_id ? `<span class="badge ok">Account</span>` : `<span class="badge warn">Prospect</span>`;
      const stat = {open:'info', pending:'warn', won:'ok', lost:'err'}[f.status] || 'info';
      return `<div class="list-item">
        <div class="grow">
          <div class="title">${esc(name)} ${tag} <span class="badge ${stat}">${esc(f.status)}</span></div>
          <div class="meta">${f.period_month} · ${esc(f.account_type||'')} · ${esc(f.appointment_kind||'')} · ${fmt$(f.monthly_amount)} · ${f.close_probability||0}% · weighted ${fmt$(forecasts.weighted(f))}</div>
        </div>
        <button class="icon-btn" onclick="forecasts.open('${f.id}')">Open</button>
      </div>`;
    }).join('');
  },
  _periodOptions(selected){
    const d = new Date(); const out = [];
    for(let i=-2; i<=10; i++){
      const m = new Date(d.getFullYear(), d.getMonth()+i, 1);
      const iso = m.toISOString().slice(0,10);
      const label = m.toLocaleString(undefined,{month:'long', year:'numeric'});
      out.push(`<option value="${iso}" ${selected===iso?'selected':''}>${label}</option>`);
    }
    return out.join('');
  },
  async openNew(){ forecasts.open(null) },
  async open(id){
    let f = null;
    if(id){
      const r = await sb.from('forecasts').select('*').eq('id', id).single();
      if(r.error){ ui.err(r.error); return; }
      f = r.data;
    }
    const isNew = !f;
    const fc = f || {
      period_month: forecasts.monthStart(),
      rep_id: auth.repId(),
      account_id: null, prospect_id: null,
      primary_contact:'', account_type:'Medical Spa',
      appointment_kind:'existing', appointment_date:null,
      monthly_amount:0, quarterly_amount:0,
      close_probability:50, status:'open',
      source:'', notes:''
    };
    const accs = await accounts.list();
    const accOpts = accs.map(a=>`<option value="acc:${a.id}" ${fc.account_id===a.id?'selected':''}>📒 ${esc(a.account_number)} — ${esc(a.business_name||'(unnamed)')}</option>`).join('');
    const prosList = await prospects.list();
    const prosOpts = prosList.map(p=>`<option value="pros:${p.id}" ${fc.prospect_id===p.id?'selected':''}>🌱 ${esc(p.name)}</option>`).join('');
    const typeOpts = cache.accountTypeList().map(t=>`<option ${fc.account_type===t?'selected':''}>${t}</option>`).join('');
    const periodOpts = forecasts._periodOptions(fc.period_month);

    ui.modal(`
      <h3>${isNew?'New forecast':'Edit forecast'}</h3>
      <div class="grid-2">
        <div><label>Forecast month</label><select id="f-period">${periodOpts}</select></div>
        <div><label>Account or Prospect</label>
          <select id="f-target">
            <option value="">— pick one or add a prospect below —</option>
            <optgroup label="Existing accounts">${accOpts}</optgroup>
            <optgroup label="Prospects">${prosOpts}</optgroup>
          </select>
          <div class="row" style="margin-top:6px;gap:6px">
            <button type="button" class="icon-btn ghost" onclick="forecasts.addProspectInline()">+ Add new prospect</button>
            <button type="button" class="icon-btn ghost" onclick="forecasts.convertSelectedProspect()">→ Convert to account</button>
          </div>
        </div>
        <div><label>Primary contact</label><input id="f-contact" value="${esc(fc.primary_contact)}"/></div>
        <div><label>Account type</label><select id="f-type">${typeOpts}</select></div>
        <div><label>Appointment kind</label>
          <select id="f-kind">
            <option value="existing" ${fc.appointment_kind==='existing'?'selected':''}>Existing customer</option>
            <option value="new" ${fc.appointment_kind==='new'?'selected':''}>New (prospect)</option>
          </select>
        </div>
        <div><label>Appointment date</label><input id="f-apptdate" type="date" value="${fc.appointment_date||''}"/></div>
        <div><label>Monthly forecast ($)</label><input id="f-monthly" type="number" step="0.01" value="${fc.monthly_amount||0}"/></div>
        <div><label>Quarterly forecast ($)</label><input id="f-quarterly" type="number" step="0.01" value="${fc.quarterly_amount||0}"/></div>
        <div><label>Likely closing (%)</label><input id="f-prob" type="number" min="0" max="100" value="${fc.close_probability||0}"/></div>
        <div><label>Status</label>
          <select id="f-status">
            ${['open','pending','won','lost'].map(s=>`<option ${fc.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div><label>Source of business</label><input id="f-source" value="${esc(fc.source||'')}" placeholder="Referral, trade show, cold call…"/></div>
        <div style="grid-column:1/-1"><label>Comments / notes</label><textarea id="f-notes">${esc(fc.notes||'')}</textarea></div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="forecasts.save('${fc.id||''}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="forecasts.remove('${fc.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
    /* set initial target dropdown value */
    if(fc.account_id) document.getElementById('f-target').value = 'acc:'+fc.account_id;
    else if(fc.prospect_id) document.getElementById('f-target').value = 'pros:'+fc.prospect_id;
  },
  async convertSelectedProspect(){
    const tgt = document.getElementById('f-target')?.value || '';
    if(!tgt.startsWith('pros:')){
      ui.toast('Pick a 🌱 Prospect from the dropdown first to convert.');
      return;
    }
    const prospectId = tgt.slice(5);
    const newAccount = await prospects.convertToAccount(prospectId);
    if(!newAccount) return;
    /* Re-point the forecast at the new account so this forecast is now tied to the account */
    const tgtSel = document.getElementById('f-target');
    const optGroups = tgtSel.querySelectorAll('optgroup');
    const accGroup = optGroups[0]; /* 'Existing accounts' is first */
    const newOpt = document.createElement('option');
    newOpt.value = 'acc:' + newAccount.id;
    newOpt.textContent = '📒 ' + newAccount.account_number + ' — ' + newAccount.business_name;
    accGroup.appendChild(newOpt);
    /* Remove the now-converted prospect option */
    const oldOpt = tgtSel.querySelector(`option[value="pros:${prospectId}"]`);
    if(oldOpt) oldOpt.remove();
    tgtSel.value = 'acc:' + newAccount.id;
  },
  async addProspectInline(){
    const name = prompt('Prospect (business) name:'); if(!name) return;
    const contact = prompt('Primary contact (optional):') || '';
    const city = prompt('City (optional):') || '';
    const state = prompt('State (optional):') || '';
    const p = await prospects.create({ name, primary_contact:contact, city, state, account_type:document.getElementById('f-type')?.value || null });
    if(!p) return;
    /* re-render the target select to include the new prospect */
    const tgt = document.getElementById('f-target');
    const opt = document.createElement('option');
    opt.value = 'pros:'+p.id;
    opt.textContent = '🌱 '+p.name;
    /* try to add into the Prospects optgroup */
    const groups = tgt.querySelectorAll('optgroup');
    const pg = groups[1] || tgt;
    pg.appendChild(opt);
    tgt.value = 'pros:'+p.id;
    ui.toast('Prospect added');
  },
  async save(id, isNew){
    const get = i=>document.getElementById(i).value;
    const target = get('f-target');
    if(!target){ ui.toast('Pick an account or add a prospect.'); return; }
    const [kind, refId] = target.split(':');
    const payload = {
      rep_id: auth.repId(),
      account_id: kind==='acc' ? refId : null,
      prospect_id: kind==='pros' ? refId : null,
      period_month: get('f-period'),
      primary_contact: get('f-contact'),
      account_type: get('f-type'),
      appointment_kind: get('f-kind'),
      appointment_date: get('f-apptdate') || null,
      monthly_amount: parseFloat(get('f-monthly')||'0'),
      quarterly_amount: parseFloat(get('f-quarterly')||'0'),
      close_probability: Math.min(100, Math.max(0, parseInt(get('f-prob')||'0',10))),
      status: get('f-status'),
      source: get('f-source'),
      notes: get('f-notes'),
      updated_at: new Date().toISOString()
    };
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('forecasts').insert(payload).select().single();
    } else {
      q = await sb.from('forecasts').update(payload).eq('id', id).select().single();
    }
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal(); ui.toast(isNew?'Forecast added':'Saved'); forecasts.render();
  },
  async remove(id){
    if(!confirm('Delete this forecast?')) return;
    const r = await sb.from('forecasts').delete().eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){
      alert('Delete did not go through. This forecast may belong to another rep.');
      return;
    }
    ui.closeModal(); ui.toast('Deleted'); forecasts.render();
  },
  async exportCsv(){
    if(!auth.isAdmin()){
      try{ await sb.rpc('log_export', { p_table_name:'forecasts', p_record_count:0, p_filter_desc:'BLOCKED — rep attempted' }); } catch(_){}
      ui.toast('Exports are limited to admins. All this data is visible on screen for you.');
      return;
    }
    /* export current view */
    forecasts.list({period: document.getElementById('fc-period').value}).then(async list=>{
      const period = document.getElementById('fc-period').value;
      const filterDesc = `Forecasts · ${period}`;
      try{ await sb.rpc('log_export', { p_table_name:'forecasts', p_record_count: list.length, p_filter_desc: filterDesc }); } catch(_){}
      const rows = [
        ...csvWatermark(filterDesc),
        ['Period','Rep','Type','Name','Primary contact','Account type','Appt kind','Appt date','Monthly','Quarterly','Close %','Weighted','Status','Source','Notes']
      ];
      list.forEach(f=>{
        const name = f.account?.business_name || f.prospect?.name || '(unlinked)';
        const type = f.account_id ? 'Account' : 'Prospect';
        rows.push([f.period_month, f.rep_id, type, name, f.primary_contact||'', f.account_type||'', f.appointment_kind||'', f.appointment_date||'', Number(f.monthly_amount||0).toFixed(2), Number(f.quarterly_amount||0).toFixed(2), f.close_probability||0, forecasts.weighted(f).toFixed(2), f.status, f.source||'', (f.notes||'').replace(/\n/g,' ')]);
      });
      const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
      const blob = new Blob([csv],{type:'text/csv'});
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `forecasts-${todayISO()}.csv`; a.click();
    });
  }
};

/* ---------- SHOPIFY INTEGRATION (admin) ---------- */
const shopify = {
  mode(){ return window.REFLECT_CONFIG?.SHOPIFY_MODE || 'off'; },
  async call(action, payload){
    const session = await sb.auth.getSession();
    const token = session.data.session?.access_token;
    if(!token) throw new Error('Not signed in');
    const res = await fetch(window.REFLECT_CONFIG.SHOPIFY_SYNC_URL, {
      method:'POST',
      headers:{
        'Authorization':'Bearer '+token,
        'Content-Type':'application/json',
        'apikey': window.REFLECT_CONFIG.SUPABASE_KEY
      },
      body: JSON.stringify({ action, payload: payload||{} })
    });
    const body = await res.json();
    if(!res.ok || body.error) throw new Error(body.error || ('HTTP '+res.status));
    return body;
  },
  async render(){
    const statusEl = document.getElementById('shopify-status');
    const actionsEl = document.getElementById('shopify-actions');
    const logEl = document.getElementById('shopify-log');
    if(!statusEl) return;

    if(shopify.mode() !== 'live'){
      statusEl.innerHTML = '<div class="alert">⚙️ Shopify integration is built but <b>not activated</b>. To turn it on: run <code>shopify-prep.sql</code>, deploy the Edge Functions, set the SHOPIFY_* secrets, then set <code>SHOPIFY_MODE: \'live\'</code> in config.js. Full steps in SHOPIFY_SETUP.md.</div>';
      if(actionsEl) actionsEl.classList.add('hide');
      if(logEl) logEl.innerHTML = '';
      return;
    }
    if(actionsEl) actionsEl.classList.remove('hide');

    const connected = cache.settings.shopify_connected === true;
    const store = cache.settings.shopify_store_url || '';
    const lastSync = cache.settings.shopify_last_product_sync;
    const count = cache.settings.shopify_product_count || 0;
    statusEl.innerHTML = connected
      ? `<div class="alert ok">✓ Connected to <b>${esc(store)}</b>. ${count} products synced${lastSync?' · last sync '+new Date(lastSync).toLocaleString():''}.</div>`
      : '<div class="alert warn">Not yet synced. Click "Test connection" then "Sync products now".</div>';

    /* recent sync log */
    const { data } = await sb.from('shopify_sync_log').select('*').order('at',{ascending:false}).limit(8);
    if(logEl){
      logEl.innerHTML = (data && data.length)
        ? `<h3 style="margin:12px 0 6px;font-size:13px;color:var(--muted)">Recent activity</h3>` + data.map(r=>{
            const badge = r.status==='success' ? 'ok' : 'err';
            return `<div class="list-item"><div class="grow">
              <div class="title"><span class="badge ${badge}">${esc(r.status)}</span> ${esc(r.action)}</div>
              <div class="meta">${new Date(r.at).toLocaleString()}${r.detail?' · '+esc(JSON.stringify(r.detail).slice(0,120)):''}</div>
            </div></div>`;
          }).join('')
        : '';
    }
  },
  /* Persistent inline result — replaces the transient toast so admins
     can read the full error/success message at their own pace. Includes
     the timestamp so repeated clicks are distinguishable. */
  showResult(kind, text){
    const el = document.getElementById('shopify-status'); if(!el) return;
    const cls = kind === 'ok' ? 'ok' : (kind === 'warn' ? 'warn' : 'err');
    const icon = kind === 'ok' ? '✓' : (kind === 'warn' ? '⚠' : '✕');
    const time = new Date().toLocaleTimeString();
    /* pre wrap preserves line breaks in longer error messages */
    el.innerHTML = `<div class="alert ${cls}" style="white-space:pre-wrap;font-size:13px"><b>${icon} ${time}</b>\n${esc(text)}</div>`;
  },
  async testConnection(){
    ui.busy(true);
    shopify.showResult('warn', 'Testing connection to Shopify…');
    try{
      const r = await shopify.call('test_connection');
      const shop = r.shop || {};
      const lines = [
        `Connected to ${shop.name || 'Shopify store'}`,
        shop.domain ? `Domain: ${shop.domain}` : null,
        shop.currency ? `Currency: ${shop.currency}` : null,
        shop.plan ? `Plan: ${shop.plan}` : null,
        r.api_version ? `Shopify API version: ${r.api_version}` : null,
        r.auth_mode ? `Auth mode: ${r.auth_mode}` : null,
      ].filter(Boolean).join('\n');
      shopify.showResult('ok', lines);
    }catch(e){
      shopify.showResult('err', 'Test connection failed:\n' + (e?.message || String(e)));
      console.error(e);
    }
    ui.busy(false);
  },
  async syncProducts(){
    if(!confirm('Pull products + inventory from Shopify? This updates the CRM product catalog and stock levels.')) return;
    ui.busy(true);
    shopify.showResult('warn', 'Syncing products from Shopify…');
    try{
      const r = await shopify.call('pull_products');
      await ref.loadAll();
      shopify.showResult('ok', `Synced ${r.upserted} products from Shopify. (${r.products_found} products / ${r.variants_found} variants found, ${r.skipped_no_sku} skipped for missing SKU.)`);
    }catch(e){
      shopify.showResult('err', 'Sync failed:\n' + (e?.message || String(e)));
      console.error(e);
    }
    ui.busy(false);
  },
  async registerWebhooks(){
    if(!confirm('Register webhooks in Shopify so the CRM auto-updates on inventory changes, product edits, and order events?\n\nSafe to run multiple times — existing subscriptions are detected and skipped.')) return;
    ui.busy(true);
    shopify.showResult('warn', 'Registering webhooks in Shopify…');
    try{
      const r = await shopify.call('register_webhooks');
      const created  = (r.results||[]).filter(x=>x.status==='created');
      const existing = (r.results||[]).filter(x=>x.status==='existing');
      const errors   = (r.results||[]).filter(x=>x.status==='error');
      const lines = [
        `Webhooks: ${created.length} created, ${existing.length} already existed, ${errors.length} failed.`,
        `Callback URL: ${r.callback_url || '(missing)'}`,
        '',
        ...created.map(x => `  + ${x.topic}`),
        ...existing.map(x => `  = ${x.topic} (already registered)`),
        ...errors.map(x => `  ✕ ${x.topic} — ${JSON.stringify(x.errors).slice(0,160)}`),
      ].join('\n');
      shopify.showResult(errors.length ? 'err' : 'ok', lines);
    }catch(e){
      shopify.showResult('err', 'Register webhooks failed:\n' + (e?.message || String(e)));
      console.error(e);
    }
    ui.busy(false);
  }
};

/* ---------- ADMIN MESSAGES (admin → reps) ---------- */
const messages = {
  async list(){
    const { data, error } = await sb.from('rep_messages').select('*').order('created_at',{ascending:false}).limit(100);
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async renderAdmin(){
    const wrap = document.getElementById('msg-list'); if(!wrap) return;
    const list = await messages.list();
    if(!list.length){ wrap.innerHTML='<div class="muted">No messages yet. Click "+ New message" to compose one.</div>'; return; }
    const kindIcon = {announcement:'📢', promo:'🏷', todo:'✅', message:'💬'};
    wrap.innerHTML = list.map(m=>{
      const rec = m.recipient_rep_id ? `to ${esc(m.recipient_rep_id)}` : 'broadcast (all reps)';
      const statusBadge = m.archived
        ? '<span class="badge">archived</span>'
        : (m.expires_at && new Date(m.expires_at) < new Date() ? '<span class="badge">expired</span>' : '<span class="badge ok">active</span>');
      return `<div class="list-item">
        <div class="grow">
          <div class="title">${kindIcon[m.kind]||'📌'} ${esc(m.title || m.body.slice(0,60))} <span class="badge info">${esc(m.kind)}</span> ${statusBadge}</div>
          <div class="meta">${esc(rec)} · ${new Date(m.created_at).toLocaleString()}${m.expires_at?' · expires '+new Date(m.expires_at).toLocaleDateString():''}</div>
          ${m.title ? `<div style="margin-top:4px;font-size:13px;color:var(--muted)">${esc(m.body)}</div>` : ''}
        </div>
        <button class="icon-btn" onclick="messages.toggleArchive('${m.id}', ${!m.archived})">${m.archived?'Restore':'Archive'}</button>
        <button class="icon-btn danger" onclick="messages.remove('${m.id}')">✕</button>
      </div>`;
    }).join('');
  },
  openNew(){
    const repOpts = cache.reps
      .filter(r=>r.rep_id && !r.disabled)
      .map(r=>`<option value="${esc(r.rep_id)}">${esc(r.name||r.email)} (${esc(r.rep_id)})</option>`).join('');
    ui.modal(`
      <h3>New message</h3>
      <div class="grid-2">
        <div><label>Kind</label>
          <select id="m-kind">
            <option value="announcement">📢 Announcement</option>
            <option value="promo">🏷 Promo to push</option>
            <option value="todo">✅ To-do</option>
            <option value="message">💬 1-on-1 message</option>
          </select>
        </div>
        <div><label>Send to</label>
          <select id="m-rep">
            <option value="">All reps (broadcast)</option>
            ${repOpts}
          </select>
        </div>
        <div style="grid-column:1/-1"><label>Title (optional)</label><input id="m-title" placeholder="e.g. Q3 push for med spas"/></div>
        <div style="grid-column:1/-1"><label>Body <span style="color:var(--brand)">*</span></label><textarea id="m-body" rows="4" placeholder="What you want them to see..."></textarea></div>
        <div><label>Expires (optional)</label><input id="m-expires" type="date"/></div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="messages.save()">Send</button>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Cancel</button>
      </div>
    `);
  },
  async save(){
    const get = i => (document.getElementById(i)?.value||'').trim();
    const body = get('m-body');
    if(!body){ ui.toast('Message body required'); return; }
    const userR = await sb.auth.getUser();
    const exp = get('m-expires');
    const payload = {
      sender_id: userR.data.user?.id || null,
      recipient_rep_id: get('m-rep') || null,
      kind: get('m-kind') || 'announcement',
      title: get('m-title') || null,
      body,
      expires_at: exp ? new Date(exp + 'T23:59:59').toISOString() : null
    };
    const r = await sb.from('rep_messages').insert(payload);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal();
    ui.toast(payload.recipient_rep_id ? 'Message sent to ' + payload.recipient_rep_id : 'Broadcast sent to all reps');
    messages.renderAdmin();
    dashboard.render();
  },
  async toggleArchive(id, archived){
    const r = await sb.from('rep_messages').update({archived}).eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){ ui.toast('Nothing changed — check your admin role.'); return; }
    messages.renderAdmin();
    dashboard.render();
  },
  async remove(id){
    if(!confirm('Delete this message permanently?')) return;
    const r = await sb.from('rep_messages').delete().eq('id', id).select();
    if(r.error){ ui.err(r.error); return; }
    if(!r.data || r.data.length === 0){ ui.toast('Delete did not go through — check your admin role.'); return; }
    messages.renderAdmin();
    dashboard.render();
  }
};

/* ---------- ADMIN ---------- */
const adminPanel = {
  /* One-shot backfill for legacy reps whose profile.rep_id is NULL
     (created before the auto-assign trigger existed). Runs every time
     admin opens the Reps tab; no-op when nothing needs patching. */
  async _backfillMissingRepIds(){
    try {
      const stale = await sb.from('profiles').select('id, email, name').is('rep_id', null);
      if(stale.error || !stale.data || !stale.data.length) return 0;
      const [profs, pend] = await Promise.all([
        sb.from('profiles').select('rep_id').not('rep_id', 'is', null),
        sb.from('pending_invites').select('rep_id').not('rep_id', 'is', null)
      ]);
      const usedNums = new Set(
        [...(profs.data||[]), ...(pend.data||[])]
          .map(x => { const m=/^R-(\d+)$/i.exec(String(x.rep_id||'')); return m?parseInt(m[1],10):0; })
          .filter(n => n > 0)
      );
      let next = 1;
      let patched = 0;
      for(const row of stale.data){
        while(usedNums.has(next)) next++;
        const newId = 'R-' + String(next).padStart(3, '0');
        const upd = await sb.from('profiles').update({ rep_id: newId }).eq('id', row.id);
        if(!upd.error){
          usedNums.add(next);
          patched++;
          console.log(`[REFLECT] Auto-assigned ${newId} to ${row.email}`);
        }
        next++;
      }
      return patched;
    } catch(_) { return 0; }
  },

  async renderRepsAndInvites(){
    /* Backfill legacy reps that predate the trigger, THEN load reps. */
    const patched = await adminPanel._backfillMissingRepIds();
    await profiles.loadReps();
    if(patched > 0){
      ui.toast(`Auto-assigned Rep IDs to ${patched} rep${patched===1?'':'s'} who were missing one.`);
    }
    const me = cache.me;

    /* Read search + filter (only present in the Reps view; safe defaults for admin view) */
    const search = (document.getElementById('reps-search')?.value || '').toLowerCase().trim();
    const filter = document.getElementById('reps-filter')?.value || 'all';

    /* Admin needs full rows (cell/address/commission) — reps_public doesn't include those. */
    const allReps = (cache.repsFull && cache.repsFull.length) ? cache.repsFull : (cache.reps || []);
    const filtered = allReps.filter(r => {
      if(filter === 'active'   && r.disabled) return false;
      if(filter === 'disabled' && !r.disabled) return false;
      if(filter === 'admin'    && r.role !== 'admin') return false;
      if(filter === 'rep'      && r.role !== 'rep') return false;
      if(!search) return true;
      const hay = [r.name, r.email, r.rep_id, r.cell, r.city, r.state, r.zip, (r.territory||[]).join(' ')]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.includes(search);
    });

    /* Stats (always reflect ALL reps, not the filtered subset) */
    const totalEl = document.getElementById('reps-stat-total');
    if(totalEl){
      const active = allReps.filter(r=>!r.disabled).length;
      const disabled = allReps.filter(r=>r.disabled).length;
      totalEl.textContent = allReps.length;
      document.getElementById('reps-stat-active').textContent = active;
      document.getElementById('reps-stat-disabled').textContent = disabled;
    }

    document.getElementById('rep-list').innerHTML = filtered.length ? filtered.map(r=>{
      const disabled = !!r.disabled;
      const isSelf = me && r.id === me.id;
      return `<div class="list-item" style="${disabled?'opacity:0.6':''}">
        <div class="grow">
          <div class="title">
            ${esc(r.name||r.email)}
            <span class="badge info">${esc(r.rep_id||'no rep id')}</span>
            <span class="badge ${r.role==='admin'?'ok':''}">${esc(r.role)}</span>
            ${disabled?'<span class="badge err">disabled</span>':''}
            ${isSelf?'<span class="badge">you</span>':''}
          </div>
          <div class="meta">${esc(r.email)}${r.cell?' · '+esc(r.cell):''}${(r.city||r.state)?' · '+esc([r.city, r.state].filter(Boolean).join(', ')):''} · commission ${r.commission||0}% · territory ${(r.territory||[]).join(', ')||'—'}</div>
        </div>
        <button class="icon-btn" onclick="adminPanel.openRepModal('${r.id}')">Edit</button>
        <button class="icon-btn" onclick="adminPanel.generateInviteLink('${esc(r.email).replace(/'/g,'&#39;')}')">🔗 Get link</button>
        <button class="icon-btn ghost" onclick="adminPanel.resetRepPassword('${esc(r.email).replace(/'/g,'&#39;')}')">Reset PW</button>
        ${isSelf ? '' : (disabled
          ? `<button class="icon-btn" onclick="adminPanel.enableRep('${r.id}')">Enable</button>`
          : `<button class="icon-btn danger" onclick="adminPanel.disableRep('${r.id}')">Disable</button>`)}
        ${isSelf ? '' : `<button class="icon-btn danger" onclick="adminPanel.deleteRep('${r.id}', '${esc(r.email).replace(/'/g,'&#39;')}', '${esc(r.name||r.email).replace(/'/g,'&#39;')}')">Delete</button>`}
      </div>`;
    }).join('') : `<div class="muted">${search||filter!=='all' ? 'No reps match the search/filter.' : 'No reps yet.'}</div>`;

    /* pending invites */
    const inviteWrap = document.getElementById('invite-list');
    if(inviteWrap){
      const invites = await adminPanel.loadInvites();
      const pendingStatEl = document.getElementById('reps-stat-pending');
      if(pendingStatEl) pendingStatEl.textContent = invites.length;
      inviteWrap.innerHTML = invites.length ? invites.map(i=>`
        <div class="list-item">
          <div class="grow">
            <div class="title">${esc(i.email)} <span class="badge warn">${esc(i.rep_id||'no rep id')}</span> <span class="badge">${esc(i.role)}</span></div>
            <div class="meta">Will become: ${esc(i.name||'(name from email)')} · commission ${i.commission||0}% · invited ${new Date(i.created_at).toLocaleDateString()}</div>
          </div>
          <button class="icon-btn primary" onclick="adminPanel.generateInviteLink('${esc(i.email).replace(/'/g,'&#39;')}')">🔗 Get link</button>
          <button class="icon-btn" onclick="adminPanel.openInviteModal('${esc(i.email).replace(/'/g,'&#39;')}')">Edit</button>
          <button class="icon-btn danger" onclick="adminPanel.cancelInvite('${esc(i.email).replace(/'/g,'&#39;')}')">Cancel</button>
        </div>`).join('') : '<div class="muted" style="font-size:13px">No pending invites. New reps you add via "+ Add rep" appear here until they sign up.</div>';
    }
  },
  async render(){
    /* Admin tab no longer renders reps directly (moved to Reps tab),
       but other modules (messages, etc.) rely on the rep cache. */
    await profiles.loadReps();

    /* types */
    document.getElementById('type-list').innerHTML =
      cache.accountTypeList().map(t=>`<span class="badge info" style="padding:6px 10px">${esc(t)} <a href="#" onclick="adminPanel.removeType('${esc(t)}');return false" style="margin-left:6px;color:#fecaca">✕</a></span>`).join('');
    /* settings */
    document.getElementById('set-ship').value = ref.shipDefault();
    document.getElementById('set-tax').value  = ref.taxRateDefault();
    document.getElementById('set-taxlbl').value = ref.taxLabelDefault();
    document.getElementById('set-disc').value = ref.highDiscPct();
    document.getElementById('set-reorder').value = ref.reorderDays();
    document.getElementById('set-stock').value = ref.lowStock();
    /* products */
    productsAdmin.render();
    /* audit log */
    auditLog.render();
    /* messages */
    messages.renderAdmin();
    /* shopify */
    shopify.render();
  },
  async loadInvites(){
    const { data, error } = await sb.from('pending_invites').select('*').order('created_at',{ascending:false});
    if(error){ return []; }
    return data || [];
  },
  async openRepModal(id){
    /* Admin edit needs the full profile (address, cell, commission, tax_id).
       cache.reps is the reps_public view (public columns only); use cache.repsFull. */
    const full = (cache.repsFull && cache.repsFull.length) ? cache.repsFull : cache.reps;
    const r = id ? full.find(x=>x.id===id) : null;
    const isNew = !r;

    /* Build the Rep ID dropdown from every rep + pending invite currently
       in the system. Sequential R-001 through max(existing)+5, with taken
       slots disabled and labeled by owner. Prevents collisions at pick time. */
    const pendingRes = await sb.from('pending_invites').select('rep_id, email, name');
    const pendingList = pendingRes.data || [];
    const takenBy = {};
    full.forEach(x => { if(x.rep_id) takenBy[String(x.rep_id).toUpperCase()] = {name:x.name, email:x.email, kind:'rep'}; });
    pendingList.forEach(x => { if(x.rep_id) takenBy[String(x.rep_id).toUpperCase()] = {name:x.name, email:x.email, kind:'invite'}; });
    const usedNums = Object.keys(takenBy).map(k => { const m=/^R-(\d+)$/i.exec(k); return m?parseInt(m[1],10):0; }).filter(n=>n>0);
    const maxNum = usedNums.length ? Math.max(0, ...usedNums) : 0;
    const showUpTo = Math.max(10, maxNum + 5);
    const currentRepId = (r?.rep_id || '').toUpperCase();
    /* Pre-select: current rep's own ID for edits, first available for new. */
    let firstAvailable = null;
    for(let i=1; i<=showUpTo; i++){
      const cand = 'R-' + String(i).padStart(3, '0');
      if(!takenBy[cand]){ firstAvailable = cand; break; }
    }
    const preselect = isNew ? firstAvailable : (currentRepId || firstAvailable);
    const repIdOpts = [];
    for(let i=1; i<=showUpTo; i++){
      const cand = 'R-' + String(i).padStart(3, '0');
      const owner = takenBy[cand];
      const isCurrent = (cand === currentRepId);
      const isSelected = (cand === preselect);
      if(owner && !isCurrent){
        const who = owner.name || owner.email || '?';
        const marker = owner.kind === 'invite' ? 'pending' : 'taken';
        repIdOpts.push(`<option value="${cand}" disabled>${cand} — ${marker} (${esc(who)})</option>`);
      } else {
        const label = isCurrent ? `${cand} (this rep)` : `${cand} (available)`;
        repIdOpts.push(`<option value="${cand}" ${isSelected?'selected':''}>${label}</option>`);
      }
    }
    const repIdOptions = repIdOpts.join('');

    const prof = r || { email:'', name:'', rep_id:'', role:'rep', commission:20, territory:[], cell:'', company:'', street:'', city:'', state:'', zip:'' };
    ui.modal(`
      <h3>${isNew?'Add rep':'Edit '+esc(prof.name||prof.email)}</h3>
      ${isNew ? '<p class="muted" style="font-size:13px;margin:0 0 12px">If this email has already signed up, this updates their profile. If not, the settings are saved as a pending invite and applied automatically when they sign up.</p>' : ''}
      <div class="grid-2">
        <div><label>Email ${isNew?'':'<span class="muted" style="font-size:11px">(edit updates login)</span>'}</label><input id="r-email" type="email" value="${esc(prof.email)}" autocapitalize="none"/></div>
        <div><label>Full name</label><input id="r-name" value="${esc(prof.name||'')}"/></div>
        <div><label>Cell phone</label><input id="r-cell" type="tel" autocomplete="tel" inputmode="tel" placeholder="555-555-5555" value="${esc(prof.cell||'')}" onblur="normalizeUSPhone(this)"/></div>
        <div><label>Company (optional)</label><input id="r-company" value="${esc(prof.company||'')}"/></div>
        <div><label>Tax ID / EIN (optional)</label><input id="r-tax-id" value="${esc(prof.tax_id||'')}" placeholder="For 1099 purposes"/></div>
        <div></div>
        <div><label>Rep ID <span class="muted" style="font-size:11px">(pick from list, or type any custom ID on the right)</span></label>
          <div class="row" style="gap:6px;align-items:stretch">
            <select id="r-repid" style="flex:1">${repIdOptions}</select>
            <input id="r-repid-custom" placeholder="Or R-###" style="width:110px" title="Type a custom Rep ID here to override the dropdown selection"/>
          </div>
        </div>
        <div><label>Role</label>
          <select id="r-role">
            <option value="rep" ${prof.role==='rep'?'selected':''}>rep</option>
            <option value="admin" ${prof.role==='admin'?'selected':''}>admin</option>
          </select>
        </div>
        <div><label>Commission %</label><input id="r-comm" type="number" step="0.1" value="${prof.commission ?? 20}"/></div>
        <div><label>Territory (comma-separated)</label><input id="r-terr" value="${esc((prof.territory||[]).join(', '))}" placeholder="Denver Metro, Boulder, Colorado Springs"/></div>
        <div style="grid-column:1/-1"><label>Street address</label><input id="r-street" value="${esc(prof.street||'')}"/></div>
        <div><label>City</label><input id="r-city" value="${esc(prof.city||'')}"/></div>
        <div><label>State</label><select id="r-state">${usStateOptions(prof.state)}</select></div>
        <div><label>ZIP</label><input id="r-zip" value="${esc(prof.zip||'')}"/></div>
        <div style="grid-column:1/-1;padding:10px;border:1px solid var(--line);background:rgba(212,160,23,0.08);border-radius:8px;margin-top:6px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input id="r-testmode" type="checkbox" ${prof.test_mode?'checked':''} style="width:auto"/>
            <span>🧪 <b>Test mode</b> — orders this rep finalizes will NOT push to Shopify. Use this for reps who are learning the system so they can't accidentally send real invoices.</span>
          </label>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="adminPanel.saveRep('${id||''}', ${isNew})">Save</button>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Cancel</button>
      </div>
    `);
  },
  async openInviteModal(email){
    const inv = (await adminPanel.loadInvites()).find(i=>i.email===email);
    if(!inv) return;
    ui.modal(`
      <h3>Edit pending invite — ${esc(inv.email)}</h3>
      <p class="muted" style="font-size:13px;margin:0 0 12px">These settings will apply when this person signs up at the CRM URL.</p>
      <div class="grid-2">
        <div><label>Email</label><input id="r-email" value="${esc(inv.email)}" disabled/></div>
        <div><label>Name</label><input id="r-name" value="${esc(inv.name||'')}"/></div>
        <div><label>Rep ID</label><input id="r-repid" value="${esc(inv.rep_id||'')}" placeholder="R-002"/></div>
        <div><label>Role</label>
          <select id="r-role">
            <option value="rep" ${inv.role==='rep'?'selected':''}>rep</option>
            <option value="admin" ${inv.role==='admin'?'selected':''}>admin</option>
          </select>
        </div>
        <div><label>Commission %</label><input id="r-comm" type="number" step="0.1" value="${inv.commission ?? 20}"/></div>
        <div><label>Territory (comma-separated)</label><input id="r-terr" value="${esc((inv.territory||[]).join(', '))}" placeholder="Denver Metro, Boulder, Colorado Springs"/></div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="adminPanel.saveInvite('${esc(inv.email).replace(/'/g,'&#39;')}')">Save</button>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Cancel</button>
      </div>
    `);
  },
  async saveRep(id, isNew){
    const get = i => (document.getElementById(i)?.value || '');
    const email = get('r-email').trim().toLowerCase();
    const testMode = !!document.getElementById('r-testmode')?.checked;
    /* Rep ID is REQUIRED at save time. Prefer the custom-text override
       if the admin typed anything there; otherwise use the dropdown
       selection. If both are blank (shouldn't happen — dropdown always
       has a selection), fall back to next-available. */
    const customVal = (document.getElementById('r-repid-custom')?.value || '').trim().toUpperCase();
    let repIdValue = customVal || get('r-repid').trim().toUpperCase();
    if(!repIdValue){
      const next = await adminPanel._nextAvailableRepId();
      repIdValue = next || '';
    }
    if(repIdValue){
      const dupRep = (cache.repsFull||cache.reps||[]).find(x => x.id !== id && (x.rep_id||'').toUpperCase() === repIdValue);
      if(dupRep){
        alert(`Rep ID ${repIdValue} is already assigned to ${dupRep.name || dupRep.email}. Please pick a different Rep ID.`);
        return;
      }
    }
    const payload = {
      name: get('r-name').trim(),
      rep_id: repIdValue || null,
      role: get('r-role'),
      commission: parseFloat(get('r-comm')||'0') || 0,
      territory: get('r-terr').split(',').map(x=>x.trim()).filter(Boolean),
      cell: get('r-cell').trim() || null,
      company: get('r-company').trim() || null,
      tax_id: get('r-tax-id').trim() || null,
      street: get('r-street').trim() || null,
      city: get('r-city').trim() || null,
      state: get('r-state').trim() || null,
      zip: get('r-zip').trim() || null,
      test_mode: testMode
    };
    if(!isNew){
      /* Check if email changed. If so, we need to update auth.users
         (via Edge Function) as well as the profiles table. */
      const currentProf = (cache.repsFull||cache.reps||[]).find(x=>x.id===id);
      const oldEmail = (currentProf?.email || '').trim().toLowerCase();
      const emailChanged = email && email !== oldEmail;

      if(emailChanged){
        if(!confirm(`Change ${oldEmail}'s email to ${email}?\n\nThis updates their login. They'll need to sign in with the new email going forward. A fresh sign-in link will be generated automatically.`)) return;
        const inviteUrlBase = window.REFLECT_CONFIG?.ADMIN_INVITE_URL;
        if(!inviteUrlBase){ ui.toast('ADMIN_INVITE_URL not set — cannot update email.'); return; }
        try{
          const session = await sb.auth.getSession();
          const token = session.data.session?.access_token;
          const res = await fetch(inviteUrlBase, {
            method:'POST',
            headers:{
              'Authorization':'Bearer '+token,
              'Content-Type':'application/json',
              'apikey': window.REFLECT_CONFIG.SUPABASE_KEY
            },
            body: JSON.stringify({ mode:'update_email', user_id: id, email, redirect_to: location.origin + location.pathname })
          });
          const data = await res.json();
          if(!res.ok || data.error){
            ui.err(new Error('Email change failed: ' + (data.error || 'HTTP '+res.status) + '. Redeploy the admin-invite Edge Function so it supports mode:update_email.'));
            return;
          }
          /* Auth + profiles.email now updated by the Edge Function.
             Update the rest of the profile fields (payload minus email is fine — email was updated separately). */
          const q = await sb.from('profiles').update(payload).eq('id', id);
          if(q.error){ ui.err(q.error); return; }
          ui.closeModal();
          ui.toast(`Email changed to ${email}. Fresh sign-in link ready.`);
          /* Show the new invite link modal so admin can send it */
          const firstName = (payload.name||'').trim().split(/\s+/)[0]||'';
          if(data.invite_url) adminPanel.showInviteLinkModal(email, data.invite_url, false, firstName);
          adminPanel.renderRepsAndInvites();
          return;
        } catch(e){ ui.err(e); return; }
      }

      /* No email change — plain profile update */
      const q = await sb.from('profiles').update(payload).eq('id', id);
      if(q.error){ ui.err(q.error); return; }
      ui.closeModal(); ui.toast('Saved'); adminPanel.renderRepsAndInvites();
      return;
    }
    if(!email){ ui.toast('Email required'); return; }
    /* Does this email already have a profile? If so update; else upsert pending invite */
    const ex = await sb.from('profiles').select('id').ilike('email', email).maybeSingle();
    if(ex.data){
      const q = await sb.from('profiles').update(payload).eq('id', ex.data.id);
      if(q.error){ ui.err(q.error); return; }
      ui.closeModal(); ui.toast('Existing user — profile updated.'); adminPanel.renderRepsAndInvites();
      return;
    }
    /* Upsert pending invite */
    const me = (await sb.auth.getUser()).data.user;
    const q = await sb.from('pending_invites').upsert({
      email, ...payload, invited_by: me?.id || null
    });
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal();
    ui.toast(`Invite saved for ${email}. Generating one-click sign-in link…`);
    /* Generate a magic-link URL for this rep. Admin can copy + send it
       however (text/email/Slack). Rep clicks → auto signed in. */
    await adminPanel.generateInviteLink(email);
    adminPanel.renderRepsAndInvites();
  },

  /* Calls the admin-invite Edge Function to (1) create the auth user
     if new and (2) return a one-click magic-link URL. Displays it in a
     modal with a copy button. Looks up the rep's name from
     pending_invites or profiles so the message can be personalized. */
  /* Compute the next available R-### by scanning existing rep_ids on both
     live profiles and pending invites. Shared by openRepModal and
     generateInviteLink so both stay in sync. */
  async _nextAvailableRepId(){
    /* Prefer the server-side atomic allocator (audit-final-fixes.sql) so
       two concurrent admins never end up with the same rep_id. If the RPC
       isn't installed yet (migration not run) fall back to the local
       max-plus-one calculation — race exists but is a rare corner case. */
    try {
      const rpc = await sb.rpc('allocate_next_rep_id');
      if(rpc.error === null && rpc.data) return rpc.data;
    } catch(_) { /* fall through to local calc */ }
    try {
      const [profs, pend] = await Promise.all([
        sb.from('profiles').select('rep_id'),
        sb.from('pending_invites').select('rep_id')
      ]);
      const allIds = [
        ...((profs.data || []).map(x => x.rep_id)),
        ...((pend.data || []).map(x => x.rep_id))
      ];
      const nums = allIds.map(v => {
        const m = /^R-(\d+)$/i.exec(String(v || ''));
        return m ? parseInt(m[1], 10) : 0;
      });
      const max = nums.length ? Math.max(0, ...nums) : 0;
      return 'R-' + String(max + 1).padStart(3, '0');
    } catch(_) { return null; }
  },

  async generateInviteLink(email){
    const url = window.REFLECT_CONFIG?.ADMIN_INVITE_URL;
    if(!url){ ui.toast('ADMIN_INVITE_URL not set in config.js.'); return; }
    ui.busy(true);
    try{
      /* If this rep already has a profile but no Rep ID, assign one now.
         The DB trigger only fires on first signup — existing profiles
         without a rep_id would otherwise stay broken until an admin
         manually edited them. This closes that gap for every invite. */
      const existing = await sb.from('profiles').select('id, rep_id').ilike('email', email).maybeSingle();
      if(existing.data && !existing.data.rep_id){
        const nextId = await adminPanel._nextAvailableRepId();
        if(nextId){
          const upd = await sb.from('profiles').update({ rep_id: nextId }).eq('id', existing.data.id);
          if(!upd.error){
            ui.toast(`Assigned Rep ID ${nextId} to ${email}.`);
          }
        }
      }

      /* Fetch the rep's name so the SMS/email can be personalized. */
      let repName = '';
      const inv = await sb.from('pending_invites').select('name').ilike('email', email).maybeSingle();
      if(inv.data?.name){
        repName = inv.data.name;
      } else {
        const prof = await sb.from('profiles').select('name').ilike('email', email).maybeSingle();
        if(prof.data?.name) repName = prof.data.name;
      }
      const firstName = (repName || '').trim().split(/\s+/)[0] || '';

      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      if(!token){ ui.toast('Sign in required.'); ui.busy(false); return; }
      const res = await fetch(url, {
        method:'POST',
        headers:{
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'apikey': window.REFLECT_CONFIG.SUPABASE_KEY
        },
        body: JSON.stringify({ email, redirect_to: location.origin + location.pathname })
      });
      const data = await res.json();
      ui.busy(false);
      if(!res.ok || data.error){
        ui.err(new Error('Invite link generation failed: ' + (data.error || 'HTTP '+res.status) + '. Deploy the admin-invite Edge Function first (supabase/functions/admin-invite/index.ts).'));
        return;
      }
      adminPanel.showInviteLinkModal(email, data.invite_url, data.is_new_user, firstName);
    } catch(e){
      ui.busy(false);
      ui.err(e);
    }
  },

  /* Persistent modal — shows the invite URL big and copyable.
     Personalizes the SMS/email body with the rep's first name if we have it. */
  showInviteLinkModal(email, url, isNewUser, firstName){
    const greet = firstName ? `Hi ${firstName}` : 'Hi';
    /* Short, plain-language default that assumes zero technical background.
       Deliberately doesn't mention "magic link" or "authentication" — just
       "tap here." No password. No sign-up form. Just tap. */
    const smsBody = `${greet}! You've been invited to the Reflect Co CRM. Tap the link below to sign in — no password needed:\n\n${url}\n\nThis link works one time only. Save this page as a bookmark once you're in so you can come back easily.`;
    const emailSubject = 'Your Reflect Co CRM sign-in link';
    const emailBody = `${greet},\n\nYou've been invited to the Reflect Co CRM. Just tap the link below and you'll be signed in automatically — no password, no sign-up form.\n\n${url}\n\nOnce you're in, save the page as a bookmark (or add to your phone's Home Screen) so you can come back later. The next time you visit, either use the same link or click "Email me a sign-in link" on the login page.\n\nIf the link doesn't work, tell Dan and he'll send a fresh one.\n\nThanks!`;
    const mailtoUrl = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;
    const smsUrl = `sms:?&body=${encodeURIComponent(smsBody)}`;
    ui.modal(`
      <h3>Sign-in link ready ${firstName?'for '+esc(firstName):''}</h3>
      <p style="font-size:13px;margin:0 0 8px">
        Send this to <b>${esc(email)}</b>. When they tap it, they're in — no password, no sign-up form.
        ${isNewUser ? '' : '<br><span class="muted" style="font-size:12px">(User already existed — this is a fresh sign-in link.)</span>'}
      </p>
      <div class="row" style="gap:8px;margin-bottom:12px;flex-wrap:wrap">
        <a class="icon-btn primary" href="${esc(smsUrl)}" style="text-decoration:none">📱 Send via Text</a>
        <a class="icon-btn primary" href="${esc(mailtoUrl)}" style="text-decoration:none">✉️ Send via Email</a>
        <button class="icon-btn" onclick="adminPanel._copyInviteLink()">📋 Copy link only</button>
      </div>
      <details>
        <summary style="cursor:pointer;font-size:12px;color:var(--muted)">Preview / manual link</summary>
        <label style="display:block;font-size:12px;color:var(--muted);margin:8px 0 4px">The one-click sign-in URL:</label>
        <textarea id="invite-url-ta" readonly rows="4" style="width:100%;font-family:monospace;font-size:11px;padding:8px;border-radius:6px;word-break:break-all;background:var(--panel-2);border:1px solid var(--line);color:var(--ink)">${esc(url)}</textarea>
        <label style="display:block;font-size:12px;color:var(--muted);margin:12px 0 4px">SMS message that will be pre-filled:</label>
        <textarea readonly rows="6" style="width:100%;font-family:inherit;font-size:12px;padding:8px;border-radius:6px;background:var(--panel-2);border:1px solid var(--line);color:var(--ink)">${esc(smsBody)}</textarea>
      </details>
      <div class="row" style="gap:8px;margin-top:12px">
        <div class="grow"></div>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
      <p class="muted" style="font-size:11px;margin-top:12px">
        ⚠ Link is single-use and expires in ~1 hour. If the rep doesn't tap it in time, click <b>🔗 Get link</b> on their row for a fresh one.
      </p>
    `);
  },

  _copyInviteLink(){
    const ta = document.getElementById('invite-url-ta');
    if(!ta) return;
    ta.select();
    try{
      navigator.clipboard.writeText(ta.value).then(
        () => ui.toast('✓ Link copied — paste into text/email/Slack'),
        () => { document.execCommand('copy'); ui.toast('✓ Link copied'); }
      );
    } catch(_){ document.execCommand('copy'); ui.toast('✓ Link copied'); }
  },
  async saveInvite(email){
    const get = i => document.getElementById(i).value;
    const payload = {
      email,
      name: get('r-name').trim(),
      rep_id: get('r-repid').trim() || null,
      role: get('r-role'),
      commission: parseFloat(get('r-comm')||'0') || 0,
      territory: get('r-terr').split(',').map(x=>x.trim()).filter(Boolean)
    };
    const q = await sb.from('pending_invites').upsert(payload).select();
    if(q.error){ ui.err(q.error); return; }
    if(!q.data || q.data.length === 0){ ui.toast('Save did not go through — check your admin role.'); return; }
    ui.closeModal(); ui.toast('Invite updated'); adminPanel.renderRepsAndInvites();
  },
  async cancelInvite(email){
    if(!confirm(`Cancel invite for ${email}?`)) return;
    const q = await sb.from('pending_invites').delete().eq('email', email).select();
    if(q.error){ ui.err(q.error); return; }
    if(!q.data || q.data.length === 0){ ui.toast('Cancel did not go through — check your admin role.'); return; }
    ui.toast('Invite cancelled'); adminPanel.renderRepsAndInvites();
  },
  async disableRep(id){
    if(!confirm('Disable this rep? They will not be able to sign in, but their data stays for history.')) return;
    const q = await sb.from('profiles').update({ disabled: true }).eq('id', id).select();
    if(q.error){ ui.err(q.error); return; }
    if(!q.data || q.data.length === 0){ alert('Disable did not go through — check your admin role.'); return; }
    ui.toast('Disabled'); adminPanel.renderRepsAndInvites();
  },
  async enableRep(id){
    const q = await sb.from('profiles').update({ disabled: false }).eq('id', id).select();
    if(q.error){ ui.err(q.error); return; }
    if(!q.data || q.data.length === 0){ alert('Enable did not go through — check your admin role.'); return; }
    ui.toast('Re-enabled'); adminPanel.renderRepsAndInvites();
  },
  async resetRepPassword(email){
    if(!confirm(`Send password reset email to ${email}?`)) return;
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname + '#reset'
    });
    if(error){ ui.err(error); return; }
    ui.toast('Reset email sent to ' + email);
  },
  /* Hard delete: removes the auth user AND the profile (via FK cascade).
     Historical orders/accounts stay but lose rep attribution (rep_id
     text stays; the FK is on created_by uuid with set null).
     Uses the admin-invite Edge Function's delete_user mode which
     requires service_role. */
  async deleteRep(id, email, name){
    const label = name || email;
    if(!confirm(`Permanently delete ${label}?\n\nThis removes their login and profile. Historical orders/accounts they created stay in the system but their user reference is set to null. This cannot be undone.\n\nType "delete" to confirm.`)) return;
    const confirmText = prompt(`To confirm deletion of ${label}, type: delete`);
    if((confirmText||'').trim().toLowerCase() !== 'delete'){ ui.toast('Delete cancelled — text did not match.'); return; }
    const url = window.REFLECT_CONFIG?.ADMIN_INVITE_URL;
    if(!url){ ui.toast('ADMIN_INVITE_URL not set — cannot delete via UI. Use SQL fallback.'); return; }
    ui.busy(true);
    try{
      const session = await sb.auth.getSession();
      const token = session.data.session?.access_token;
      const res = await fetch(url, {
        method:'POST',
        headers:{
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          'apikey': window.REFLECT_CONFIG.SUPABASE_KEY
        },
        body: JSON.stringify({ mode:'delete_user', user_id: id, email })
      });
      const data = await res.json();
      ui.busy(false);
      if(!res.ok || data.error){
        ui.err(new Error('Delete failed: ' + (data.error || 'HTTP '+res.status) + '. If the Edge Function needs redeploying, tell Dan.'));
        return;
      }
      ui.toast(`${label} deleted permanently.`);
      adminPanel.renderRepsAndInvites();
    } catch(e){
      ui.busy(false);
      ui.err(e);
    }
  },
  async addType(){
    const t = document.getElementById('new-type').value.trim(); if(!t) return;
    const q = await sb.from('account_types').upsert({name:t, sort_order:50});
    if(q.error){ ui.err(q.error); return; }
    document.getElementById('new-type').value='';
    await ref.loadAll();
    adminPanel.render();
  },
  async removeType(t){
    const q = await sb.from('account_types').delete().eq('name', t);
    if(q.error){ ui.err(q.error); return; }
    await ref.loadAll();
    adminPanel.render();
  },
  async saveSettings(){
    const upserts = [
      { key:'shipping_default', value: Number(document.getElementById('set-ship').value||0) },
      { key:'tax_rate_default', value: Number(document.getElementById('set-tax').value||0) },
      { key:'tax_label_default', value: document.getElementById('set-taxlbl').value },
      { key:'high_discount_alert_pct', value: Number(document.getElementById('set-disc').value||0) },
      { key:'reorder_due_days', value: Number(document.getElementById('set-reorder').value||0) },
      { key:'low_stock_threshold', value: Number(document.getElementById('set-stock').value||0) }
    ];
    for(const r of upserts){
      const q = await sb.from('settings').upsert({ key:r.key, value:r.value, updated_at:new Date().toISOString() });
      if(q.error){ ui.err(q.error); return; }
    }
    await ref.loadAll();
    ui.toast('Settings saved');
  }
};

/* ---------- SECURITY: MFA (TOTP + Passkey) ---------- */
const security = {
  /* List enrolled factors for current user. Returns { totp: [...], webauthn: [...] } shape varies by SDK version. */
  async listFactors(){
    const r = await sb.auth.mfa.listFactors();
    if(r.error) throw r.error;
    /* Explicitly gather every known factor slot rather than relying on
       r.data.all — if a Supabase-JS bump stops populating that combined
       field, enrolled passkeys/phone factors would silently disappear
       from the Security modal. Building the set slot-by-slot is durable. */
    const buckets = [
      r.data?.all || [],
      r.data?.totp || [],
      r.data?.phone || [],
      r.data?.webauthn || [],
    ];
    /* Dedupe by id in case r.data.all overlaps the per-type buckets. */
    const seen = new Set();
    const all = [];
    for(const b of buckets){
      for(const f of b){
        if(!f || !f.id || seen.has(f.id)) continue;
        seen.add(f.id);
        all.push(f);
      }
    }
    const verified = all.filter(f => f.status === 'verified');
    return {
      raw: r.data,
      totp: verified.filter(f => f.factor_type === 'totp'),
      webauthn: verified.filter(f => f.factor_type === 'webauthn'),
      all: verified,
      unverified: all.filter(f => f.status === 'unverified')
    };
  },

  async enrollTOTP(friendlyName){
    /* Clean up any unverified factors first (Supabase rejects duplicate enrollment) */
    const list = await security.listFactors();
    for(const f of list.unverified){
      if(f.factor_type === 'totp') await sb.auth.mfa.unenroll({ factorId: f.id });
    }
    const r = await sb.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: friendlyName || 'Authenticator app'
    });
    if(r.error) throw r.error;
    return r.data; /* { id, type:'totp', totp: { qr_code, secret, uri } } */
  },

  async verifyTOTP(factorId, code){
    const ch = await sb.auth.mfa.challenge({ factorId });
    if(ch.error) throw ch.error;
    const v = await sb.auth.mfa.verify({ factorId, challengeId: ch.data.id, code });
    if(v.error) throw v.error;
    return v.data;
  },

  async enrollPasskey(friendlyName){
    /* Best-effort: requires browser WebAuthn + Supabase WebAuthn factor support */
    try{
      const r = await sb.auth.mfa.enroll({
        factorType: 'webauthn',
        friendlyName: friendlyName || (navigator.platform || 'This device')
      });
      if(r.error) throw r.error;
      return r.data;
    } catch(e){
      throw new Error('Passkeys not yet supported on this Supabase project. Use TOTP instead. Details: ' + (e?.message||e));
    }
  },

  async unenroll(factorId){
    const r = await sb.auth.mfa.unenroll({ factorId });
    if(r.error) throw r.error;
  },

  /* Returns whether the current session needs an MFA challenge to escalate */
  async needsMFA(){
    const r = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if(r.error) return false;
    return r.data?.currentLevel === 'aal1' && r.data?.nextLevel === 'aal2';
  },

  /* Open the Security management modal */
  async openSettings(){
    let list;
    try { list = await security.listFactors(); }
    catch(e){ ui.err(e); return; }

    const totpRows = list.totp.map(f => `
      <div class="list-item">
        <div class="grow"><div class="title">${esc(f.friendly_name||'Authenticator app')}</div>
          <div class="meta">TOTP · added ${new Date(f.created_at).toLocaleDateString()}</div></div>
        <button class="icon-btn danger" onclick="security._remove('${f.id}')">Remove</button>
      </div>`).join('');
    const pkRows = list.webauthn.map(f => `
      <div class="list-item">
        <div class="grow"><div class="title">${esc(f.friendly_name||'Passkey')}</div>
          <div class="meta">Passkey · added ${new Date(f.created_at).toLocaleDateString()}</div></div>
        <button class="icon-btn danger" onclick="security._remove('${f.id}')">Remove</button>
      </div>`).join('');

    ui.modal(`
      <h3>Security</h3>
      <p class="muted" style="margin:0 0 12px;font-size:13px">Add a second sign-in factor to protect your account. If you lose access, your admin can disable factors from the Supabase dashboard.</p>

      <div class="card" style="background:var(--panel-2)">
        <h2>🔑 Authenticator app (TOTP)</h2>
        <p class="muted" style="font-size:12px;margin:0 0 8px">Recommended. Use Google Authenticator, Authy, 1Password, or any TOTP app.</p>
        ${totpRows || '<div class="muted">Not enabled.</div>'}
        <button class="icon-btn primary" style="margin-top:8px" onclick="security._enrollTOTPFlow()">+ Add authenticator</button>
      </div>

      <div class="card" style="background:var(--panel-2);margin-top:10px">
        <h2>👆 Passkey (Face ID / Touch ID / Windows Hello)</h2>
        <p class="muted" style="font-size:12px;margin:0 0 8px">Sign in with biometrics on this device. Phishing-immune.</p>
        ${pkRows || '<div class="muted">No passkeys enrolled.</div>'}
        <button class="icon-btn primary" style="margin-top:8px" onclick="security._enrollPasskeyFlow()">+ Add passkey</button>
      </div>

      <div class="card" style="background:var(--panel-2);margin-top:10px">
        <h2>🔑 Password</h2>
        <p class="muted" style="font-size:12px;margin:0 0 8px">Update the password you use to sign in. Requires your current password.</p>
        <button class="icon-btn primary" onclick="security._changePasswordFlow()">Change password</button>
      </div>

      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn" onclick="ui.closeModal()">Done</button>
      </div>
    `);
  },

  async _enrollTOTPFlow(){
    let data;
    try { data = await security.enrollTOTP(); }
    catch(e){ ui.err(e); return; }
    ui.modal(`
      <h3>Set up authenticator</h3>
      <ol class="muted" style="font-size:13px;padding-left:18px;margin:0 0 12px">
        <li>Open your authenticator app (Google Authenticator / Authy / 1Password / etc.)</li>
        <li>Tap "+" and scan this QR code (or paste the secret if you can't scan)</li>
        <li>Enter the 6-digit code from the app to confirm</li>
      </ol>
      <div style="background:white;border-radius:8px;padding:8px;text-align:center;margin-bottom:8px">
        <img src="${data.totp.qr_code}" style="width:200px;height:200px"/>
      </div>
      <div class="muted" style="font-size:11px;text-align:center;margin-bottom:10px;word-break:break-all">
        Secret: <code style="font-family:monospace">${esc(data.totp.secret)}</code>
      </div>
      <div><label>6-digit code from app</label><input id="mfa-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus/></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="security._confirmTOTP('${data.id}')">Verify & enable</button>
        <button class="icon-btn ghost" onclick="security.openSettings()">Cancel</button>
      </div>
    `);
  },

  async _confirmTOTP(factorId){
    const code = (document.getElementById('mfa-code').value||'').trim();
    if(!/^\d{6}$/.test(code)){ ui.toast('Enter the 6-digit code'); return; }
    try { await security.verifyTOTP(factorId, code); }
    catch(e){ ui.err(e); return; }
    ui.toast('Two-factor authentication enabled');
    security.openSettings();
  },

  async _enrollPasskeyFlow(){
    try { await security.enrollPasskey(); }
    catch(e){ ui.err(e); return; }
    ui.toast('Passkey added');
    security.openSettings();
  },

  async _changePasswordFlow(){
    /* Always require a second factor for password change. Prefer TOTP (in-app, instant);
       fall back to email verification code via Supabase's reauthenticate() flow. */
    let factors;
    try { factors = await security.listFactors(); }
    catch(e){ ui.err(e); return; }
    const totp = factors.totp[0] || null;
    const hasTotp = !!totp;

    const factorSection = hasTotp ? `
      <div style="margin-bottom:10px">
        <label>Authenticator code <span class="muted" style="font-size:11px">(6 digits from your app)</span></label>
        <input id="pw-totp" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000"/>
      </div>` : `
      <div class="alert" style="font-size:12px;margin-bottom:10px;background:#0c1f2a;border-color:#1e587a;color:#90d3f1">
        💡 You don't have an authenticator app set up. We'll email a one-time code to ${esc(cache.me.email)} instead. (Set up an authenticator from the Security panel for faster sign-ins.)
      </div>
      <div style="margin-bottom:10px">
        <label>Email verification code</label>
        <div class="row" style="gap:8px">
          <input id="pw-email-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" style="flex:1"/>
          <button type="button" class="icon-btn" onclick="security._sendPasswordEmailCode()">Send code</button>
        </div>
        <div class="muted" id="pw-code-status" style="font-size:11px;margin-top:4px">Click "Send code" to email a verification code.</div>
      </div>`;

    ui.modal(`
      <h3>Change password</h3>
      <p class="muted" style="font-size:13px;margin:0 0 12px">Two-factor verification is required for password changes — protects you from being locked out if your password is leaked.</p>
      <div style="margin-bottom:10px"><label>Current password</label><input id="pw-current" type="password" autocomplete="current-password" autofocus/></div>
      ${factorSection}
      <div style="margin-bottom:10px"><label>New password <span class="muted" style="font-size:11px">(10+ characters)</span></label><input id="pw-new" type="password" autocomplete="new-password"/></div>
      <div style="margin-bottom:10px"><label>Confirm new password</label><input id="pw-confirm" type="password" autocomplete="new-password"/></div>
      <div id="pw-err" class="alert err hide" style="margin-bottom:8px"></div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="security._submitPasswordChange(${hasTotp ? `'${totp.id}'` : 'null'})">Change password</button>
        <button class="icon-btn ghost" onclick="security.openSettings()">Cancel</button>
      </div>
    `);
  },
  async _sendPasswordEmailCode(){
    const statusEl = document.getElementById('pw-code-status');
    if(!statusEl) return;
    statusEl.textContent = 'Sending…';
    const r = await sb.auth.reauthenticate();
    if(r.error){
      statusEl.innerHTML = '<span style="color:#fecaca">⚠ ' + esc(r.error.message) + '</span>';
      return;
    }
    statusEl.innerHTML = '✓ Code sent to <b>' + esc(cache.me.email) + '</b>. Check inbox (and spam). Code expires in ~10 min.';
  },
  async _submitPasswordChange(totpFactorId){
    const errEl = document.getElementById('pw-err');
    const show = msg => { errEl.textContent = msg; errEl.classList.remove('hide'); };

    const cur = document.getElementById('pw-current').value;
    const newPw = document.getElementById('pw-new').value;
    const confirmPw = document.getElementById('pw-confirm').value;
    const useTotp = !!totpFactorId;
    const totpCode = useTotp ? (document.getElementById('pw-totp')?.value||'').trim() : '';
    const emailNonce = !useTotp ? (document.getElementById('pw-email-code')?.value||'').trim() : '';

    if(!cur || !newPw || !confirmPw){ show('All required fields must be filled.'); return; }
    if(useTotp && !/^\d{6}$/.test(totpCode)){ show('Enter the 6-digit authenticator code.'); return; }
    if(!useTotp && !/^\d{6}$/.test(emailNonce)){ show('Enter the 6-digit code from your email (click "Send code" if you haven\'t).'); return; }
    if(newPw !== confirmPw){ show('New password and confirmation do not match.'); return; }
    const strength = auth.passwordStrength(newPw);
    if(!strength.ok){ show(strength.msg); return; }
    if(newPw === cur){ show('New password must be different from the current one.'); return; }

    /* Step 1: re-authenticate with current password */
    const reauth = await sb.auth.signInWithPassword({ email: cache.me.email, password: cur });
    if(reauth.error){ show('Current password is incorrect.'); return; }

    /* Step 2: verify second factor */
    if(useTotp){
      try { await security.verifyTOTP(totpFactorId, totpCode); }
      catch(e){ show('Invalid authenticator code. Try again.'); return; }
    }

    /* Step 3: update password. For email path, include the nonce (Supabase verifies it server-side). */
    const updateOpts = { password: newPw };
    if(!useTotp) updateOpts.nonce = emailNonce;
    const r = await sb.auth.updateUser(updateOpts);
    if(r.error){
      const msg = /nonce|expired|invalid/i.test(r.error.message)
        ? 'Email verification code is wrong or expired. Click "Send code" to get a new one.'
        : r.error.message;
      show(msg); return;
    }
    ui.toast('Password changed.');
    security.openSettings();
  },
  async _remove(factorId){
    if(!confirm('Remove this factor? You\'ll be able to sign in without it. (You can re-add later.)')) return;
    try { await security.unenroll(factorId); }
    catch(e){ ui.err(e); return; }
    ui.toast('Removed');
    security.openSettings();
  },

  /* Called from auth.login after successful password auth */
  async challengeForMFA(){
    const factors = await security.listFactors();
    const factor = factors.totp[0] || factors.webauthn[0];
    if(!factor) return { ok:false, error:'MFA required but no factor enrolled. Contact admin.' };
    if(factor.factor_type === 'webauthn'){
      try {
        const ch = await sb.auth.mfa.challenge({ factorId: factor.id });
        if(ch.error) throw ch.error;
        const v = await sb.auth.mfa.verify({ factorId: factor.id, challengeId: ch.data.id });
        if(v.error) throw v.error;
        return { ok:true };
      } catch(e){ return { ok:false, error: e?.message||'Passkey failed' }; }
    }
    /* TOTP — prompt for code */
    const code = prompt('Enter the 6-digit code from your authenticator app:');
    if(!code) return { ok:false, error:'MFA cancelled' };
    try { await security.verifyTOTP(factor.id, code); return { ok:true }; }
    catch(e){ return { ok:false, error: e?.message||'Invalid code' }; }
  }
};

/* ---------- ABSOLUTE SESSION TIMEOUT ----------
   Admins get a 30-day session cap (real business tool — being kicked
   every 12 hours is friction with no security benefit for the owner).
   Reps still get 12 hours since they may share devices or work remote. */
const absoluteTimeout = {
  MAX_MS_REP: 24 * 60 * 60 * 1000,        /* 24 hours — covers a full sales day
                                             end-to-end so reps don't get kicked
                                             mid-visit. Was 12h. */
  MAX_MS_ADMIN: 30 * 24 * 60 * 60 * 1000, /* 30 days */
  KEY: 'reflectco.session_started_at',
  _interval: null,
  _cap(){
    return (cache.me?.role === 'admin') ? absoluteTimeout.MAX_MS_ADMIN : absoluteTimeout.MAX_MS_REP;
  },
  start(){
    if(absoluteTimeout._interval) return;
    let started = parseInt(localStorage.getItem(absoluteTimeout.KEY) || '0', 10);
    if(!started){
      started = Date.now();
      localStorage.setItem(absoluteTimeout.KEY, String(started));
    }
    absoluteTimeout._interval = setInterval(()=>{
      if(Date.now() - started > absoluteTimeout._cap()){
        clearInterval(absoluteTimeout._interval); absoluteTimeout._interval = null;
        localStorage.removeItem(absoluteTimeout.KEY);
        const days = cache.me?.role === 'admin' ? '30 days' : '24 hours';
        alert(`Your session has reached the ${days} maximum. Signing you out for security.`);
        auth.logout();
      }
    }, 60_000);
  },
  reset(){
    localStorage.setItem(absoluteTimeout.KEY, String(Date.now()));
  },
  clear(){
    localStorage.removeItem(absoluteTimeout.KEY);
    if(absoluteTimeout._interval){ clearInterval(absoluteTimeout._interval); absoluteTimeout._interval = null; }
  }
};

/* ---------- IDLE AUTO-LOGOUT ---------- */
const idleLogout = {
  TIMEOUT_MS: 30 * 60 * 1000,
  WARN_MS:     2 * 60 * 1000,
  _idleTimer:null, _warnTimer:null, _started:false,
  start(){
    if(idleLogout._started) return;
    idleLogout._started = true;
    ['mousedown','mousemove','keypress','scroll','touchstart','click'].forEach(evt=>{
      document.addEventListener(evt, idleLogout.reset, { passive:true, capture:true });
    });
    idleLogout.reset();
  },
  reset(){
    clearTimeout(idleLogout._idleTimer); clearTimeout(idleLogout._warnTimer);
    idleLogout._warnTimer = setTimeout(idleLogout._warn, idleLogout.TIMEOUT_MS - idleLogout.WARN_MS);
    idleLogout._idleTimer = setTimeout(idleLogout._sign_out, idleLogout.TIMEOUT_MS);
  },
  _warn(){
    ui.toast('Signing you out in 2 minutes due to inactivity. Tap anywhere to stay signed in.');
  },
  _sign_out(){
    alert('You have been signed out due to inactivity.');
    auth.logout();
  }
};

/* ---------- PRODUCTS ADMIN (pricing, stock, active) ---------- */
const productsAdmin = {
  async render(){
    const wrap = document.getElementById('products-list'); if(!wrap) return;
    /* Read fresh from DB rather than trusting a stale cache.
       Filter out soft-deleted AND archived rows — those show in the
       Trash / Archive section below. Fall back gracefully when the
       trash-system migration isn't run yet. */
    let { data, error } = await sb.from('products').select('*').is('deleted_at', null).is('archived_at', null).order('name');
    if(error && /archived_at/i.test(error.message||'')){
      ({ data, error } = await sb.from('products').select('*').is('deleted_at', null).order('name'));
    }
    if(error && /deleted_at/i.test(error.message||'')){
      ({ data, error } = await sb.from('products').select('*').order('name'));
    }
    if(error){ wrap.innerHTML = `<div class="alert err">${esc(error.message)}</div>`; return; }
    cache.products = data || [];
    if(!cache.products.length){
      wrap.innerHTML = '<div class="muted">No products yet. Click "+ Add product".</div>';
      return;
    }
    /* Stock is authoritative in Shopify when the integration is live —
       lock the local field and route the admin to Shopify. Everything else
       stays inline-editable. Clicking the SKU opens the full modal. */
    const shopLive = (typeof shopify !== 'undefined' && shopify.mode && shopify.mode() === 'live');
    wrap.innerHTML = `<table>
      <tr><th>SKU</th><th>Name</th><th>Price ($)</th><th>Stock${shopLive?' <span class="muted" style="font-weight:400">(Shopify)</span>':''}</th><th>Active</th><th></th></tr>
      ${cache.products.map(p=>{
        const skuAttr = esc(p.sku).replace(/'/g,'&#39;');
        const stockCell = shopLive
          ? `<span class="muted" title="Stock is managed in Shopify — edits here are ignored" style="cursor:not-allowed">${p.stock}</span>`
          : `<input type="number" step="1" min="0" value="${p.stock}" style="width:90px"
                onchange="productsAdmin.setField('${skuAttr}','stock',this.value,this)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"/>`;
        return `<tr data-sku="${esc(p.sku)}">
          <td class="nowrap"><a href="#" onclick="event.preventDefault();productsAdmin.openEdit('${skuAttr}')" style="color:var(--brand);text-decoration:underline;font-weight:600" title="Open full editor">${esc(p.sku)}</a></td>
          <td>${esc(p.name)}</td>
          <td><input type="number" step="0.01" min="0" value="${p.price}" style="width:100px"
                onchange="productsAdmin.setField('${skuAttr}','price',this.value,this)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"/></td>
          <td>${stockCell}</td>
          <td><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
                <input type="checkbox" ${p.active?'checked':''} style="width:auto"
                  onchange="productsAdmin.setField('${skuAttr}','active',this.checked,this)"/>
                <span class="muted" style="font-size:12px">${p.active?'yes':'no'}</span>
              </label></td>
          <td class="nowrap">
            <button class="icon-btn" onclick="productsAdmin.openEdit('${skuAttr}')">Edit</button>
            <button class="icon-btn danger" onclick="productsAdmin.remove('${skuAttr}')">Delete</button>
          </td>
        </tr>`;
      }).join('')}
    </table>
    <p class="muted" style="font-size:12px;margin-top:8px">💡 Click the <b>SKU</b> or the <b>Edit</b> button for the full popup. Quick tweaks: click any Price ${shopLive?'':'/ Stock '}cell and type, then Enter.${shopLive?' <br>📦 Stock is read-only here — Shopify is the source of truth. Change stock in Shopify admin and the webhook updates this table.':''}</p>`;
    /* Render the trash panel too */
    await productsAdmin.renderTrash();
  },

  /* Two-tier trash UI:
       Tier 1 (Trash bin, visible): deleted_at set, archived_at is null
                                    — 45 days, restorable
       Tier 2 (Archive, hidden by default): archived_at set
                                    — 45 more days on Supabase, still restorable
     Runs the SQL lifecycle first so expired rows move on / get purged. */
  async renderTrash(){
    const wrap = document.getElementById('products-trash'); if(!wrap) return;

    /* Ask the DB to advance the lifecycle: expired trash → archive,
       expired archive → purged. Silent no-op if migration isn't run. */
    let lifecycleErr = null;
    try {
      const r = await sb.rpc('run_products_lifecycle');
      if(r.error) lifecycleErr = r.error;
    } catch(e){ lifecycleErr = e; }

    /* Pull every non-live row in one go, then split client-side. */
    const { data, error } = await sb.from('products')
      .select('*')
      .not('deleted_at', 'is', null)
      .order('deleted_at', {ascending: false});
    if(error){
      if(/deleted_at|archived_at/i.test(error.message||'')){
        wrap.innerHTML = '<div class="muted" style="font-size:12px">Run <code>supabase/trash-system.sql</code> in Supabase → SQL Editor to enable the trash + archive system.</div>';
        return;
      }
      wrap.innerHTML = `<div class="alert err">${esc(error.message)}</div>`;
      return;
    }
    const all = data || [];
    const TRASH_DAYS = 45, ARCHIVE_DAYS = 45;
    const trash   = all.filter(p => !p.archived_at);
    const archive = all.filter(p =>  p.archived_at);

    const rowHtml = (p, opts) => {
      const skuAttr = esc(p.sku).replace(/'/g,'&#39;');
      const stampDate = new Date(opts.from);
      const daysLeft = Math.max(0, opts.window - Math.floor((Date.now() - stampDate.getTime())/86400000));
      const urgent = daysLeft <= 7;
      return `<tr>
        <td class="nowrap"><b>${esc(p.sku)}</b></td>
        <td>${esc(p.name)}</td>
        <td class="muted" style="font-size:12px">${stampDate.toLocaleDateString()}</td>
        <td><span class="badge ${urgent?'err':''}">${daysLeft} day${daysLeft===1?'':'s'}</span></td>
        <td class="nowrap">
          <button class="icon-btn" onclick="productsAdmin.restore('${skuAttr}')">Restore</button>
          <button class="icon-btn danger" onclick="productsAdmin.purgeNow('${skuAttr}')">Delete now</button>
        </td>
      </tr>`;
    };

    /* --- Trash bin --- */
    let html = '';
    if(!trash.length){
      html += '<div class="muted" style="font-size:13px">Trash is empty. Deleted products stay here for 45 days, then move to the hidden archive for another 45 days before being purged permanently.</div>';
    } else {
      html += `<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px">
        <span class="muted" style="font-size:12px">${trash.length} item${trash.length===1?'':'s'} in the bin — visible until they age out (45 days) or you empty the bin.</span>
        <button class="icon-btn danger" onclick="productsAdmin.emptyTrash()">Empty bin</button>
      </div>
      <table>
        <tr><th>SKU</th><th>Name</th><th>Deleted</th><th>Moves to archive in</th><th></th></tr>
        ${trash.map(p => rowHtml(p, {from: p.deleted_at, window: TRASH_DAYS})).join('')}
      </table>`;
    }

    /* --- Archive (hidden by default) --- */
    if(archive.length){
      html += `<details style="margin-top:14px">
        <summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--muted)">📦 Archive — ${archive.length} item${archive.length===1?'':'s'} kept on Supabase, invisible to reps (click to view)</summary>
        <div style="margin-top:8px">
          <p class="muted" style="font-size:12px;margin:0 0 8px">These items left the visible bin (aged out or you clicked Empty bin). They stay on the Supabase database for 45 days in case you need them back, then are purged permanently.</p>
          <table>
            <tr><th>SKU</th><th>Name</th><th>Archived</th><th>Purges in</th><th></th></tr>
            ${archive.map(p => rowHtml(p, {from: p.archived_at, window: ARCHIVE_DAYS})).join('')}
          </table>
        </div>
      </details>`;
    }

    if(lifecycleErr && !/does not exist|not found|schema cache/i.test(lifecycleErr.message||'')){
      html += `<div class="alert err" style="margin-top:10px">Lifecycle RPC error: ${esc(lifecycleErr.message||'unknown')}</div>`;
    }

    wrap.innerHTML = html;
  },

  async emptyTrash(){
    if(!confirm('Empty the trash bin now?\n\nEvery item currently in the bin moves to the hidden archive. Reps still cannot see them. You have 45 more days to restore from the archive before they are permanently purged.')) return;
    let { data, error } = await sb.rpc('empty_products_trash');
    if(error && /does not exist|not found|schema cache/i.test(error.message||'')){
      const upd = await sb.from('products').update({ archived_at: new Date().toISOString() }).is('archived_at', null).not('deleted_at', 'is', null);
      error = upd.error;
      data = upd.count;
    }
    if(error){ ui.err(error); return; }
    ui.toast(`Bin emptied${typeof data === 'number' ? ` (${data} moved to archive)` : ''}`);
    await productsAdmin.render();
  },

  /* Inline field save. Validates client-side, then persists. Visual feedback on the cell. */
  async setField(sku, field, rawValue, inputEl){
    let value = rawValue;
    if(field === 'price'){
      /* When Shopify is the source of truth, block local price edits — they
         get silently reverted on next pull_products. Force the admin to
         change the price in Shopify instead. */
      if(typeof shopify !== 'undefined' && shopify.mode && shopify.mode() === 'live'){
        ui.toast('Price is managed in Shopify when integration is live. Update it there and re-sync.');
        productsAdmin.render();
        return;
      }
      value = Number(rawValue);
      if(!isFinite(value) || value < 0){ ui.toast('Price must be ≥ 0.'); productsAdmin.render(); return; }
    } else if(field === 'stock'){
      if(typeof shopify !== 'undefined' && shopify.mode && shopify.mode() === 'live'){
        ui.toast('Stock is managed in Shopify. Update it there — the webhook syncs it back automatically.');
        productsAdmin.render();
        return;
      }
      value = parseInt(rawValue, 10);
      if(!Number.isFinite(value) || value < 0){ ui.toast('Stock must be a whole number ≥ 0.'); productsAdmin.render(); return; }
    } else if(field === 'active'){
      value = !!rawValue;
    }
    const orig = inputEl?.style.background;
    if(inputEl) inputEl.style.background = 'rgba(250,200,80,0.15)';
    const r = await sb.from('products').update({ [field]: value }).eq('sku', sku).select();
    if(r.error){
      if(inputEl){ inputEl.style.background = 'rgba(220,80,80,0.25)'; setTimeout(()=>inputEl.style.background = orig||'', 2500); }
      ui.err(r.error);
      return;
    }
    if(!r.data || r.data.length === 0){
      if(inputEl){ inputEl.style.background = 'rgba(220,80,80,0.25)'; setTimeout(()=>inputEl.style.background = orig||'', 2500); }
      ui.toast('Save did not go through — check your admin role.');
      return;
    }
    if(inputEl){
      inputEl.style.background = 'rgba(80,200,120,0.20)';
      setTimeout(()=>inputEl.style.background = orig||'', 900);
    }
    ui.toast(`${field==='price'?'Price':field==='stock'?'Stock':'Active'} updated for ${sku}`);
    /* Refresh cache so the order picker sees new values */
    cache.products = cache.products.map(p => p.sku === sku ? { ...p, [field]: value } : p);
    await ref.loadAll();
  },

  openNew(){ productsAdmin.openModal(null); },
  openEdit(sku){ productsAdmin.openModal(sku); },
  openModal(sku){
    const p = sku ? cache.products.find(x=>x.sku===sku) : null;
    const isNew = !p;
    const cur = p || { sku:'', name:'', price:0, stock:0, active:true };
    const shopLive = (typeof shopify !== 'undefined' && shopify.mode && shopify.mode() === 'live');
    /* When Shopify is live, stock is managed there — lock the field so
       an accidental change here doesn't get overwritten by the next
       inventory_levels/update webhook. */
    const stockLocked = shopLive && !isNew;
    ui.modal(`
      <h3>${isNew ? 'Add product' : 'Edit '+esc(cur.sku)}</h3>
      <p class="muted" style="font-size:13px;margin:0 0 12px">${isNew ? 'SKU is permanent. Use uppercase with dashes, e.g. <b>APPOSE-LIPTX-C24</b>.' : 'Edit any field, then Save. SKU cannot be changed.'}</p>
      <div id="pr-err" class="alert err hide" style="margin-bottom:10px"></div>
      <div class="grid-2">
        <div><label>SKU ${isNew?'<span style="color:var(--brand)">*</span>':''}</label>
          <input id="pr-sku" value="${esc(cur.sku)}" ${isNew?'':'disabled style="opacity:0.6"'} autocapitalize="characters" placeholder="APPOSE-LIPTX-C24"/></div>
        <div><label>Name <span style="color:var(--brand)">*</span></label>
          <input id="pr-name" value="${esc(cur.name)}" placeholder="Appose Lip TX — Case of 24"/></div>
        <div><label>Wholesale price ($)</label>
          <input id="pr-price" type="number" step="0.01" min="0" value="${cur.price}"/></div>
        <div><label>Stock (units)${stockLocked?' <span class="muted" style="font-weight:400">— managed in Shopify</span>':''}</label>
          <input id="pr-stock" type="number" step="1" min="0" value="${cur.stock}" ${stockLocked?'disabled style="opacity:0.6" title="Change stock in Shopify — the webhook syncs it here"':''}/></div>
        <div style="grid-column:1/-1">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input id="pr-active" type="checkbox" ${cur.active?'checked':''} style="width:auto"/>
            <span>Active — appears in rep order picker</span>
          </label>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button id="pr-save-btn" class="icon-btn primary" onclick="productsAdmin.save('${esc(cur.sku).replace(/'/g,'&#39;')}', ${isNew})">Save</button>
        <button class="icon-btn ghost" onclick="ui.closeModal()">Cancel</button>
      </div>
    `);
    setTimeout(()=>document.getElementById(isNew?'pr-sku':'pr-name')?.focus(), 50);
  },
  async save(oldSku, isNew){
    const errEl = document.getElementById('pr-err');
    const showErr = m => { errEl.textContent = m; errEl.classList.remove('hide'); };
    const btn = document.getElementById('pr-save-btn');
    const setBusy = on => { if(btn){ btn.disabled = on; btn.textContent = on ? 'Saving…' : 'Save'; } };
    errEl?.classList.add('hide');

    const sku = (document.getElementById('pr-sku').value||'').trim().toUpperCase();
    const name = (document.getElementById('pr-name').value||'').trim();
    const price = Number(document.getElementById('pr-price').value||0);
    const stock = parseInt(document.getElementById('pr-stock').value||0, 10);
    const active = document.getElementById('pr-active').checked;
    if(!sku){ showErr('SKU is required.'); return; }
    if(!name){ showErr('Name is required.'); return; }
    if(price < 0 || !isFinite(price)){ showErr('Price must be a non-negative number.'); return; }
    if(stock < 0 || !Number.isFinite(stock)){ showErr('Stock must be a non-negative whole number.'); return; }

    let q;
    setBusy(true);
    const shopLive = (typeof shopify !== 'undefined' && shopify.mode && shopify.mode() === 'live');
    if(isNew){
      q = await sb.from('products').insert({sku, name, price, stock, active}).select().single();
    } else {
      /* Drop stock from the update when Shopify is live — Shopify is authoritative,
         and the CRM stock value would be overwritten by the next webhook anyway. */
      const patch = shopLive ? {name, price, active} : {name, price, stock, active};
      q = await sb.from('products').update(patch).eq('sku', oldSku).select().single();
    }
    setBusy(false);
    if(q.error){ showErr(q.error.message || 'Save failed.'); return; }
    ui.closeModal();
    ui.toast(isNew?'Product added':'Product saved');
    await productsAdmin.render();
    await ref.loadAll();
  },
  async remove(sku){
    if(!confirm(`Move ${sku} to trash?\n\nReps will no longer see it in the order picker. It stays in the trash for 45 days — you can restore any time in Admin → Products & pricing → Trash. After 45 days it is permanently deleted.`)) return;
    /* Soft delete via RPC. Falls back to a plain update if the RPC isn't
       deployed yet (before supabase/products-trash.sql has been run). */
    let { error } = await sb.rpc('soft_delete_product', { p_sku: sku });
    if(error && /does not exist|not found|schema cache/i.test(error.message||'')){
      const upd = await sb.from('products').update({ deleted_at: new Date().toISOString(), active: false }).eq('sku', sku);
      error = upd.error;
    }
    if(error){ ui.err(error); return; }
    ui.toast(`${sku} moved to trash — 45 days to restore`);
    await productsAdmin.render();
    await ref.loadAll();
  },

  async restore(sku){
    let { error } = await sb.rpc('restore_product', { p_sku: sku });
    if(error && /does not exist|not found|schema cache/i.test(error.message||'')){
      const upd = await sb.from('products').update({ deleted_at: null }).eq('sku', sku);
      error = upd.error;
    }
    if(error){ ui.err(error); return; }
    ui.toast(`${sku} restored`);
    await productsAdmin.render();
    await ref.loadAll();
  },

  async purgeNow(sku){
    if(!confirm(`Permanently delete ${sku}?\n\nThis cannot be undone. Historical orders keep the SKU reference but this product row will be gone.`)) return;
    let { error } = await sb.rpc('purge_product', { p_sku: sku });
    if(error && /does not exist|not found|schema cache/i.test(error.message||'')){
      const del = await sb.from('products').delete().eq('sku', sku);
      error = del.error;
    }
    if(error){ ui.err(error); return; }
    ui.toast(`${sku} permanently deleted`);
    await productsAdmin.render();
    await ref.loadAll();
  }
};

/* ---------- AUDIT LOG (admin view) ---------- */
const auditLog = {
  async render(){
    const wrap = document.getElementById('audit-list'); if(!wrap) return;
    const tableFilter = document.getElementById('audit-table-filter')?.value || '';
    const actionFilter = document.getElementById('audit-action-filter')?.value || '';
    let q = sb.from('audit_log').select('*').order('at',{ascending:false}).limit(100);
    if(tableFilter) q = q.eq('table_name', tableFilter);
    if(actionFilter) q = q.eq('action', actionFilter);
    const { data, error } = await q;
    if(error){ wrap.innerHTML = '<div class="muted">'+esc(error.message)+'</div>'; return; }
    const rows = data || [];
    if(!rows.length){ wrap.innerHTML = '<div class="muted">No audit entries match.</div>'; return; }
    wrap.innerHTML = `<table>
      <tr><th>When</th><th>Who</th><th>Action</th><th>Table</th><th>Record</th></tr>
      ${rows.map(r=>{
        const when = new Date(r.at).toLocaleString();
        const who = `${esc(r.user_email||'(system)')}${r.rep_id?' · '+esc(r.rep_id):''}`;
        const recId = r.record_id ? r.record_id.slice(0,8) : '';
        const actionBadge = {insert:'ok', update:'info', delete:'err'}[r.action] || '';
        return `<tr>
          <td class="nowrap">${esc(when)}</td>
          <td>${who}</td>
          <td><span class="badge ${actionBadge}">${esc(r.action)}</span></td>
          <td>${esc(r.table_name)}</td>
          <td class="nowrap">${esc(recId)}</td>
        </tr>`;
      }).join('')}
    </table>`;
  }
};

/* ---------- CSV EXPORT WATERMARK ---------- */
function csvWatermark(filterDesc){
  const me = cache.me || {};
  return [
    ['The Reflect Co — CRM Export'],
    ['Exported by', me.name || me.email || ''],
    ['Rep ID', me.rep_id || ''],
    ['Role', me.role || ''],
    ['Exported at', new Date().toISOString()],
    ['Filter', filterDesc || ''],
    ['', '', 'Confidential — for the named exporter only. Do not redistribute.'],
    ['']
  ];
}

/* ---------- BOOT ---------- */
async function boot(){
  /* If a password-recovery flow is active, the dashboard must stay hidden
     until the password is set (see auth.applyRecoveryFlow). Reload will
     re-run boot() after the reset. */
  if(auth._recoveryPending){
    document.getElementById('auth').classList.add('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
  /* Re-entry guard: onAuthStateChange (INITIAL_SESSION / SIGNED_IN) may
     also trigger boot. Running twice is functionally fine but wastes a
     profile fetch — the flag lets both callers race safely to a single
     execution. Cleared automatically once boot finishes so a subsequent
     sign-in (e.g., after sign-out) can still trigger it. */
  if(boot._running) return;
  boot._running = true;
  try {
    /* If the URL still carries an access_token hash but Supabase-JS hasn't
       parsed it into a session yet, wait a beat for the parse to complete
       before deciding there's no session. Otherwise the fresh magic-link
       redirect flashes the sign-in screen and the user thinks the link failed. */
    let session = (await sb.auth.getSession()).data.session;
    if(!session && /access_token=|refresh_token=/.test(location.hash)){
      for(let i=0; i<10 && !session; i++){
        await new Promise(r => setTimeout(r, 100));
        session = (await sb.auth.getSession()).data.session;
      }
    }
    if(!session){
      document.getElementById('auth').classList.remove('hide');
      document.getElementById('app').classList.add('hide');
      return;
    }
  /* If the session token was issued after the stale localStorage timestamp
     (which can happen when the user closes/reopens the browser and the
     supabase session refresh brings them back in), reset the absolute
     timeout clock so we don't insta-log them out. */
  try {
    const started = parseInt(localStorage.getItem(absoluteTimeout.KEY) || '0', 10);
    const sessionIssuedMs = (session.expires_at ? (session.expires_at - (session.expires_in || 3600)) * 1000 : Date.now());
    if(!started || sessionIssuedMs > started){
      absoluteTimeout.reset();
    }
  } catch(_){}
  try{
    await profiles.loadMe(session.user.id);
    if(cache.me?.disabled){
      await sb.auth.signOut();
      alert('Your access has been disabled. Contact your administrator.');
      location.reload();
      return;
    }
    await Promise.all([ref.loadAll(), profiles.loadReps()]);
  } catch(e){
    /* Don't hide the auth screen on boot failure — leaving the app half-loaded
       is worse than showing the sign-in page with an error. Rep can retry. */
    ui.err(e);
    document.getElementById('auth').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hide', !auth.isAdmin()));
  idleLogout.start();
  absoluteTimeout.start();
  /* Show the welcome overlay on first sign-in per device (localStorage-tracked).
     Non-blocking — sits on top of the app; user dismisses with a big button. */
  welcome.maybeShow();

  /* First-login prompt: if profile not yet onboarded, send them to Profile */
  if(cache.me && !cache.me.onboarded){
    nav.go('profile');
  } else {
    nav.go('dashboard');
  }
  } finally {
    /* Reset the guard so a future sign-in (after sign-out or refresh)
       can trigger boot again. */
    boot._running = false;
  }
}

/* ---------- FIRST-TIME WELCOME OVERLAY ---------- */
/* Shown once per device per user (localStorage flag). Explains the CRM
   in plain language, points at required Profile fields, tells them how
   to come back next time (bookmark / re-use invite link / magic link). */
const welcome = {
  maybeShow(){
    try {
      if(!cache.me || !cache.me.id) return;
      const key = 'reflect_welcomed_' + cache.me.id;
      if(localStorage.getItem(key)) return;
      welcome.show();
    } catch(_){ /* silent — localStorage may be disabled */ }
  },
  show(){
    const first = (cache.me.name || '').trim().split(/\s+/)[0] || 'there';
    const isRep = cache.me.role === 'rep';
    const inTest = !!(cache.me.test_mode && cache.me.role !== 'admin');
    /* Detect iOS Safari to give the right "Add to Home Screen" instruction */
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    const isAndroid = /Android/.test(ua);
    const homeScreenTip = isIOS
      ? 'On iPhone/iPad: tap the <b>Share</b> icon (square with arrow) at the bottom of Safari → scroll down → <b>Add to Home Screen</b>. You get an app icon.'
      : isAndroid
      ? 'On Android: tap the <b>⋮ menu</b> in Chrome → <b>Install app</b> or <b>Add to Home screen</b>. You get an app icon.'
      : 'Bookmark this page (Ctrl/Cmd + D). Or use the sign-in link Dan sent you again — it always works.';

    const html = `
      <div id="reflect-welcome-overlay" style="
        position:fixed;inset:0;background:rgba(0,0,0,0.65);
        z-index:2147483647;display:flex;align-items:center;justify-content:center;
        padding:16px;overflow-y:auto;">
        <div style="
          background:var(--panel);color:var(--ink);
          max-width:520px;width:100%;border-radius:14px;padding:24px;
          box-shadow:0 20px 40px rgba(0,0,0,0.4);
          border:1px solid var(--line);">
          <h2 style="margin:0 0 6px;font-size:22px">👋 Welcome, ${esc(first)}!</h2>
          <p style="margin:0 0 16px;color:var(--muted);font-size:14px">You're signed in to the Reflect Co CRM.</p>

          ${inTest ? `
          <div style="background:#8a5a00;color:#fff;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:16px">
            <b>🧪 You're in Test Mode</b> — feel free to click around. Nothing you do will create real orders, send real invoices, or affect the business. It's a full-featured sandbox.
          </div>` : ''}

          <div style="margin:0 0 16px">
            <div style="font-weight:600;margin-bottom:6px">A quick tour:</div>
            <ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.7">
              <li>📇 <b>Accounts</b> — the retailers, spas, boutiques you sell to</li>
              <li>🧾 <b>Orders</b> — create + track wholesale orders</li>
              <li>📊 <b>Reports</b> — your sales and commission</li>
              <li>🔮 <b>Forecast</b> — set your monthly goals</li>
              <li>👤 <b>Profile</b> — your contact info (fill this out first — required)</li>
            </ul>
            <div style="font-size:12px;color:var(--muted);margin-top:8px">Tabs are at the bottom of the screen.</div>
          </div>

          <div style="background:var(--panel-2);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:16px">
            <div style="font-weight:600;font-size:13px;margin-bottom:6px">📌 Save this page so you can come back easily:</div>
            <div style="font-size:13px;color:var(--ink-soft);line-height:1.6">${homeScreenTip}</div>
          </div>

          <div style="font-size:12px;color:var(--muted);margin-bottom:16px">
            <b>Next time you visit:</b> just come back to this URL and it'll remember you. If it doesn't, click <b>✉️ Email me a sign-in link</b> on the sign-in page — no password needed, ever.
          </div>

          <button
            id="reflect-welcome-close"
            style="width:100%;padding:14px;background:var(--accent);color:#fff;
                   border:none;border-radius:10px;font-size:15px;font-weight:600;
                   cursor:pointer">
            Got it — let's go →
          </button>
        </div>
      </div>
    `;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    document.getElementById('reflect-welcome-close').onclick = welcome.dismiss;
  },
  dismiss(){
    try { localStorage.setItem('reflect_welcomed_' + cache.me.id, new Date().toISOString()); } catch(_){}
    const el = document.getElementById('reflect-welcome-overlay');
    if(el) el.remove();
  },
  /* Admin utility: reset per-device so you can re-see the welcome. */
  reset(){
    if(cache.me?.id) localStorage.removeItem('reflect_welcomed_' + cache.me.id);
    ui.toast('Welcome overlay reset — sign out + back in to see it.');
  }
};

/* Populate any statically-rendered state <select> elements in index.html
   (signup form, profile form) — the HTML file can't run JS at parse time
   so the options are injected here. Runs both immediately (in case the DOM
   is already ready) and on DOMContentLoaded (in case it isn't). */
(function populateStaticStateSelects(){
  const fill = () => {
    document.querySelectorAll('#su-state, #p-state').forEach(sel => {
      if(!sel || sel.options.length > 2) return; /* already populated */
      const current = sel.value || '';
      sel.innerHTML = usStateOptions(current);
    });
  };
  if(document.readyState !== 'loading') fill();
  else document.addEventListener('DOMContentLoaded', fill);
})();

sb.auth.onAuthStateChange((event) => {
  if(event === 'SIGNED_OUT') { location.reload(); return; }
  if(event === 'PASSWORD_RECOVERY') { auth.applyRecoveryFlow(); return; }
  /* SIGNED_IN fires when Supabase parses an access_token out of the URL hash
     (magic-link click), when a password sign-in completes, and on TOKEN
     refresh. The initial boot() below runs synchronously with the client's
     hash parsing, so on a magic-link redirect boot often sees getSession()
     return null and shows the sign-in screen. Re-running boot() from this
     handler catches the just-parsed session and reveals the app.
     Guard so we don't double-boot when SIGNED_IN happens to fire twice. */
  if(event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED'){
    if(!window.__reflectBootAfterAuth){
      window.__reflectBootAfterAuth = true;
      boot();
    }
  }
});

/* Trap the browser's back-navigation (trackpad two-finger swipe on Mac,
   Cmd+[, Android back button) whenever a modal is open. Pushing the
   state right back cancels the navigation — the modal stays open and
   the form data the user is entering is preserved. When no modal is
   open, normal navigation proceeds. */
window.addEventListener('popstate', () => {
  const primary   = document.getElementById('modal-back');
  const secondary = document.getElementById('modal2-back');
  const modalOpen = secondary?.classList.contains('show') || primary?.classList.contains('show');
  if(modalOpen){
    try { history.pushState({ reflectModal: 'trap' }, ''); } catch(_) {}
  }
});

auth.applyRecoveryFlow();
boot();
