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
    await boot();
  },
  async signup(){
    const errEl = document.getElementById('auth-err');
    const extras = document.getElementById('signup-extras');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    const pass  = (document.getElementById('auth-pass').value||'');
    if(!email || pass.length < 6){
      errEl.classList.remove('ok'); errEl.classList.add('err');
      errEl.textContent = 'Email + a password of at least 6 characters required first.';
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
    if(view==='forecast')  forecasts.render();
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
      tax_exempt:false, opt_in:true, notes:[], rep_id: auth.repId()
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
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="accounts.save('${acc.id||''}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="accounts.remove('${acc.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
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
    const r = await sb.from('account_notes').delete().eq('id', noteId);
    if(r.error){
      const msg = /row-level security|permission/i.test(r.error.message)
        ? 'Cannot delete this note — past the 24-hour window or not your note.'
        : r.error.message;
      ui.err({ message: msg });
      return;
    }
    accounts.renderNotes(accountId);
  },
  async save(id, isNew){
    const get = i => document.getElementById(i).value;
    const payload = {
      business_name:get('f-bn'), type:get('f-type'), billing_name:get('f-rn'),
      email:get('f-em'), business_address:get('f-ba'), billing_address:get('f-bla'),
      cell:get('f-cell'), business_phone:get('f-bp'),
      sales_tax_license:get('f-stl'), sales_tax_state:get('f-sts'),
      tax_exempt: document.getElementById('f-exempt').checked,
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
          <div><label>Shipping ($)</label><input id="o-ship" type="number" step="0.01" value="${orders._draft.shipping}" onchange="orders.recompute()"/></div>
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
          <div><label>Authorization signature</label>
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
        <button class="icon-btn" onclick="orders.saveDraft('${orders._draft.id||''}', ${isNew})">Save draft</button>
        <button class="icon-btn primary" onclick="orders.finalize('${orders._draft.id||''}', ${isNew})">Finalize & invoice</button>
        ${!isNew?`<button class="icon-btn danger" onclick="orders.remove('${orders._draft.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
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
    const sig = orders._draft.payment?.signature;
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
    const cardMethods = ['Visa','Mastercard','Amex'];
    if(cardMethods.includes(d.payment.method) && !d.payment.signature){ ui.toast('Card payment requires an authorization signature. Tap "Get signature".'); return; }

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
    await orders.syncTaxToAccount(d);
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
      ui.modal(`
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
    ui.closeModal();
    if(sigpad._resolve){ const r = sigpad._resolve; sigpad._resolve = null; r({ signed:true, dataUrl, signedAt:new Date().toISOString() }); }
  },
  cancel(){
    ui.closeModal();
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
      ${o.payment?.signature ? `
        <div style="margin-top:10px">
          <div class="muted" style="font-size:11px;margin-bottom:4px">Authorization signature</div>
          <div style="background:white;border-radius:6px;padding:4px;max-width:320px">
            <img src="${o.payment.signature}" style="display:block;width:100%;max-height:80px;object-fit:contain"/>
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
    const r = await sb.from('promotions').delete().eq('id', id);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal(); promos.render();
  }
};

/* ---------- REPORTS ---------- */
const reports = {
  setRange(preset){
    const d = new Date();
    const iso = x => x.toISOString().slice(0,10);
    const monStart = (yr, mo) => new Date(yr, mo, 1);
    const monEnd   = (yr, mo) => new Date(yr, mo+1, 0);
    let from, to;
    switch(preset){
      case 'today':       from = to = iso(d); break;
      case 'yesterday': {
        const y = new Date(d); y.setDate(d.getDate()-1);
        from = to = iso(y); break;
      }
      case 'week': {
        const dow = d.getDay() || 7; /* Mon=1..Sun=7 */
        const mon = new Date(d); mon.setDate(d.getDate() - (dow-1));
        from = iso(mon); to = iso(d); break;
      }
      case 'lastweek': {
        const dow = d.getDay() || 7;
        const thisMon = new Date(d); thisMon.setDate(d.getDate() - (dow-1));
        const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
        const lastSun = new Date(thisMon); lastSun.setDate(thisMon.getDate() - 1);
        from = iso(lastMon); to = iso(lastSun); break;
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
      case 'lastyear':    from = iso(monStart(d.getFullYear()-1, 0));
                          to   = iso(monEnd  (d.getFullYear()-1, 11)); break;
      case 'all':         from = '2000-01-01'; to = iso(d); break;
      default: return;
    }
    document.getElementById('rep-from').value = from;
    document.getElementById('rep-to').value = to;
    reports.run();
  },
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

    /* trend over time */
    reports.renderTrend(list);

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
  renderTrend(list){
    const fromStr = document.getElementById('rep-from').value;
    const toStr   = document.getElementById('rep-to').value;
    const titleEl = document.getElementById('rep-trend-title');
    const wrap    = document.getElementById('rep-trend');
    if(!fromStr || !toStr){ wrap.innerHTML=''; return; }
    const from = new Date(fromStr + 'T00:00:00');
    const to   = new Date(toStr   + 'T23:59:59');
    const dayMs = 86400000;
    const days = Math.max(1, Math.ceil((to - from) / dayMs) + 1);
    const bucketBy = days <= 31 ? 'day' : days <= 120 ? 'week' : 'month';
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
  exportCsv(){
    const list = reports._lastList || [];
    const from = document.getElementById('rep-from').value;
    const to = document.getElementById('rep-to').value;
    const rep = document.getElementById('rep-rep').value;
    const rows = [
      ...csvWatermark(`Orders ${from} → ${to}${rep?' · rep '+rep:''}`),
      ['Date','Order','AccountNumber','Account','Type','Rep','Subtotal','Discount','Shipping','Tax','Total','Commission']
    ];
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

/* ---------- CUSTOMER SERVICE (rule-based OR live AI via Edge Function) ---------- */
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
          <div style="margin-top:6px">
            <button type="button" class="icon-btn ghost" onclick="forecasts.addProspectInline()">+ Add new prospect</button>
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
    const [kind, ref] = target.split(':');
    const payload = {
      rep_id: auth.repId(),
      account_id: kind==='acc' ? ref : null,
      prospect_id: kind==='pros' ? ref : null,
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
    const r = await sb.from('forecasts').delete().eq('id', id);
    if(r.error){ ui.err(r.error); return; }
    ui.closeModal(); ui.toast('Deleted'); forecasts.render();
  },
  exportCsv(){
    /* export current view */
    forecasts.list({period: document.getElementById('fc-period').value}).then(list=>{
      const period = document.getElementById('fc-period').value;
      const rows = [
        ...csvWatermark(`Forecasts · ${period}`),
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

/* ---------- ADMIN ---------- */
const adminPanel = {
  async render(){
    await profiles.loadReps();
    const me = cache.me;
    document.getElementById('rep-list').innerHTML = cache.reps.length ? cache.reps.map(r=>{
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
        <button class="icon-btn ghost" onclick="adminPanel.resetRepPassword('${esc(r.email).replace(/'/g,'&#39;')}')">Reset PW</button>
        ${isSelf ? '' : (disabled
          ? `<button class="icon-btn" onclick="adminPanel.enableRep('${r.id}')">Enable</button>`
          : `<button class="icon-btn danger" onclick="adminPanel.disableRep('${r.id}')">Disable</button>`)}
      </div>`;
    }).join('') : '<div class="muted">No reps yet.</div>';

    /* pending invites */
    const inviteWrap = document.getElementById('invite-list');
    if(inviteWrap){
      const invites = await adminPanel.loadInvites();
      inviteWrap.innerHTML = invites.length ? invites.map(i=>`
        <div class="list-item">
          <div class="grow">
            <div class="title">${esc(i.email)} <span class="badge warn">${esc(i.rep_id||'no rep id')}</span> <span class="badge">${esc(i.role)}</span></div>
            <div class="meta">Will become: ${esc(i.name||'(name from email)')} · commission ${i.commission||0}% · invited ${new Date(i.created_at).toLocaleDateString()}</div>
          </div>
          <button class="icon-btn" onclick="adminPanel.openInviteModal('${esc(i.email).replace(/'/g,'&#39;')}')">Edit</button>
          <button class="icon-btn danger" onclick="adminPanel.cancelInvite('${esc(i.email).replace(/'/g,'&#39;')}')">Cancel</button>
        </div>`).join('') : '<div class="muted" style="font-size:13px">No pending invites. New reps you add via "+ Add rep" appear here until they sign up.</div>';
    }

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
    /* audit log */
    auditLog.render();
  },
  async loadInvites(){
    const { data, error } = await sb.from('pending_invites').select('*').order('created_at',{ascending:false});
    if(error){ return []; }
    return data || [];
  },
  async openRepModal(id){
    const r = id ? cache.reps.find(x=>x.id===id) : null;
    const isNew = !r;
    const prof = r || { email:'', name:'', rep_id:'', role:'rep', commission:10, territory:[], cell:'', company:'', street:'', city:'', state:'', zip:'' };
    ui.modal(`
      <h3>${isNew?'Add rep':'Edit '+esc(prof.name||prof.email)}</h3>
      ${isNew ? '<p class="muted" style="font-size:13px;margin:0 0 12px">If this email has already signed up, this updates their profile. If not, the settings are saved as a pending invite and applied automatically when they sign up.</p>' : ''}
      <div class="grid-2">
        <div><label>Email</label><input id="r-email" type="email" value="${esc(prof.email)}" ${isNew?'':'disabled'} autocapitalize="none"/></div>
        <div><label>Full name</label><input id="r-name" value="${esc(prof.name||'')}"/></div>
        <div><label>Cell phone</label><input id="r-cell" value="${esc(prof.cell||'')}" placeholder="555-555-5555"/></div>
        <div><label>Company (optional)</label><input id="r-company" value="${esc(prof.company||'')}"/></div>
        <div><label>Rep ID</label><input id="r-repid" value="${esc(prof.rep_id||'')}" placeholder="R-002"/></div>
        <div><label>Role</label>
          <select id="r-role">
            <option value="rep" ${prof.role==='rep'?'selected':''}>rep</option>
            <option value="admin" ${prof.role==='admin'?'selected':''}>admin</option>
          </select>
        </div>
        <div><label>Commission %</label><input id="r-comm" type="number" step="0.1" value="${prof.commission ?? 10}"/></div>
        <div><label>Territory ZIPs (comma)</label><input id="r-terr" value="${esc((prof.territory||[]).join(', '))}" placeholder="80210, 80211"/></div>
        <div style="grid-column:1/-1"><label>Street address</label><input id="r-street" value="${esc(prof.street||'')}"/></div>
        <div><label>City</label><input id="r-city" value="${esc(prof.city||'')}"/></div>
        <div><label>State</label><input id="r-state" value="${esc(prof.state||'')}" placeholder="CO"/></div>
        <div><label>ZIP</label><input id="r-zip" value="${esc(prof.zip||'')}"/></div>
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
        <div><label>Commission %</label><input id="r-comm" type="number" step="0.1" value="${inv.commission ?? 10}"/></div>
        <div><label>Territory ZIPs (comma)</label><input id="r-terr" value="${esc((inv.territory||[]).join(', '))}" placeholder="80210, 80211"/></div>
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
    const payload = {
      name: get('r-name').trim(),
      rep_id: get('r-repid').trim() || null,
      role: get('r-role'),
      commission: parseFloat(get('r-comm')||'0') || 0,
      territory: get('r-terr').split(',').map(x=>x.trim()).filter(Boolean),
      cell: get('r-cell').trim() || null,
      company: get('r-company').trim() || null,
      street: get('r-street').trim() || null,
      city: get('r-city').trim() || null,
      state: get('r-state').trim() || null,
      zip: get('r-zip').trim() || null
    };
    if(!isNew){
      const q = await sb.from('profiles').update(payload).eq('id', id);
      if(q.error){ ui.err(q.error); return; }
      ui.closeModal(); ui.toast('Saved'); adminPanel.render();
      return;
    }
    if(!email){ ui.toast('Email required'); return; }
    /* Does this email already have a profile? If so update; else upsert pending invite */
    const ex = await sb.from('profiles').select('id').ilike('email', email).maybeSingle();
    if(ex.data){
      const q = await sb.from('profiles').update(payload).eq('id', ex.data.id);
      if(q.error){ ui.err(q.error); return; }
      ui.closeModal(); ui.toast('Existing user — profile updated.'); adminPanel.render();
      return;
    }
    /* Upsert pending invite */
    const me = (await sb.auth.getUser()).data.user;
    const q = await sb.from('pending_invites').upsert({
      email, ...payload, invited_by: me?.id || null
    });
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal();
    ui.toast(`Invite saved. Tell ${email} to sign up at the CRM URL.`);
    adminPanel.render();
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
    const q = await sb.from('pending_invites').upsert(payload);
    if(q.error){ ui.err(q.error); return; }
    ui.closeModal(); ui.toast('Invite updated'); adminPanel.render();
  },
  async cancelInvite(email){
    if(!confirm(`Cancel invite for ${email}?`)) return;
    const q = await sb.from('pending_invites').delete().eq('email', email);
    if(q.error){ ui.err(q.error); return; }
    ui.toast('Invite cancelled'); adminPanel.render();
  },
  async disableRep(id){
    if(!confirm('Disable this rep? They will not be able to sign in, but their data stays for history.')) return;
    const q = await sb.from('profiles').update({ disabled: true }).eq('id', id);
    if(q.error){ ui.err(q.error); return; }
    ui.toast('Disabled'); adminPanel.render();
  },
  async enableRep(id){
    const q = await sb.from('profiles').update({ disabled: false }).eq('id', id);
    if(q.error){ ui.err(q.error); return; }
    ui.toast('Re-enabled'); adminPanel.render();
  },
  async resetRepPassword(email){
    if(!confirm(`Send password reset email to ${email}?`)) return;
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname + '#reset'
    });
    if(error){ ui.err(error); return; }
    ui.toast('Reset email sent to ' + email);
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
    /* Normalize: combine all factors then split by type */
    const all = (r.data?.all || r.data?.totp || []).concat(r.data?.phone || []);
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

/* ---------- ABSOLUTE SESSION TIMEOUT ---------- */
const absoluteTimeout = {
  MAX_MS: 12 * 60 * 60 * 1000,  /* 12 hours */
  KEY: 'reflectco.session_started_at',
  _interval: null,
  start(){
    if(absoluteTimeout._interval) return;
    let started = parseInt(localStorage.getItem(absoluteTimeout.KEY) || '0', 10);
    if(!started){
      started = Date.now();
      localStorage.setItem(absoluteTimeout.KEY, String(started));
    }
    absoluteTimeout._interval = setInterval(()=>{
      if(Date.now() - started > absoluteTimeout.MAX_MS){
        clearInterval(absoluteTimeout._interval); absoluteTimeout._interval = null;
        localStorage.removeItem(absoluteTimeout.KEY);
        alert('Your session has reached the 12-hour maximum. Signing you out for security.');
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
  const { data: { session } } = await sb.auth.getSession();
  if(!session){
    document.getElementById('auth').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
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
    ui.err(e);
    return;
  }
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hide', !auth.isAdmin()));
  idleLogout.start();
  absoluteTimeout.start();
  nav.go('dashboard');
}

sb.auth.onAuthStateChange((event)=>{
  if(event === 'SIGNED_OUT') location.reload();
  if(event === 'PASSWORD_RECOVERY') auth.applyRecoveryFlow();
});

auth.applyRecoveryFlow();
boot();
