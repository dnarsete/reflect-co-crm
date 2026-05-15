/* =========================================================
   The Reflect Co — Rep CRM (HTML prototype)
   Single-file SPA. LocalStorage persistence.
   ========================================================= */

const STORE_KEY = 'reflectco.crm.v1';
const fmt$ = n => '$' + (Number(n||0)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
const todayISO = () => new Date().toISOString().slice(0,10);
const startOfMonth = () => { const d=new Date(); return new Date(d.getFullYear(),d.getMonth(),1).toISOString().slice(0,10) };
const uid = (prefix='') => prefix + Math.random().toString(36).slice(2,9);

let db;

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(raw) return JSON.parse(raw);
  }catch(e){}
  return seed.defaults();
}
function save(){ localStorage.setItem(STORE_KEY, JSON.stringify(db)); }

/* ============ SEED ============ */
const seed = {
  defaults(){
    return {
      session:null,
      users:[
        {id:'u-admin', name:'Admin', email:'admin@thereflectco.com', pass:'admin', role:'admin'},
        {id:'u-rep1',  name:'Casey Rep', email:'rep@thereflectco.com', pass:'rep', role:'rep', repId:'R-001', commission:10, territory:['80210','80211','80203']}
      ],
      reps:[
        {id:'R-001', name:'Casey Rep', email:'rep@thereflectco.com', commission:10, territory:['80210','80211','80203']}
      ],
      accountTypes:['Dermatologist','Medical Spa','Boutique','Hotel','Retail Store','Salon','Other'],
      accounts:[],
      orders:[],
      promotions:[
        {id:uid('P'), code:'WELCOME10', kind:'percent', value:10, perks:'10% off intro', minQty:0, active:true},
        {id:uid('P'), code:'FREESHIP24', kind:'shipping', value:0, perks:'Free shipping on 24+ units', minQty:24, active:true},
        {id:uid('P'), code:'BOGO48', kind:'bonus', value:0, perks:'Bonus product on 48+ units', minQty:48, active:true},
        {id:uid('P'), code:'SEMINAR100', kind:'access', value:0, perks:'Seminar access at 100+ units', minQty:100, active:true}
      ],
      products:[
        {sku:'RC-SERUM-01', name:'Reflect Serum 30ml', price:48, stock:120},
        {sku:'RC-CREAM-02', name:'Reflect Cream 50ml', price:62, stock:18},
        {sku:'RC-MASK-03',  name:'Reflect Hydrating Mask', price:24, stock:200},
        {sku:'RC-KIT-04',   name:'Reflect Starter Kit',  price:140, stock:42}
      ],
      settings:{
        shippingDefault:30,
        taxRateDefault:0.0881, /* CO state + Denver County combined approx */
        taxLabelDefault:'Colorado + Denver County',
        highDiscountAlertPct:20,
        reorderDueDays:45,
        lowStockThreshold:25,
        company:{
          name:'The Reflect Co',
          website:'thereflectco.com',
          phone:'TBD',
          address:'3642 S. Jason Street, Englewood, CO 80210'
        }
      },
      counters:{account:0, order:1000}
    };
  },
  reset(){
    if(!confirm('Reset all demo data? This wipes accounts, orders, promotions.')) return;
    db = seed.defaults();
    seed.populate();
    save();
    ui.toast('Demo data reset');
    boot();
  },
  populate(){
    if(db.accounts.length) return;
    const rep = db.reps[0].id;
    const mk = (over)=>({
      id: uid('A'),
      accountNumber: 'ACC-' + String(++db.counters.account).padStart(4,'0'),
      createdAt: new Date(Date.now() - Math.random()*1000*60*60*24*60).toISOString(),
      repId: rep,
      type:'Medical Spa',
      businessName:'',
      billingName:'',
      businessAddress:'',
      billingAddress:'',
      email:'',
      cell:'',
      businessPhone:'',
      salesTaxLicense:'',
      salesTaxState:'',
      optIn:true,
      notes:[],
      ...over
    });
    db.accounts.push(
      mk({type:'Medical Spa', businessName:'Glow Aesthetics', billingName:'Jane Park', businessAddress:'120 5th Ave, Denver CO 80203', billingAddress:'120 5th Ave, Denver CO 80203', email:'jane@glow.co', cell:'303-555-0142', businessPhone:'303-555-0188'}),
      mk({type:'Dermatologist', businessName:'Front Range Derm', billingName:'Dr. Liu', businessAddress:'88 Speer Blvd, Denver CO 80211', billingAddress:'88 Speer Blvd, Denver CO 80211', email:'office@frderm.com', cell:'720-555-0101', businessPhone:'720-555-0100', salesTaxLicense:'CO-887421', salesTaxState:'CO'}),
      mk({type:'Boutique', businessName:'Pine & Petal', billingName:'M. Hayes', businessAddress:'14 Pearl St, Boulder CO 80302', billingAddress:'14 Pearl St, Boulder CO 80302', email:'hi@pinepetal.com', cell:'303-555-0177', businessPhone:'303-555-0123'}),
      mk({type:'Hotel', businessName:'The Brown Palace', billingName:'A/P Dept', businessAddress:'321 17th St, Denver CO 80202', billingAddress:'321 17th St, Denver CO 80202', email:'ap@brownpalace.com', cell:'', businessPhone:'303-555-0900'})
    );
    /* a couple of orders */
    db.orders.push({
      id: uid('O'),
      orderNumber:'ORD-' + (++db.counters.order),
      accountId: db.accounts[0].id,
      repId: rep,
      placedAt: new Date(Date.now() - 1000*60*60*24*7).toISOString(),
      items:[{sku:'RC-SERUM-01', name:'Reflect Serum 30ml', qty:6, price:48}],
      shipping:30, tax: 6*48*0.0881, taxLabel:'Colorado + Denver County',
      promoCode:'', promoEffect:'', discount:0,
      payment:{method:'Visa', last4:'4242', authorized:true, esign:true},
      status:'finalized',
      tracking:'',
      total: 6*48 + 30 + (6*48*0.0881)
    });
  }
};

db = load();
seed.populate();
save();

