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
  },
  closeModal(){ document.getElementById('modal-back').classList.remove('show') },
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
      errEl.innerHTML = 'Sign-in failed: '+esc(error.message)+'.<br>If this is your first time, try <b>Create account</b> below.';
      errEl.classList.remove('hide');
      return;
    }
    errEl.classList.add('hide');
    await boot();
  },
  async signup(){
    const errEl = document.getElementById('auth-err');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    const pass  = (document.getElementById('auth-pass').value||'');
    if(!email || pass.length < 6){
      errEl.textContent = 'Email + a password of at least 6 characters required.'; errEl.classList.remove('hide'); return;
    }
    ui.busy(true);
    const { error } = await sb.auth.signUp({ email, password: pass });
    ui.busy(false);
    if(error){
      errEl.textContent = 'Sign-up failed: '+error.message;
      errEl.classList.remove('hide');
      return;
    }
    errEl.classList.remove('hide');
    errEl.classList.remove('err');
    errEl.classList.add('ok');
    errEl.innerHTML = 'Account created. If email confirmation is on (Supabase default), check your inbox and click the link before signing in.';
  },
  async logout(){
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
  async applyRecoveryFlow(){
    /* After clicking the email link, Supabase puts a recovery token in the URL hash.
       Prompt for new password and set it. */
    if(!location.hash.includes('access_token') && !location.hash.includes('type=recovery') && location.hash !== '#reset') return;
    setTimeout(async ()=>{
      const newp = prompt('Set a new password (at least 6 characters):');
      if(!newp || newp.length<6){ alert('Password must be at least 6 characters.'); return; }
      const { error } = await sb.auth.updateUser({ password: newp });
      if(error){ alert('Failed: '+error.message); return; }
      alert('Password updated. You are now signed in.');
      history.replaceState(null, '', location.pathname);
      location.reload();
    }, 200);
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
    const { data, error } = await sb.from('profiles').select('*').order('name');
    if(error) throw error;
    cache.reps = data || [];
  }
};

/* ---------- DATA: reference (types, products, promos, settings) ---------- */
const ref = {
  async loadAll(){
    const [t,p,pr,s] = await Promise.all([
      sb.from('account_types').select('*').order('sort_order'),
      sb.from('products').select('*').order('name'),
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
    if(view==='cs')        cs.init();
    if(view==='admin')     adminPanel.render();
  }
};

/* ---------- DASHBOARD ---------- */
const dashboard = {
  async render(){
    document.getElementById('who').textContent = (cache.me.name || cache.me.email) + (auth.isAdmin()?' · Admin':' · Rep');
    document.getElementById('role-pill').textContent = auth.isAdmin()?'Admin':'Rep';

    /* counts */
    const [accCount, mtdOrders] = await Promise.all([
      accounts.count(),
      orders.listMTD()
    ]);
    const rev = (mtdOrders||[]).reduce((s,o)=>s+Number(o.total||0),0);
    const comm = (mtdOrders||[]).reduce((s,o)=>{
      const repPct = (cache.reps.find(r=>r.rep_id===o.rep_id)?.commission || 0)/100;
      return s + (Number(o.total||0) - Number(o.shipping||0) - Number(o.tax||0)) * repPct;
    }, 0);
    document.getElementById('kpi-accounts').textContent = accCount;
    document.getElementById('kpi-orders').textContent   = mtdOrders.length;
    document.getElementById('kpi-rev').textContent      = fmt$(rev);
    document.getElementById('kpi-comm').textContent     = fmt$(comm);

    /* alerts */
    const alertsEl = document.getElementById('alerts');
    const alerts = [];
    const lowStock = cache.products.filter(p=>p.stock<=ref.lowStock());
    lowStock.forEach(p=>alerts.push({lvl:'warn', text:`Low stock — ${p.name} (${p.stock} left)`}));

    const myAccts = await accounts.list();
    for(const a of myAccts.slice(0, 30)){
      const last = await orders.lastForAccount(a.id);
      if(last){
        const days = Math.floor((Date.now()-new Date(last.placed_at))/86400000);
        if(days>=ref.reorderDays()) alerts.push({lvl:'info', text:`${a.business_name||a.account_number} due for reorder (${days}d since last)`});
      } else {
        const days = Math.floor((Date.now()-new Date(a.created_at))/86400000);
        if(days>14) alerts.push({lvl:'info', text:`${a.business_name||a.account_number} has no orders yet (${days}d old)`});
      }
    }
    alertsEl.innerHTML = alerts.length ? alerts.slice(0,8).map(a=>`<div class="alert ${a.lvl==='warn'?'warn':''}">${esc(a.text)}</div>`).join('') : '<div class="muted">All clear.</div>';
  }
};

/* ---------- ACCOUNTS ---------- */
const accounts = {
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
      email:'', cell:'', business_phone:'', sales_tax_license:'', sales_tax_state:'',
      opt_in:true, notes:[], rep_id: auth.repId()
    };
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
        <div><label>Business address</label><input id="f-ba" value="${esc(acc.business_address)}"/></div>
        <div><label>Billing address</label><input id="f-bla" value="${esc(acc.billing_address)}"/></div>
        <div><label>Cell (responsible)</label><input id="f-cell" value="${esc(acc.cell)}"/></div>
        <div><label>Business phone</label><input id="f-bp" value="${esc(acc.business_phone)}"/></div>
        <div><label>Sales tax license #</label><input id="f-stl" value="${esc(acc.sales_tax_license)}"/></div>
        <div><label>License state</label><input id="f-sts" value="${esc(acc.sales_tax_state)}" placeholder="CO"/></div>
        <div><label>Opt-in to comms</label>
          <select id="f-opt"><option value="true" ${acc.opt_in?'selected':''}>Opted in</option><option value="false" ${!acc.opt_in?'selected':''}>Opted out</option></select>
        </div>
        <div><label>Assigned rep</label><select id="f-rep" ${auth.isAdmin()?'':'disabled'}>${repOpts}</select></div>
      </div>
      ${!isNew ? `
      <div class="card" style="margin-top:10px">
        <h2>Call / visit log</h2>
        <div id="acc-notes"></div>
        <div class="row" style="gap:8px;margin-top:8px">
          <input id="note-text" placeholder="Add a note (call, visit, geo check-in…)" />
          <button class="icon-btn" onclick="accounts.addNote('${acc.id}')">Add</button>
        </div>
      </div>` : ''}
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="accounts.save('${acc.id||''}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="accounts.remove('${acc.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
    if(!isNew){
      const nw = document.getElementById('acc-notes');
      const real = (acc.notes||[]).slice().reverse();
      nw.innerHTML = real.length ? real.map(n=>`<div class="list-item"><div class="grow"><div>${esc(n.text)}</div><div class="meta">${esc(n.at)}</div></div></div>`).join('') : '<div class="muted">No notes yet.</div>';
    }
  },
  async save(id, isNew){
    const get = i => document.getElementById(i).value;
    const payload = {
      business_name:get('f-bn'), type:get('f-type'), billing_name:get('f-rn'),
      email:get('f-em'), business_address:get('f-ba'), billing_address:get('f-bla'),
      cell:get('f-cell'), business_phone:get('f-bp'),
      sales_tax_license:get('f-stl'), sales_tax_state:get('f-sts'),
      opt_in:get('f-opt')==='true', rep_id: get('f-rep') || auth.repId()
    };
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('accounts').insert(payload).select().single();
    } else {
      q = await sb.from('accounts').update(payload).eq('id', id).select().single();
    }
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal(); ui.toast(isNew?'Account created':'Saved'); accounts.render(); dashboard.render();
  },
  async addNote(id){
    const r = await sb.from('accounts').select('notes').eq('id', id).single();
    if(r.error){ ui.err(r.error); return; }
    const text = document.getElementById('note-text').value.trim(); if(!text) return;
    const notes = Array.isArray(r.data.notes) ? r.data.notes : [];
    notes.push({text, at:new Date().toLocaleString()});
    const u = await sb.from('accounts').update({ notes }).eq('id', id);
    if(u.error){ ui.err(u.error); return; }
    accounts.open(id);
  },
  async remove(id){
    if(!confirm('Delete this account? Orders will keep their reference.')) return;
    const r = await sb.from('accounts').delete().eq('id', id);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal(); ui.toast('Deleted'); accounts.render();
  }
};