/* ============ UI helpers ============ */
const ui = {
  modal(html){
    document.getElementById('modal').innerHTML = html;
    document.getElementById('modal-back').classList.add('show');
  },
  closeModal(){ document.getElementById('modal-back').classList.remove('show') },
  toast(msg){
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.remove('hide');
    clearTimeout(ui._tt); ui._tt = setTimeout(()=>t.classList.add('hide'), 2200);
  }
};

/* ============ AUTH ============ */
const auth = {
  login(){
    const errEl = document.getElementById('auth-err');
    const email = (document.getElementById('auth-email').value||'').trim().toLowerCase();
    const pass  = (document.getElementById('auth-pass').value||'').trim();
    if(!email || !pass){
      errEl.textContent = 'Enter email and password.'; errEl.classList.remove('hide'); return;
    }
    /* self-heal: if the demo users aren't in localStorage (older save), restore them */
    if(!db.users || !db.users.length){
      db.users = seed.defaults().users; save();
    }
    const u = db.users.find(u=>u.email.toLowerCase()===email && u.pass===pass);
    if(!u){
      errEl.innerHTML = 'Invalid credentials. Try the <b>Use Rep demo</b> / <b>Use Admin demo</b> buttons below — or "Reset local data" if you reused this file before.';
      errEl.classList.remove('hide'); return;
    }
    errEl.classList.add('hide');
    db.session = {userId:u.id, at:new Date().toISOString()};
    save(); boot();
  },
  fill(email, pass){
    document.getElementById('auth-email').value = email;
    document.getElementById('auth-pass').value = pass;
    auth.login();
  },
  hardReset(){
    localStorage.removeItem(STORE_KEY);
    location.reload();
  },
  logout(){ db.session=null; save(); boot(); },
  user(){ return db.session ? db.users.find(u=>u.id===db.session.userId) : null; },
  isAdmin(){ const u=auth.user(); return u && u.role==='admin'; },
  repIdForUser(){ const u=auth.user(); return u && u.repId ? u.repId : (db.reps[0]?.id || null); }
};

/* ============ NAV ============ */
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

/* ============ DASHBOARD ============ */
const dashboard = {
  render(){
    const u = auth.user();
    document.getElementById('who').textContent = u.name + (u.role==='admin'?' · Admin':' · Rep');
    document.getElementById('role-pill').textContent = u.role==='admin'?'Admin':'Rep';

    const myOrders = orders.scope(db.orders).filter(o=>o.placedAt>=startOfMonth());
    const rev = myOrders.reduce((s,o)=>s+o.total,0);
    const comm = orders.totalCommission(myOrders);
    document.getElementById('kpi-accounts').textContent = accounts.scope(db.accounts).length;
    document.getElementById('kpi-orders').textContent   = myOrders.length;
    document.getElementById('kpi-rev').textContent      = fmt$(rev);
    document.getElementById('kpi-comm').textContent     = fmt$(comm);

    /* alerts */
    const alerts = [];
    const lowStock = db.products.filter(p=>p.stock<=db.settings.lowStockThreshold);
    lowStock.forEach(p=>alerts.push({lvl:'warn', text:`Low stock — ${p.name} (${p.stock} left)`}));

    const dueDays = db.settings.reorderDueDays;
    accounts.scope(db.accounts).forEach(a=>{
      const last = db.orders.filter(o=>o.accountId===a.id).sort((x,y)=>y.placedAt.localeCompare(x.placedAt))[0];
      if(last){
        const days = Math.floor((Date.now()-new Date(last.placedAt))/86400000);
        if(days>=dueDays) alerts.push({lvl:'info', text:`${a.businessName||a.accountNumber} due for reorder (${days}d since last)`});
      } else {
        const days = Math.floor((Date.now()-new Date(a.createdAt))/86400000);
        if(days>14) alerts.push({lvl:'info', text:`${a.businessName||a.accountNumber} has no orders yet (${days}d old)`});
      }
    });

    const wrap = document.getElementById('alerts');
    if(!alerts.length){ wrap.innerHTML = '<div class="muted">All clear.</div>'; return; }
    wrap.innerHTML = alerts.slice(0,8).map(a=>`<div class="alert ${a.lvl==='warn'?'warn':''}">${a.text}</div>`).join('');
  }
};