/* ---------- ORDERS ---------- */
const orders = {
  async listMTD(){
    const from = startOfMonth();
    const { data, error } = await sb.from('orders').select('*').eq('status','finalized').gte('placed_at', from);
    if(error){ ui.err(error); return []; }
    return data || [];
  },
  async lastForAccount(accountId){
    const { data, error } = await sb.from('orders').select('*').eq('account_id', accountId).order('placed_at',{ascending:false}).limit(1);
    if(error){ return null; }
    return (data && data[0]) || null;
  },
  async listAll(){
    const { data, error } = await sb.from('orders').select('*').order('placed_at',{ascending:false});
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
      return `<div class="list-item">
        <div class="grow">
          <div class="title">${esc(o.order_number||'(draft)')} <span class="badge ${status}">${esc(o.status)}</span></div>
          <div class="meta">${esc(a?.business_name||'—')} · ${new Date(o.placed_at).toLocaleDateString()} · ${fmt$(o.total)}</div>
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
    }
    const isNew = !o;
    orders._draft = o || {
      account_id:'', rep_id:auth.repId(),
      items:[], shipping:ref.shipDefault(), tax:0, tax_label:ref.taxLabelDefault(),
      promo_code:'', promo_effect:'', discount:0,
      payment:{method:'Visa', last4:'', esign:false},
      status:'draft', total:0
    };
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
          <div><label>Shipping ($)</label><input id="o-ship" type="number" step="0.01" value="${orders._draft.shipping}" onchange="orders.recompute()"/></div>
          <div><label>Tax (auto)</label><input id="o-tax" readonly value="${Number(orders._draft.tax||0).toFixed(2)}"/></div>
        </div>
        <div class="muted" id="o-tax-note" style="font-size:12px;margin-top:6px"></div>
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
          <div><label>New card e-signature</label>
            <select id="o-pay-esign"><option value="false" ${!orders._draft.payment?.esign?'selected':''}>Not signed</option><option value="true" ${orders._draft.payment?.esign?'selected':''}>E-signed on file</option></select>
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
        <button class="icon-btn" onclick="orders.saveDraft('${orders._draft.id||''}', ${isNew})">Save draft</button>
        <button class="icon-btn primary" onclick="orders.finalize('${orders._draft.id||''}', ${isNew})">Finalize & invoice</button>
        ${!isNew?`<button class="icon-btn danger" onclick="orders.remove('${orders._draft.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
    orders.renderItems();
    orders.refresh();
  },
  async refresh(){
    const accId = document.getElementById('o-acc').value;
    const acc = (await accounts.list()).find(a=>a.id===accId);
    let rate = ref.taxRateDefault(), label = ref.taxLabelDefault();
    let note = `Default: ${label} (${(rate*100).toFixed(2)}%).`;
    if(acc && acc.sales_tax_license){
      rate = 0; label = `Tax-exempt (license ${acc.sales_tax_license}, ${acc.sales_tax_state||'state'})`;
      note = `Account has a sales tax license — tax not collected.`;
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
    (orders._draft.items ||= []).push({sku:opt.value, name:opt.dataset.name, price:parseFloat(opt.dataset.price), qty});
    orders.renderItems(); orders.recompute();
  },
  setQty(i,v){ orders._draft.items[i].qty = Math.max(1, parseInt(v||'1',10)); orders.renderItems(); orders.recompute(); },
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
  recompute(){
    const d = orders._draft; if(!d) return;
    const items = d.items || [];
    const sub = items.reduce((s,i)=>s+i.qty*i.price,0);
    const p = cache.promotions.find(x=>x.code===d.promo_code);
    let disc = 0, ship = parseFloat(document.getElementById('o-ship').value||ref.shipDefault());
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
    d.shipping = parseFloat(document.getElementById('o-ship').value||0);
    d.payment = {
      method: document.getElementById('o-pay-method').value,
      last4: document.getElementById('o-pay-l4').value,
      esign: document.getElementById('o-pay-esign').value==='true',
      authorized: false
    };
    return d;
  },
  buildPayload(d){
    return {
      account_id: d.account_id, rep_id: d.rep_id, items: d.items||[],
      shipping: Number(d.shipping||0), tax: Number(d.tax||0), tax_label: d.tax_label,
      promo_code: d.promo_code, promo_effect: d.promo_effect, discount: Number(d.discount||0),
      payment: d.payment, status: d.status, total: Number(d.total||0)
    };
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
    ui.closeModal(); ui.toast('Draft saved'); orders.render();
  },
  async finalize(id, isNew){
    const d = orders.collect();
    if(!d.account_id){ ui.toast('Pick an account first'); return; }
    if(!(d.items||[]).length){ ui.toast('Add at least one item'); return; }
    const cardMethods = ['Visa','Mastercard','Amex'];
    if(cardMethods.includes(d.payment.method) && !d.payment.esign){ ui.toast('New card requires e-signature'); return; }

    const sub = d.items.reduce((s,i)=>s+i.qty*i.price,0);
    const discPct = sub>0 ? (Number(d.discount)/sub*100) : 0;
    const adminFlag = discPct >= ref.highDiscPct() ? `High discount (${discPct.toFixed(1)}%) — admin will be notified.\n` : '';
    if(!confirm(adminFlag+'Finalize this order? This generates an order #, invoice, and charges payment.')) return;

    d.status='finalized';
    d.payment.authorized = true;
    const payload = orders.buildPayload(d);
    let q;
    if(isNew){
      payload.created_by = (await sb.auth.getUser()).data.user.id;
      q = await sb.from('orders').insert(payload).select().single();
    } else {
      q = await sb.from('orders').update(payload).eq('id', id).select().single();
    }
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal();
    invoice.show(q.data);
    dashboard.render(); orders.render();
  },
  async remove(id){
    if(!confirm('Delete this order?')) return;
    const r = await sb.from('orders').delete().eq('id', id);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal(); ui.toast('Deleted'); orders.render();
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
      <div class="muted" style="font-size:12px;margin-top:8px">Payment: ${esc(o.payment?.method||'')} ${o.payment?.last4?'····'+esc(o.payment.last4):''} · E-sign: ${o.payment?.esign?'on file':'n/a'}<br>Tracking will be emailed to ${esc(acc.email||'the account')} when shipped.</div>
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
    const r = await sb.from('promotions').delete().eq('id', id);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal(); promos.render();
  }
};

/* ---------- REPORTS ---------- */
const reports = {
  async init(){
    document.getElementById('rep-from').value = startOfMonth();
    document.getElementById('rep-to').value = todayISO();
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
    let q = sb.from('orders').select('*, account:accounts(account_number,business_name,type)').eq('status','finalized');
    if(from) q = q.gte('placed_at', from);
    if(to)   q = q.lte('placed_at', to + 'T23:59:59');
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
      const repPct = (cache.reps.find(r=>r.rep_id===o.rep_id)?.commission || 0)/100;
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
  exportCsv(){
    const list = reports._lastList || [];
    const rows = [['Date','Order','AccountNumber','Account','Type','Rep','Subtotal','Discount','Shipping','Tax','Total','Commission']];
    list.forEach(o=>{
      const sub = (o.items||[]).reduce((s,i)=>s+i.qty*i.price,0);
      const repPct = (cache.reps.find(r=>r.rep_id===o.rep_id)?.commission||0)/100;
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

/* ---------- CUSTOMER SERVICE (rule-based, soon: Claude API) ---------- */
const cs = {
  init(){
    document.getElementById('chat-log').innerHTML='';
    cs.bot("Hi! I can look up accounts, orders, promos, and tax rules. Try \"orders for ACC-0001\", \"promo BOGO48\", or \"tax for license\".");
  },
  async send(){
    const inp = document.getElementById('chat-in');
    const text = inp.value.trim(); if(!text) return;
    inp.value=''; cs.user(text);
    cs.bot(await cs.answer(text));
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

/* ---------- ADMIN ---------- */
const adminPanel = {
  async render(){
    /* reps */
    await profiles.loadReps();
    document.getElementById('rep-list').innerHTML = cache.reps.map(r=>`
      <div class="list-item">
        <div class="grow"><div class="title">${esc(r.name||r.email)} <span class="badge info">${esc(r.rep_id||'no rep id')}</span> <span class="badge ${r.role==='admin'?'ok':''}">${esc(r.role)}</span></div>
          <div class="meta">${esc(r.email)} · commission ${r.commission||0}% · territory ${(r.territory||[]).join(', ')||'—'}</div>
        </div>
        <button class="icon-btn" onclick="adminPanel.editRep('${r.id}')">Edit</button>
      </div>`).join('');
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
  },
  async editRep(id){
    const r = cache.reps.find(x=>x.id===id); if(!r) return;
    const name = prompt('Name', r.name||''); if(name===null) return;
    const repId = prompt('Rep ID (e.g. R-001)', r.rep_id||''); if(repId===null) return;
    const role = prompt('Role (admin or rep)', r.role||'rep'); if(role===null) return;
    const comm = prompt('Commission %', r.commission ?? 10); if(comm===null) return;
    const terr = prompt('Territory ZIPs (comma sep)', (r.territory||[]).join(',')); if(terr===null) return;
    const q = await sb.from('profiles').update({
      name, rep_id:repId, role, commission:parseFloat(comm)||0,
      territory: terr.split(',').map(x=>x.trim()).filter(Boolean)
    }).eq('id', id);
    if(q.error){ ui.err(q.error); return; }
    adminPanel.render();
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

/* ---------- BOOT ---------- */
async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){
    document.getElementById('auth').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
  try{
    await profiles.loadMe(session.user.id);
    await Promise.all([ref.loadAll(), profiles.loadReps()]);
  } catch(e){
    ui.err(e);
    return;
  }
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hide', !auth.isAdmin()));
  nav.go('dashboard');
}

sb.auth.onAuthStateChange((event)=>{
  if(event === 'SIGNED_OUT') location.reload();
  if(event === 'PASSWORD_RECOVERY') auth.applyRecoveryFlow();
});

auth.applyRecoveryFlow();
boot();