/* ============ ACCOUNTS ============ */
const accounts = {
  scope(list){
    if(auth.isAdmin()) return list;
    const repId = auth.repIdForUser();
    return list.filter(a=>a.repId===repId);
  },
  render(){
    /* type filter */
    const tf = document.getElementById('acc-type-filter');
    const cur = tf.value;
    tf.innerHTML = '<option value="">All types</option>' + db.accountTypes.map(t=>`<option ${cur===t?'selected':''}>${t}</option>`).join('');

    const q = (document.getElementById('acc-search').value||'').toLowerCase();
    const type = tf.value;
    const list = accounts.scope(db.accounts).filter(a=>{
      const hay = [a.businessName,a.billingName,a.businessAddress,a.email,a.accountNumber].join(' ').toLowerCase();
      return (!q || hay.includes(q)) && (!type || a.type===type);
    }).sort((x,y)=>y.createdAt.localeCompare(x.createdAt));

    const wrap = document.getElementById('acc-list');
    if(!list.length){ wrap.innerHTML='<div class="muted">No accounts yet. Tap “+ New”.</div>'; return; }
    wrap.innerHTML = list.map(a=>`
      <div class="list-item">
        <div class="grow">
          <div class="title">${a.businessName||'(unnamed)'} <span class="badge info">${a.type||'—'}</span></div>
          <div class="meta">${a.accountNumber} · ${a.businessAddress||'no address'} · ${a.email||''}</div>
        </div>
        <button class="icon-btn" onclick="accounts.open('${a.id}')">Open</button>
      </div>
    `).join('');
  },
  openNew(){ accounts.open(null) },
  open(id){
    const a = id ? db.accounts.find(x=>x.id===id) : null;
    const isNew = !a;
    const acc = a || {
      id: uid('A'), accountNumber:'', createdAt:new Date().toISOString(), repId: auth.repIdForUser(),
      type:'Medical Spa', businessName:'', billingName:'', businessAddress:'', billingAddress:'',
      email:'', cell:'', businessPhone:'', salesTaxLicense:'', salesTaxState:'', optIn:true, notes:[]
    };
    const typeOpts = db.accountTypes.map(t=>`<option ${acc.type===t?'selected':''}>${t}</option>`).join('');
    ui.modal(`
      <h3>${isNew?'New account':'Account · '+(acc.accountNumber||'')}</h3>
      <div class="grid-2">
        <div><label>Business name</label><input id="f-bn" value="${esc(acc.businessName)}"/></div>
        <div><label>Account type</label><select id="f-type">${typeOpts}</select></div>
        <div><label>Billing responsible person</label><input id="f-rn" value="${esc(acc.billingName)}"/></div>
        <div><label>Account email</label><input id="f-em" type="email" value="${esc(acc.email)}"/></div>
        <div><label>Business address</label><input id="f-ba" value="${esc(acc.businessAddress)}"/></div>
        <div><label>Billing address</label><input id="f-bla" value="${esc(acc.billingAddress)}"/></div>
        <div><label>Cell (responsible)</label><input id="f-cell" value="${esc(acc.cell)}"/></div>
        <div><label>Business phone</label><input id="f-bp" value="${esc(acc.businessPhone)}"/></div>
        <div><label>Sales tax license #</label><input id="f-stl" value="${esc(acc.salesTaxLicense)}"/></div>
        <div><label>License state</label><input id="f-sts" value="${esc(acc.salesTaxState)}" placeholder="CO"/></div>
        <div><label>Opt-in to comms</label>
          <select id="f-opt"><option value="true" ${acc.optIn?'selected':''}>Opted in</option><option value="false" ${!acc.optIn?'selected':''}>Opted out</option></select>
        </div>
        <div><label>Assigned rep</label>
          <select id="f-rep">${db.reps.map(r=>`<option value="${r.id}" ${acc.repId===r.id?'selected':''}>${r.name} (${r.id})</option>`).join('')}</select>
        </div>
      </div>
      <div class="card" style="margin-top:10px">
        <h2>Call / visit log</h2>
        <div id="acc-notes"></div>
        <div class="row" style="gap:8px;margin-top:8px">
          <input id="note-text" placeholder="Add a note (call, visit, geo check-in…)" />
          <button class="icon-btn" onclick="accounts.addNote('${acc.id}')">Add</button>
        </div>
        <p class="muted" style="margin-bottom:0;font-size:12px">License upload, geolocation, and voice-to-text are placeholders (real device APIs / Shopify Files API in production).</p>
      </div>
      <div class="row" style="gap:8px;margin-top:12px">
        <button class="icon-btn primary" onclick="accounts.save('${acc.id}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="accounts.remove('${acc.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
    /* render notes */
    if(!isNew){
      const nw = document.getElementById('acc-notes');
      const real = db.accounts.find(x=>x.id===acc.id);
      nw.innerHTML = (real.notes||[]).slice().reverse().map(n=>`<div class="list-item"><div class="grow"><div>${esc(n.text)}</div><div class="meta">${n.at}</div></div></div>`).join('') || '<div class="muted">No notes yet.</div>';
    }
  },
  save(id, isNew){
    const get = i=>document.getElementById(i).value;
    let acc = db.accounts.find(x=>x.id===id);
    if(!acc){
      acc = {id, accountNumber:'', createdAt:new Date().toISOString(), notes:[]};
      db.accounts.push(acc);
    }
    if(!acc.accountNumber){
      acc.accountNumber = 'ACC-' + String(++db.counters.account).padStart(4,'0');
    }
    Object.assign(acc, {
      businessName:get('f-bn'), type:get('f-type'), billingName:get('f-rn'),
      email:get('f-em'), businessAddress:get('f-ba'), billingAddress:get('f-bla'),
      cell:get('f-cell'), businessPhone:get('f-bp'),
      salesTaxLicense:get('f-stl'), salesTaxState:get('f-sts'),
      optIn:get('f-opt')==='true', repId:get('f-rep')
    });
    save(); ui.closeModal(); ui.toast(isNew?'Account created':'Saved'); accounts.render(); dashboard.render();
  },
  addNote(id){
    const acc = db.accounts.find(x=>x.id===id); if(!acc) return;
    const text = document.getElementById('note-text').value.trim();
    if(!text) return;
    acc.notes = acc.notes || [];
    acc.notes.push({text, at:new Date().toLocaleString()});
    save(); accounts.open(id);
  },
  remove(id){
    if(!confirm('Delete this account? Orders will keep their reference.')) return;
    db.accounts = db.accounts.filter(a=>a.id!==id);
    save(); ui.closeModal(); ui.toast('Deleted'); accounts.render();
  }
};

/* ============ ORDERS ============ */
const orders = {
  scope(list){
    if(auth.isAdmin()) return list;
    const repId = auth.repIdForUser();
    return list.filter(o=>o.repId===repId);
  },
  totalCommission(list){
    const repPct = (id)=> (db.reps.find(r=>r.id===id)?.commission || 0)/100;
    return list.reduce((s,o)=> s + (o.total - o.shipping - o.tax) * repPct(o.repId), 0);
  },
  render(){
    const q = (document.getElementById('ord-search').value||'').toLowerCase();
    const list = orders.scope(db.orders).filter(o=>{
      const acc = db.accounts.find(a=>a.id===o.accountId);
      const hay = [o.orderNumber, acc?.businessName, acc?.accountNumber, o.repId].join(' ').toLowerCase();
      return !q || hay.includes(q);
    }).sort((x,y)=>y.placedAt.localeCompare(x.placedAt));

    const wrap = document.getElementById('ord-list');
    if(!list.length){ wrap.innerHTML='<div class="muted">No orders yet.</div>'; return; }
    wrap.innerHTML = list.map(o=>{
      const acc = db.accounts.find(a=>a.id===o.accountId);
      const status = o.status==='finalized' ? 'ok' : (o.status==='draft' ? 'warn':'info');
      return `<div class="list-item">
        <div class="grow">
          <div class="title">${o.orderNumber} <span class="badge ${status}">${o.status}</span></div>
          <div class="meta">${acc?.businessName||'—'} · ${new Date(o.placedAt).toLocaleDateString()} · ${fmt$(o.total)}</div>
        </div>
        <button class="icon-btn" onclick="orders.open('${o.id}')">Open</button>
      </div>`;
    }).join('');
  },
  openNew(){ orders.open(null) },
  open(id){
    const o = id ? db.orders.find(x=>x.id===id) : null;
    const isNew = !o;
    const ord = o || {
      id:uid('O'), orderNumber:'', accountId:'', repId:auth.repIdForUser(),
      placedAt:new Date().toISOString(), items:[], shipping:db.settings.shippingDefault,
      tax:0, taxLabel:db.settings.taxLabelDefault, promoCode:'', promoEffect:'',
      discount:0, payment:{method:'Visa', last4:'', authorized:false, esign:false},
      status:'draft', tracking:'', total:0
    };

    const accOpts = accounts.scope(db.accounts).map(a=>`<option value="${a.id}" ${ord.accountId===a.id?'selected':''}>${a.accountNumber} — ${a.businessName||'(unnamed)'}</option>`).join('');
    const prodOpts = db.products.map(p=>`<option value="${p.sku}" data-price="${p.price}" data-name="${esc(p.name)}">${p.sku} · ${p.name} · ${fmt$(p.price)} (stock ${p.stock})</option>`).join('');

    ui.modal(`
      <h3>${isNew?'New order':'Order · '+ord.orderNumber}</h3>
      <div class="grid-2">
        <div><label>Account</label><select id="o-acc" onchange="orders.refresh()">${accOpts}</select></div>
        <div><label>Rep</label>
          <select id="o-rep">${db.reps.map(r=>`<option value="${r.id}" ${ord.repId===r.id?'selected':''}>${r.name} (${r.id})</option>`).join('')}</select>
        </div>
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
              <input id="o-promo" value="${esc(ord.promoCode||'')}" placeholder="e.g. WELCOME10"/>
              <button class="icon-btn" onclick="orders.applyPromo()">Apply</button>
            </div>
            <div class="muted" id="o-promo-msg" style="font-size:12px;margin-top:4px">${esc(ord.promoEffect||'No code applied')}</div>
          </div>
          <div><label>Shipping ($)</label><input id="o-ship" type="number" step="0.01" value="${ord.shipping}"/></div>
          <div><label>Tax (auto)</label><input id="o-tax" readonly value="${ord.tax.toFixed(2)}"/></div>
        </div>
        <div class="muted" id="o-tax-note" style="font-size:12px;margin-top:6px"></div>
      </div>

      <div class="card">
        <h2>Payment</h2>
        <div class="grid-3">
          <div><label>Method</label>
            <select id="o-pay-method">
              ${['Visa','Mastercard','Amex','Apple Pay','Venmo','PayPal','ACH'].map(m=>`<option ${ord.payment?.method===m?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>
          <div><label>Card last 4 (if card)</label><input id="o-pay-l4" value="${esc(ord.payment?.last4||'')}" maxlength="4"/></div>
          <div><label>New card e-signature</label>
            <select id="o-pay-esign"><option value="false" ${!ord.payment?.esign?'selected':''}>Not signed</option><option value="true" ${ord.payment?.esign?'selected':''}>E-signed on file</option></select>
          </div>
        </div>
        <p class="muted" style="font-size:12px;margin:8px 0 0">All sales final. No payment terms. Returns only for shipping damage (case-by-case). Card data is never stored in the CRM — production uses Shopify Payments / tokenized vault.</p>
      </div>

      <div class="card">
        <div class="row wrap">
          <div class="grow">
            <div><b>Subtotal</b> <span id="o-sub">$0.00</span></div>
            <div><b>Discount</b> <span id="o-disc">$0.00</span></div>
            <div><b>Shipping</b> <span id="o-shipv">$0.00</span></div>
            <div><b>Tax</b> <span id="o-taxv">$0.00</span> <span class="muted" id="o-taxlbl"></span></div>
            <div style="font-size:18px;margin-top:6px"><b>Total</b> <span id="o-total">$0.00</span></div>
          </div>
        </div>
      </div>

      <div class="row" style="gap:8px;margin-top:6px">
        <button class="icon-btn" onclick="orders.saveDraft('${ord.id}', ${isNew})">Save draft</button>
        <button class="icon-btn primary" onclick="orders.finalize('${ord.id}', ${isNew})">Finalize & invoice</button>
        ${!isNew?`<button class="icon-btn danger" onclick="orders.remove('${ord.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);

    orders._draft = JSON.parse(JSON.stringify(ord));
    orders.renderItems();
    orders.refresh();
  },
  _draft:null,
  refresh(){
    /* tax label by account */
    const acc = db.accounts.find(a=>a.id===document.getElementById('o-acc').value);
    let rate = db.settings.taxRateDefault, label = db.settings.taxLabelDefault;
    let note = `Default: ${label} (${(rate*100).toFixed(2)}%).`;
    if(acc && acc.salesTaxLicense){
      rate = 0; label = `Tax-exempt (license ${acc.salesTaxLicense}, ${acc.salesTaxState||'state'})`;
      note = `Account has a sales tax license — tax not collected.`;
    }
    orders._taxRate = rate; orders._taxLabel = label;
    document.getElementById('o-tax-note').textContent = note;
    orders.recompute();
  },
  renderItems(){
    const wrap = document.getElementById('o-items');
    if(!orders._draft.items.length){ wrap.innerHTML='<div class="muted">No items yet.</div>'; return; }
    wrap.innerHTML = `<div class="table-wrap"><table>
      <tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Line</th><th></th></tr>
      ${orders._draft.items.map((it,i)=>`
        <tr>
          <td class="nowrap">${it.sku}</td>
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
    orders._draft.items.push({sku:opt.value, name:opt.dataset.name, price:parseFloat(opt.dataset.price), qty});
    orders.renderItems(); orders.recompute();
  },
  setQty(i,v){ orders._draft.items[i].qty = Math.max(1, parseInt(v||'1',10)); orders.renderItems(); orders.recompute(); },
  removeItem(i){ orders._draft.items.splice(i,1); orders.renderItems(); orders.recompute(); },
  applyPromo(){
    const code = (document.getElementById('o-promo').value||'').trim().toUpperCase();
    document.getElementById('o-promo').value = code;
    const p = db.promotions.find(x=>x.code===code && x.active);
    const qty = orders._draft.items.reduce((s,i)=>s+i.qty,0);
    if(!p){
      orders._draft.promoCode=''; orders._draft.promoEffect=''; orders._draft.discount=0;
      document.getElementById('o-promo-msg').textContent = code ? 'Code not found / inactive' : 'No code applied';
      orders.recompute(); return;
    }
    if(p.minQty && qty < p.minQty){
      orders._draft.promoCode=''; orders._draft.promoEffect=''; orders._draft.discount=0;
      document.getElementById('o-promo-msg').textContent = `Requires ${p.minQty}+ units (current ${qty}).`;
      orders.recompute(); return;
    }
    orders._draft.promoCode = p.code;
    if(p.kind==='percent'){
      orders._draft.promoEffect = `${p.value}% off subtotal`;
    } else if(p.kind==='shipping'){
      orders._draft.promoEffect = 'Free shipping';
    } else if(p.kind==='bonus'){
      orders._draft.promoEffect = 'Bonus product included with shipment';
    } else if(p.kind==='access'){
      orders._draft.promoEffect = p.perks || 'Access perk';
    }
    document.getElementById('o-promo-msg').textContent = orders._draft.promoEffect;
    orders.recompute();
  },
  recompute(){
    const d = orders._draft; if(!d) return;
    const sub = d.items.reduce((s,i)=>s+i.qty*i.price,0);
    const p = db.promotions.find(x=>x.code===d.promoCode);
    let disc = 0, ship = parseFloat(document.getElementById('o-ship').value||db.settings.shippingDefault);
    if(p?.kind==='percent') disc = sub * (p.value/100);
    if(p?.kind==='shipping') ship = 0;
    const taxable = Math.max(0, sub - disc);
    const tax = taxable * (orders._taxRate||0);
    const total = taxable + ship + tax;
    d.discount = disc; d.shipping = ship; d.tax = tax;
    d.taxLabel = orders._taxLabel; d.total = total;
    document.getElementById('o-sub').textContent = fmt$(sub);
    document.getElementById('o-disc').textContent = fmt$(disc);
    document.getElementById('o-shipv').textContent = fmt$(ship);
    document.getElementById('o-taxv').textContent = fmt$(tax);
    document.getElementById('o-taxlbl').textContent = orders._taxLabel ? `(${orders._taxLabel})` : '';
    document.getElementById('o-total').textContent = fmt$(total);
    document.getElementById('o-tax').value = tax.toFixed(2);
  },
  collect(id){
    const d = orders._draft;
    d.accountId = document.getElementById('o-acc').value;
    d.repId = document.getElementById('o-rep').value;
    d.shipping = parseFloat(document.getElementById('o-ship').value||0);
    d.payment = {
      method: document.getElementById('o-pay-method').value,
      last4: document.getElementById('o-pay-l4').value,
      esign: document.getElementById('o-pay-esign').value==='true',
      authorized: false
    };
    return d;
  },
  saveDraft(id, isNew){
    const d = orders.collect(id);
    d.status='draft';
    if(isNew){ db.orders.push(d); }
    else { const i = db.orders.findIndex(x=>x.id===id); db.orders[i]=d; }
    save(); ui.closeModal(); ui.toast('Draft saved'); orders.render();
  },
  finalize(id, isNew){
    const d = orders.collect(id);
    if(!d.accountId){ ui.toast('Pick an account first'); return; }
    if(!d.items.length){ ui.toast('Add at least one item'); return; }
    const cardMethods = ['Visa','Mastercard','Amex'];
    if(cardMethods.includes(d.payment.method) && !d.payment.esign){
      ui.toast('New card requires e-signature'); return;
    }

    /* high-discount alert flag */
    const sub = d.items.reduce((s,i)=>s+i.qty*i.price,0);
    const discPct = sub>0 ? (d.discount/sub*100) : 0;
    const adminFlag = discPct >= db.settings.highDiscountAlertPct ? `High discount (${discPct.toFixed(1)}%) — admin will be notified.\n` : '';

    if(!confirm(adminFlag+'Finalize this order? This generates an order #, invoice, and charges payment.')) return;

    d.status='finalized';
    d.placedAt = new Date().toISOString();
    if(!d.orderNumber) d.orderNumber = 'ORD-' + (++db.counters.order);
    d.payment.authorized = true;
    d.tracking = 'PENDING';

    if(isNew){ db.orders.push(d); }
    else { const i = db.orders.findIndex(x=>x.id===id); db.orders[i]=d; }
    save(); ui.closeModal();
    invoice.show(d);
    dashboard.render(); orders.render();
  },
  remove(id){
    if(!confirm('Delete this order?')) return;
    db.orders = db.orders.filter(o=>o.id!==id);
    save(); ui.closeModal(); ui.toast('Deleted'); orders.render();
  }
};

/* ============ INVOICE ============ */
const invoice = {
  show(o){
    const acc = db.accounts.find(a=>a.id===o.accountId);
    const rep = db.reps.find(r=>r.id===o.repId);
    const sub = o.items.reduce((s,i)=>s+i.qty*i.price,0);
    ui.modal(`
      <h3>Invoice · ${o.orderNumber}</h3>
      <div class="muted" style="margin-bottom:8px">${new Date(o.placedAt).toLocaleString()} · Rep ${rep?.name||o.repId}</div>
      <div class="grid-2">
        <div><b>Bill to</b><br>${esc(acc?.billingName||'')}<br>${esc(acc?.businessName||'')}<br>${esc(acc?.billingAddress||'')}<br>${esc(acc?.email||'')}</div>
        <div><b>From</b><br>${db.settings.company.name}<br>${db.settings.company.address}<br>${db.settings.company.website}</div>
      </div>
      <div class="table-wrap" style="margin-top:10px">
        <table>
          <tr><th>SKU</th><th>Item</th><th>Qty</th><th>Price</th><th>Line</th></tr>
          ${o.items.map(i=>`<tr><td>${i.sku}</td><td>${esc(i.name)}</td><td>${i.qty}</td><td>${fmt$(i.price)}</td><td>${fmt$(i.qty*i.price)}</td></tr>`).join('')}
        </table>
      </div>
      <div style="margin-top:10px">
        <div>Subtotal: ${fmt$(sub)}</div>
        ${o.discount?`<div>Discount (${o.promoCode}): -${fmt$(o.discount)}</div>`:''}
        <div>Shipping: ${fmt$(o.shipping)}</div>
        <div>Tax (${esc(o.taxLabel)}): ${fmt$(o.tax)}</div>
        <div style="font-size:18px;margin-top:4px"><b>Total: ${fmt$(o.total)}</b></div>
      </div>
      <div class="muted" style="font-size:12px;margin-top:8px">Payment: ${esc(o.payment.method)} ${o.payment.last4?'····'+esc(o.payment.last4):''} · E-sign: ${o.payment.esign?'on file':'n/a'}<br>Tracking will be emailed to ${esc(acc?.email||'the account')} when shipped.</div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="icon-btn primary" onclick="window.print()">Print / Save PDF</button>
        <button class="icon-btn" onclick="ui.closeModal()">Done</button>
      </div>
    `);
  }
};

/* ============ PROMOTIONS ============ */
const promos = {
  render(){
    const wrap = document.getElementById('promo-list');
    if(!db.promotions.length){ wrap.innerHTML='<div class="muted">No promotions.</div>'; return; }
    wrap.innerHTML = db.promotions.map(p=>`
      <div class="list-item">
        <div class="grow">
          <div class="title">${p.code} <span class="badge ${p.active?'ok':'err'}">${p.active?'active':'off'}</span> <span class="badge info">${p.kind}</span></div>
          <div class="meta">${esc(p.perks||'')} · min ${p.minQty||0} units${p.kind==='percent'?` · ${p.value}% off`:''}</div>
        </div>
        <button class="icon-btn" onclick="promos.open('${p.id}')">Edit</button>
      </div>
    `).join('');
  },
  openNew(){ promos.open(null) },
  open(id){
    const p = id ? db.promotions.find(x=>x.id===id) : null;
    const isNew = !p;
    const promo = p || {id:uid('P'), code:'', kind:'percent', value:10, perks:'', minQty:0, active:true};
    ui.modal(`
      <h3>${isNew?'New promotion':'Edit promotion'}</h3>
      <div class="grid-2">
        <div><label>Code</label><input id="p-code" value="${esc(promo.code)}"/></div>
        <div><label>Kind</label>
          <select id="p-kind">
            ${['percent','shipping','bonus','access'].map(k=>`<option ${promo.kind===k?'selected':''}>${k}</option>`).join('')}
          </select>
        </div>
        <div><label>Percent (if % off)</label><input id="p-val" type="number" step="0.1" value="${promo.value}"/></div>
        <div><label>Min units</label><input id="p-min" type="number" step="1" value="${promo.minQty||0}"/></div>
        <div style="grid-column:1/-1"><label>Perk description</label><input id="p-perk" value="${esc(promo.perks||'')}" placeholder="e.g. Free shipping, seminar access"/></div>
        <div><label>Status</label>
          <select id="p-act"><option value="true" ${promo.active?'selected':''}>Active</option><option value="false" ${!promo.active?'selected':''}>Inactive</option></select>
        </div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="icon-btn primary" onclick="promos.save('${promo.id}', ${isNew})">Save</button>
        ${!isNew?`<button class="icon-btn danger" onclick="promos.remove('${promo.id}')">Delete</button>`:''}
        <button class="icon-btn ghost" onclick="ui.closeModal()">Close</button>
      </div>
    `);
  },
  save(id, isNew){
    const get = i=>document.getElementById(i).value;
    let p = db.promotions.find(x=>x.id===id);
    if(!p){ p = {id}; db.promotions.push(p); }
    Object.assign(p, {
      code:get('p-code').trim().toUpperCase(),
      kind:get('p-kind'),
      value:parseFloat(get('p-val')||'0'),
      minQty:parseInt(get('p-min')||'0',10),
      perks:get('p-perk'),
      active:get('p-act')==='true'
    });
    save(); ui.closeModal(); promos.render();
  },
  remove(id){
    if(!confirm('Delete promotion?')) return;
    db.promotions = db.promotions.filter(p=>p.id!==id);
    save(); ui.closeModal(); promos.render();
  }
};

/* ============ REPORTS ============ */
const reports = {
  init(){
    document.getElementById('rep-from').value = startOfMonth();
    document.getElementById('rep-to').value = todayISO();
    const repSel = document.getElementById('rep-rep');
    repSel.innerHTML = '<option value="">All reps</option>' + db.reps.map(r=>`<option value="${r.id}">${r.name} (${r.id})</option>`).join('');
    if(!auth.isAdmin()){
      repSel.value = auth.repIdForUser(); repSel.disabled = true;
    } else repSel.disabled = false;
    const typeSel = document.getElementById('rep-type');
    typeSel.innerHTML = '<option value="">All</option>' + db.accountTypes.map(t=>`<option>${t}</option>`).join('');
    reports.run();
  },
  filter(){
    const from = document.getElementById('rep-from').value;
    const to   = document.getElementById('rep-to').value;
    const repId= document.getElementById('rep-rep').value;
    const acct = document.getElementById('rep-acct').value.trim().toUpperCase();
    const ord  = document.getElementById('rep-ord').value.trim().toUpperCase();
    const typ  = document.getElementById('rep-type').value;
    return db.orders.filter(o=>{
      if(o.status!=='finalized') return false;
      const d = o.placedAt.slice(0,10);
      if(from && d<from) return false;
      if(to && d>to) return false;
      if(repId && o.repId!==repId) return false;
      if(!auth.isAdmin() && o.repId!==auth.repIdForUser()) return false;
      if(ord && !o.orderNumber.toUpperCase().includes(ord)) return false;
      const a = db.accounts.find(x=>x.id===o.accountId);
      if(acct && !(a?.accountNumber||'').toUpperCase().includes(acct)) return false;
      if(typ && a?.type!==typ) return false;
      return true;
    });
  },
  run(){
    const list = reports.filter();
    const rev = list.reduce((s,o)=>s+o.total,0);
    const comm = orders.totalCommission(list);
    document.getElementById('rep-k-orders').textContent = list.length;
    document.getElementById('rep-k-rev').textContent = fmt$(rev);
    document.getElementById('rep-k-avg').textContent = fmt$(list.length?rev/list.length:0);
    document.getElementById('rep-k-comm').textContent = fmt$(comm);

    /* by account type */
    const grp = {};
    list.forEach(o=>{
      const a = db.accounts.find(x=>x.id===o.accountId);
      const t = a?.type || 'Unknown';
      grp[t] = grp[t] || {orders:0, units:0, rev:0};
      grp[t].orders++;
      grp[t].units += o.items.reduce((s,i)=>s+i.qty,0);
      grp[t].rev += o.total;
    });
    const rowsT = Object.entries(grp).map(([t,v])=>`<tr><td>${t}</td><td>${v.orders}</td><td>${v.units}</td><td>${fmt$(v.rev)}</td></tr>`).join('');
    document.getElementById('rep-bytype').innerHTML = rowsT ? `<table><tr><th>Type</th><th>Orders</th><th>Units</th><th>Revenue</th></tr>${rowsT}</table>` : '<div class="muted">No data.</div>';

    /* detail */
    const rows = list.sort((x,y)=>x.placedAt.localeCompare(y.placedAt)).map(o=>{
      const a = db.accounts.find(x=>x.id===o.accountId);
      return `<tr>
        <td class="nowrap">${o.placedAt.slice(0,10)}</td>
        <td>${o.orderNumber}</td>
        <td>${a?.accountNumber||''}</td>
        <td>${esc(a?.businessName||'')}</td>
        <td>${a?.type||''}</td>
        <td>${o.repId}</td>
        <td>${fmt$(o.total)}</td>
      </tr>`;
    }).join('');
    document.getElementById('rep-detail').innerHTML = rows ? `<table><tr><th>Date</th><th>Order</th><th>Account #</th><th>Account</th><th>Type</th><th>Rep</th><th>Total</th></tr>${rows}</table>` : '<div class="muted">No orders match.</div>';
  },
  exportCsv(){
    const list = reports.filter();
    const rows = [['Date','Order','AccountNumber','Account','Type','Rep','Subtotal','Discount','Shipping','Tax','Total','Commission']];
    list.forEach(o=>{
      const a = db.accounts.find(x=>x.id===o.accountId);
      const sub = o.items.reduce((s,i)=>s+i.qty*i.price,0);
      const repPct = (db.reps.find(r=>r.id===o.repId)?.commission||0)/100;
      const comm = (o.total-o.shipping-o.tax)*repPct;
      rows.push([o.placedAt.slice(0,10), o.orderNumber, a?.accountNumber||'', a?.businessName||'', a?.type||'', o.repId, sub.toFixed(2), o.discount.toFixed(2), o.shipping.toFixed(2), o.tax.toFixed(2), o.total.toFixed(2), comm.toFixed(2)]);
    });
    const csv = rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `reflectco-report-${todayISO()}.csv`; a.click();
    URL.revokeObjectURL(url);
  },
  monthly(){
    /* set last month and run */
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth()-1, 1);
    const last  = new Date(d.getFullYear(), d.getMonth(), 0);
    document.getElementById('rep-from').value = first.toISOString().slice(0,10);
    document.getElementById('rep-to').value   = last.toISOString().slice(0,10);
    reports.run();
    ui.toast('Last month loaded — export CSV to send commissions.');
  }
};

/* ============ CUSTOMER SERVICE (rule-based assistant) ============ */
const cs = {
  init(){
    document.getElementById('chat-log').innerHTML='';
    cs.bot("Hi! I can look up accounts, orders, promos, and tax rules. Try “orders for ACC-0001”, “promo BOGO48”, or “tax for license”.");
  },
  send(){
    const inp = document.getElementById('chat-in');
    const text = inp.value.trim(); if(!text) return;
    inp.value='';
    cs.user(text);
    cs.bot(cs.answer(text));
  },
  user(t){ cs.push('user', t) },
  bot(t){ cs.push('bot', t) },
  push(who,t){
    const log = document.getElementById('chat-log');
    const div = document.createElement('div');
    div.className = 'bubble '+who; div.textContent = t;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
  },
  answer(q){
    const s = q.toLowerCase();
    const accMatch = q.match(/ACC-\d{4}/i);
    const ordMatch = q.match(/ORD-\d+/i);
    const codeMatch = q.match(/[A-Z0-9]{4,}/);
    if(accMatch){
      const a = db.accounts.find(x=>x.accountNumber.toUpperCase()===accMatch[0].toUpperCase());
      if(!a) return 'No account with that number.';
      const last = db.orders.filter(o=>o.accountId===a.id).sort((x,y)=>y.placedAt.localeCompare(x.placedAt))[0];
      return `${a.businessName} (${a.type}) — rep ${a.repId}. Last order: ${last?last.orderNumber+' on '+last.placedAt.slice(0,10):'none yet'}.`;
    }
    if(ordMatch){
      const o = db.orders.find(x=>x.orderNumber.toUpperCase()===ordMatch[0].toUpperCase());
      if(!o) return 'No such order.';
      const a = db.accounts.find(x=>x.id===o.accountId);
      return `${o.orderNumber} for ${a?.businessName||'—'}: ${fmt$(o.total)} (${o.status}). Promo: ${o.promoCode||'none'}.`;
    }
    if(s.includes('promo') || s.includes('code')){
      if(codeMatch){
        const p = db.promotions.find(x=>x.code===codeMatch[0].toUpperCase());
        if(p) return `${p.code}: ${p.perks} (min ${p.minQty||0} units, ${p.active?'active':'off'}).`;
      }
      return 'Active codes: ' + db.promotions.filter(p=>p.active).map(p=>p.code).join(', ');
    }
    if(s.includes('tax')){
      return `Default tax is ${(db.settings.taxRateDefault*100).toFixed(2)}% (${db.settings.taxLabelDefault}). Accounts with a sales-tax license on file are not charged tax. For multi-state, recommend Shopify Tax / Avalara at order placement.`;
    }
    if(s.includes('ship')){
      return `Default shipping is ${fmt$(db.settings.shippingDefault)}. Some volume promos (e.g. FREESHIP24) waive it.`;
    }
    if(s.includes('reorder')||s.includes('due')){
      const due = accounts.scope(db.accounts).filter(a=>{
        const last = db.orders.filter(o=>o.accountId===a.id).sort((x,y)=>y.placedAt.localeCompare(x.placedAt))[0];
        if(!last) return false;
        return (Date.now()-new Date(last.placedAt))/86400000 >= db.settings.reorderDueDays;
      }).slice(0,5).map(a=>a.businessName||a.accountNumber);
      return due.length ? 'Due for reorder: '+due.join(', ') : 'No accounts are past the reorder threshold.';
    }
    if(s.includes('help')||s.includes('hello')||s.includes('hi')){
      return 'I can look up an account # (ACC-0001), an order # (ORD-1001), or a promo code. Ask about tax, shipping, or reorder due.';
    }
    return 'I’m a simple rule-based assistant here. A production AI (e.g. Claude API) would handle freeform questions.';
  }
};

/* ============ ADMIN ============ */
const adminPanel = {
  render(){
    /* reps */
    const wrap = document.getElementById('rep-list');
    wrap.innerHTML = db.reps.map(r=>`
      <div class="list-item">
        <div class="grow"><div class="title">${r.name} <span class="badge info">${r.id}</span></div>
          <div class="meta">${r.email} · commission ${r.commission}% · territory ${(r.territory||[]).join(', ')||'—'}</div>
        </div>
        <button class="icon-btn" onclick="adminPanel.editRep('${r.id}')">Edit</button>
        <button class="icon-btn danger" onclick="adminPanel.removeRep('${r.id}')">✕</button>
      </div>`).join('');

    /* types */
    document.getElementById('type-list').innerHTML =
      db.accountTypes.map(t=>`<span class="badge info" style="padding:6px 10px">${t} <a href="#" onclick="adminPanel.removeType('${t}');return false" style="margin-left:6px;color:#fecaca">✕</a></span>`).join('');

    /* settings */
    document.getElementById('set-ship').value = db.settings.shippingDefault;
    document.getElementById('set-tax').value  = db.settings.taxRateDefault;
    document.getElementById('set-taxlbl').value = db.settings.taxLabelDefault;
    document.getElementById('set-disc').value = db.settings.highDiscountAlertPct;
    document.getElementById('set-reorder').value = db.settings.reorderDueDays;
    document.getElementById('set-stock').value = db.settings.lowStockThreshold;
  },
  addRep(){
    const name = document.getElementById('new-rep-name').value.trim();
    const email = document.getElementById('new-rep-email').value.trim();
    const commission = parseFloat(document.getElementById('new-rep-commission').value||'10');
    if(!name||!email) return ui.toast('Name and email required');
    const id = 'R-' + String(db.reps.length+1).padStart(3,'0');
    db.reps.push({id, name, email, commission, territory:[]});
    db.users.push({id:uid('u'), name, email, pass:'rep', role:'rep', repId:id, commission, territory:[]});
    save(); adminPanel.render(); ui.toast('Rep added (password: rep)');
  },
  editRep(id){
    const r = db.reps.find(x=>x.id===id); if(!r) return;
    const name = prompt('Name', r.name); if(name===null) return;
    const email = prompt('Email', r.email); if(email===null) return;
    const comm = prompt('Commission %', r.commission); if(comm===null) return;
    const terr = prompt('Territory ZIPs (comma sep)', (r.territory||[]).join(',')); if(terr===null) return;
    Object.assign(r, {name, email, commission:parseFloat(comm)||0, territory:terr.split(',').map(x=>x.trim()).filter(Boolean)});
    /* sync user */
    const u = db.users.find(u=>u.repId===id); if(u){ u.name=name; u.email=email; u.commission=r.commission; u.territory=r.territory; }
    save(); adminPanel.render();
  },
  removeRep(id){
    if(!confirm('Remove rep '+id+'?')) return;
    db.reps = db.reps.filter(r=>r.id!==id);
    db.users = db.users.filter(u=>u.repId!==id);
    save(); adminPanel.render();
  },
  addType(){
    const t = document.getElementById('new-type').value.trim();
    if(!t) return;
    if(!db.accountTypes.includes(t)) db.accountTypes.push(t);
    document.getElementById('new-type').value='';
    save(); adminPanel.render();
  },
  removeType(t){
    db.accountTypes = db.accountTypes.filter(x=>x!==t);
    save(); adminPanel.render();
  },
  saveSettings(){
    db.settings.shippingDefault = parseFloat(document.getElementById('set-ship').value||'0');
    db.settings.taxRateDefault  = parseFloat(document.getElementById('set-tax').value||'0');
    db.settings.taxLabelDefault = document.getElementById('set-taxlbl').value;
    db.settings.highDiscountAlertPct = parseFloat(document.getElementById('set-disc').value||'0');
    db.settings.reorderDueDays = parseInt(document.getElementById('set-reorder').value||'0',10);
    db.settings.lowStockThreshold = parseInt(document.getElementById('set-stock').value||'0',10);
    save(); ui.toast('Settings saved');
  }
};

/* ============ UTIL ============ */
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }

/* ============ BOOT ============ */
function boot(){
  if(!db.session){
    document.getElementById('auth').classList.remove('hide');
    document.getElementById('app').classList.add('hide');
    return;
  }
  document.getElementById('auth').classList.add('hide');
  document.getElementById('app').classList.remove('hide');
  document.querySelectorAll('.admin-only').forEach(el=>el.classList.toggle('hide', !auth.isAdmin()));
  /* promos tab is admin */
  const navPromos = document.querySelector('[data-view="admin"]');
  /* always show admin tab only when admin */
  nav.go('dashboard');
}
boot();
