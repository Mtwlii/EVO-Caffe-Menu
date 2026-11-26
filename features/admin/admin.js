// Admin dashboard (white-label): edit prices, mark out-of-stock, hide items.
// Reads the live menu page as the item source, reads/writes overrides in Supabase.
// Auth: Supabase email/password. Only a signed-in admin can write (RLS).
(function () {
  var cfg = window.EVO_DATA || {};
  var $ = function (id) { return document.getElementById(id); };
  if (!cfg.url || !cfg.anonKey) { $('configMsg').hidden = false; return; }
  var base = cfg.url.replace(/\/$/, '');

  // ---------- white-label config (table app_settings, key 'config') ----------
  var DEFAULTS = { brand: { name: 'Cafe', logo_url: '' }, theme: {}, dir: 'rtl', currency: 'جنيه',
    receipt: { subtitle: 'إيصال', footer: 'شكراً لزيارتكم', extra: '', logo: false, logo_img: '' },
    room_types: [{ id: 'ps4', label: 'PS4' }, { id: 'ps5', label: 'PS5' }], shifts: [], labels: '', reprice: true, tiers: { '2': 'فردي', '4': 'زوجي' } };
  var CFG = JSON.parse(JSON.stringify(DEFAULTS));
  var SWAP = [];   // [[from, to]] phrase overrides: currency + custom labels
  function mergeCfg(v) {
    v = v || {};
    CFG = { brand: Object.assign({}, DEFAULTS.brand, v.brand), theme: Object.assign({}, v.theme), dir: v.dir === 'ltr' ? 'ltr' : 'rtl',
      currency: v.currency || DEFAULTS.currency, receipt: Object.assign({}, DEFAULTS.receipt, v.receipt), rcWidth: (v.receipt && Number(v.receipt.width) === 58) ? 58 : 80,
      room_types: (v.room_types && v.room_types.length) ? v.room_types : DEFAULTS.room_types,
      shifts: v.shifts || [], labels: v.labels || '', reprice: v.reprice_elapsed !== false, expenseCap: v.expense_cap != null ? Number(v.expense_cap) : 500, tz: v.tz || 'Africa/Cairo', dayStart: v.day_start_hour != null ? Number(v.day_start_hour) : 6, tiers: Object.assign({ '2': 'فردي', '4': 'زوجي' }, v.tiers), perms: Object.assign({}, v.cashier_perms) };
  }
  var PERMS = [['start', 'بدء جلسة'], ['pause', 'إيقاف مؤقت / استكمال'], ['tier', 'تحويل فردي/زوجي'], ['vip', 'تفعيل/إلغاء VIP'], ['void', 'إلغاء صنف (بسبب)'],
    ['add_items', 'إضافة أصناف للجلسة'], ['deposit', 'تسجيل مقدم'], ['carry_over', 'نقل للوردية الجاية'], ['close', 'إنهاء وتحصيل الجلسة'], ['shift', 'فتح/قفل الوردية'], ['attendance', 'تسجيل حضور/انصراف'], ['expense', 'تسجيل مصروف'], ['advance', 'تسجيل سلفة (افتراضي: مقفول)'], ['stock_move', 'وارد/صادر/هالك مخزون'], ['stock_count', 'جرد المخزون'], ['sale', 'بيع تيك أواي/ترابيزة']];
  function can(p) { return ROLE === 'admin' || (p === 'advance' ? (CFG.perms || {})[p] === true : (CFG.perms || {})[p] !== false); }
  function gate(node, p) { if (!can(p)) { node.disabled = true; node.title = 'الأدمن قفل الصلاحية دي'; node.classList.add('perm-off'); } return node; }
  function typeLabel(id) { var t = CFG.room_types.find(function (x) { return x.id === id; }); return t ? t.label : id; }
  function tierLabel(c) { return (CFG.tiers && CFG.tiers[c]) || String(c); }
  function rkey(t, c, vip) { return t + '|' + c + (vip ? '|v' : ''); }
  function typeIds() { return CFG.room_types.map(function (t) { return t.id; }); }
  function swapText(t) { for (var i = 0; i < SWAP.length; i++) if (t.indexOf(SWAP[i][0]) >= 0) t = t.split(SWAP[i][0]).join(SWAP[i][1]); return t; }
  var done = new WeakSet(), obs = null;
  function swapNode(root) {
    if (!SWAP.length) return;
    if (obs) obs.disconnect();
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n, list = [];
    while ((n = w.nextNode())) list.push(n);
    list.forEach(function (t) { if (done.has(t)) return; var v = swapText(t.nodeValue); if (v !== t.nodeValue) t.nodeValue = v; done.add(t); });
    if (root.querySelectorAll) root.querySelectorAll('[placeholder]').forEach(function (e) {
      if (e.dataset.sw) return; e.dataset.sw = '1'; e.setAttribute('placeholder', swapText(e.getAttribute('placeholder')));
    });
    if (obs) obs.observe(document.body, { childList: true, subtree: true });
  }
  function applyCfg() {
    var r = document.documentElement.style, th = CFG.theme || {};
    [['primary', '--a-cyan'], ['accent', '--a-accent'], ['bg', '--a-bg'], ['surface', '--a-surface'], ['text', '--a-text']].forEach(function (p) {
      if (/^#[0-9a-f]{6}$/i.test(th[p[0]] || '')) r.setProperty(p[1], th[p[0]]); else r.removeProperty(p[1]);
    });
    document.documentElement.dir = CFG.dir; document.documentElement.setAttribute('data-dir', CFG.dir);
    document.title = CFG.brand.name;
    var meta = document.querySelector('meta[name=theme-color]'); if (meta && th.bg) meta.setAttribute('content', th.bg);
    var bn = $('brandName'); if (bn) bn.textContent = CFG.brand.name;
    var lg = $('brandLogo'), svg = $('brandSvg');
    if (lg && svg) { var ok = /^https:\/\//.test(CFG.brand.logo_url || ''); lg.hidden = !ok; svg.hidden = ok; if (ok) lg.src = CFG.brand.logo_url; }
    SWAP = [];
    String(CFG.labels || '').split('\n').forEach(function (l) { var i = l.indexOf('=>'); if (i > 0) SWAP.push([l.slice(0, i).trim(), l.slice(i + 2).trim()]); });
    if (CFG.currency && CFG.currency !== 'جنيه') SWAP.push(['جنيه', CFG.currency]);
    SWAP = SWAP.filter(function (x) { return x[0]; });
    swapNode(document.body);
  }
  function loadCfg() {
    return fetch(base + '/rest/v1/app_settings?key=eq.config&select=value', { headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey } })
      .then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) { mergeCfg(rows[0] && rows[0].value); applyCfg(); })
      .catch(function () { mergeCfg(null); applyCfg(); });
  }
  obs = new MutationObserver(function () { swapNode(document.body); });
  obs.observe(document.body, { childList: true, subtree: true });

  // ---------- session ----------
  var SES_KEY = 'evo-admin-session';
  var ses = null;
  try { ses = JSON.parse(localStorage.getItem(SES_KEY) || 'null'); } catch (e) {}

  function saveSes(s) { ses = s; try { localStorage.setItem(SES_KEY, JSON.stringify(s)); } catch (e) {} }
  function clearSes() { ses = null; try { localStorage.removeItem(SES_KEY); } catch (e) {} }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ apikey: cfg.anonKey, 'content-type': 'application/json' }, opts.headers || {});
    if (ses && ses.access_token) opts.headers.authorization = 'Bearer ' + ses.access_token;
    return fetch(base + path, opts).catch(function (e) { setOffline(true); e.offline = true; throw e; }).then(function (r) {
      if (OFFLINE) setOffline(false);
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.message || j.error_description || j.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  // ---------- offline resilience ----------
  var OFFLINE = false, pingT = null, Q_KEY = 'evo-queue', C_KEY = 'evo-rooms-cache';
  function getQ() { try { return JSON.parse(localStorage.getItem(Q_KEY) || '[]'); } catch (e) { return []; } }
  function setQ(q) { try { localStorage.setItem(Q_KEY, JSON.stringify(q)); } catch (e) {} paintBanner(); }
  function uid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); }
  function getConf() { try { return JSON.parse(localStorage.getItem('evo-conflicts') || '[]'); } catch (e) { return []; } }
  function paintBanner() {
    var b = $('offBanner'); if (!b) return; var n = getQ().length, cf = getConf().length;
    b.hidden = !OFFLINE && !n && !cf;
    b.querySelector('.ob-t').textContent = OFFLINE
      ? 'مفيش نت. الشغل شغال من البيانات المحفوظة' + (n ? ' · ' + n + ' عملية مستنية تتسجّل' : '') + '. الوقت والحساب بيكملوا لوحدهم.'
      : n ? n + ' عملية اتعملت أوفلاين وبتتسجّل دلوقتي...' : '';
    var old = b.querySelector('.ob-c'); if (old) old.remove();
    if (cf) {
      var bt = el('button', 'btn small warn ob-c', cf + ' عملية اتعارضت. اضغط للمراجعة');
      bt.onclick = function () {
        billModal('عمليات مش اتسجلت (تعارض)', getConf().map(function (c) { return [stamp(new Date(c.at)) + ' · ' + c.what, c.err, 'sub']; }), (function () {
          var cl = el('button', 'btn ghost', 'مسح القائمة'); cl.onclick = function () { localStorage.removeItem('evo-conflicts'); document.querySelectorAll('.bill-ov').forEach(function (o) { o.remove(); }); paintBanner(); }; return cl; })());
      };
      b.appendChild(bt);
    }
  }
  // items shown on a room card: server items + queued (not yet synced) adds, with queued voids applied
  function overlayQ(items) {
    var q = getQ(), out = (items || []).slice();
    q.forEach(function (it) {
      if (it.type === 'add') out.push({ id: 'q' + it.op, op: it.op, pending: true, session_id: it.session_id, name: it.name, price: it.price, qty: it.qty, source: 'manual' });
    });
    q.forEach(function (it) {
      if (it.type !== 'void') return;
      out.forEach(function (x) { if ((it.item_id && x.id === it.item_id) || (it.target_op && x.op === it.target_op)) { x.voided_at = new Date(it.at).toISOString(); x.void_reason = it.reason; } });
    });
    return out;
  }
  function qWhat(it) {
    var t = it.type || 'close';
    return t === 'close' ? 'إنهاء حساب ' + it.room : t === 'add' ? 'إضافة ' + it.name : t === 'void' ? 'إلغاء صنف' : t === 'expense' ? 'مصروف ' + it.amount : 'بيع ' + (it.total || '');
  }
  function qCall(it) {
    var t = it.type || 'close', P = function (fn, b) { return api('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(b) }); };
    if (t === 'close') return P('close_room_session', it.body);
    if (t === 'add') return P('add_session_item', { p_op: it.op, p_session: it.session_id, p_name: it.name, p_price: it.price, p_qty: it.qty });
    if (t === 'void') return P('void_item', { p_op: it.op, p_item_id: it.item_id || null, p_target_op: it.target_op || null, p_reason: it.reason });
    if (t === 'expense') return P('log_expense', { p_amount: it.amount, p_reason: it.reason, p_op: it.op });
    return P('create_sale', it.body);
  }
  function enqueue(it) { it.at = it.at || Date.now(); var q = getQ(); q.push(it); setQ(q); }
  function setOffline(v) {
    if (v === OFFLINE) return; OFFLINE = v; paintBanner();
    clearInterval(pingT);
    if (v) pingT = setInterval(function () { fetch(base + '/auth/v1/health', { headers: { apikey: cfg.anonKey } }).then(function () { setOffline(false); }).catch(function () {}); }, 8000);
    else { flushQ(); }
  }
  window.addEventListener('offline', function () { setOffline(true); });
  window.addEventListener('online', function () { fetch(base + '/auth/v1/health', { headers: { apikey: cfg.anonKey } }).then(function () { setOffline(false); }).catch(function () {}); });
  var flushing = false;
  function flushQ() {
    if (flushing) return; var q = getQ(); if (!q.length || OFFLINE) { paintBanner(); return; }
    flushing = true;
    (function next() {
      q = getQ(); if (!q.length) { flushing = false; paintBanner(); var rt = $('roomsTab'); if (rt && !rt.hidden) bootRooms(); return; }
      var it = q[0];
      withAuth(function () { return qCall(it); })
        .then(function (rep) {
          setQ(getQ().slice(1));
          if ((it.type || 'close') === 'close') toast(rep.total === it.local_total ? 'اتسجّل حساب ' + it.room + ': ' + rep.total + ' جنيه' : 'اتسجّل حساب ' + it.room + ' بإجمالي ' + rep.total + ' (على الجهاز كان ' + it.local_total + ')', rep.total !== it.local_total);
          next();
        })
        .catch(function (e) {
          if (e.offline) { flushing = false; return; }
          // the server refused (session closed elsewhere, shift closed, permission off...): keep a visible record, never retry forever
          setQ(getQ().slice(1)); var c = getConf();
          c.push({ what: qWhat(it), err: e.message, at: it.at || Date.now() }); try { localStorage.setItem('evo-conflicts', JSON.stringify(c.slice(-30))); } catch (x) {}
          toast('تعارض: ' + qWhat(it) + ' · ' + e.message, true); paintBanner(); next();
        });
    })();
  }
  function manualSummary() {
    var c = null; try { c = JSON.parse(localStorage.getItem(C_KEY) || 'null'); } catch (e) {}
    var lines = [];
    if (!c) lines.push(['مفيش بيانات محفوظة على الجهاز', '']);
    else {
      var p = c.p, rooms = p[0] || [], open = p[1] || [], segs = p[5] || [], items = p[6] || [];
      lines.push(['آخر تحديث', stamp(new Date(c.t)), 'sub']);
      var queued = getQ().map(function (x) { return x.body.p_session_id; });
      open.filter(function (x) { return queued.indexOf(x.id) < 0; }).forEach(function (ses) {
        var r = rooms.find(function (x) { return x.id === ses.room_id; }) || { name: '?' };
        var ss = segs.filter(function (g) { return g.session_id === ses.id; }), its = items.filter(function (x) { return x.session_id === ses.id && !x.voided_at; });
        var ms = ss.reduce(function (a, g) { return a + (g.ended_at ? new Date(g.ended_at).getTime() : Date.now()) - new Date(g.started_at).getTime(); }, 0);
        var cost = Math.round(timeCostOf(ss, ses.room_type || r.room_type) + itemsCostOf(its));
        lines.push([r.name + ' · بدأت ' + stamp(new Date(ses.started_at)) + ' · ' + Math.round(ms / 60000) + ' د', cost + ' جنيه']);
        its.forEach(function (x) { lines.push(['   ' + x.qty + ' × ' + x.name, (x.qty * x.price) + ' جنيه', 'sub']); });
        if (ses.deposit_amount) lines.push(['   مقدم مدفوع', ses.deposit_amount + ' جنيه', 'sub']);
      });
      if (!open.length) lines.push(['مفيش جلسات مفتوحة', '']);
    }
    getQ().forEach(function (it) { lines.push(['مقفول أوفلاين: ' + it.room + ' · ' + stamp(new Date(it.at)), it.local_total + ' جنيه']); });
    billModal('ملخص يدوي (من الجهاز)', lines);
  }
  function refreshSes() {
    if (!ses || !ses.refresh_token) return Promise.reject(new Error('no session'));
    return api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: ses.refresh_token }) })
      .then(function (j) { saveSes(j); return j; });
  }
  function withAuth(fn) { // retry once with a refreshed token on 401
    return fn().catch(function (e) {
      if (e.status !== 401) throw e;
      return refreshSes().then(fn);
    });
  }

  // ---------- login ----------
  function show(view) {
    $('loginView').hidden = view !== 'login';
    $('itemsView').hidden = view !== 'items';
    $('logout').hidden = view !== 'items';
  }
  var ROLE = null;
  var STAFF_DOMAIN = '@staff.evo.invalid';
  function toLogin(v) { v = v.trim(); return v.indexOf('@') < 0 ? v.toLowerCase() + STAFF_DOMAIN : v; }
  $('loginBtn').onclick = function () {
    var btn = $('loginBtn'); btn.disabled = true; $('loginErr').hidden = true;
    api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: toLogin($('email').value), password: $('password').value })
    }).then(function (j) { saveSes(j); boot(); })
      .catch(function (e) { $('loginErr').textContent = 'دخول فاشل: ' + e.message; $('loginErr').hidden = false; })
      .then(function () { btn.disabled = false; });
  };
  $('logout').onclick = function () { clearSes(); ROLE = null; document.body.classList.remove('role-staff', 'role-admin'); show('login'); };

  // ---------- menu source: parse the live menu page ----------
  function keyOf(name, prices) { return name + '|' + prices.join('/'); }
  function digits(s) { return (String(s).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).match(/\d+/g) || []).map(Number); }
  function norm(t) { return t.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase().trim(); }

  function loadMenu() {
    return Promise.all([
      withAuth(function () { return api('/rest/v1/menu_categories?select=*&order=sort'); }),
      withAuth(function () { return api('/rest/v1/menu_items?select=*&order=sort&limit=2000'); })
    ]).then(function (p) { return { cats: p[0] || [], items: p[1] || [] }; });
  }
  function loadOverrides() { return Promise.resolve({}); }

  // ---------- render ----------
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var tm;
  function toast(t, bad) {
    var x = $('toast'); x.textContent = t; x.className = 'toast' + (bad ? ' bad' : ''); x.hidden = false;
    clearTimeout(tm); tm = setTimeout(function () { x.hidden = true; }, 2200);
  }

  var lastGroups = [], lastOverrides = {}, MENU = { cats: [], items: [] };
  function mPatch(table, id, body) {
    return withAuth(function () { return api('/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(body) }); });
  }
  function mReload() { return loadMenu().then(function (m) { render(m, {}); }); }
  function parsePrices(t) { return digits(t).filter(function (n) { return n > 0 && n <= 2000; }).slice(0, 4); }
  function swapSort(table, a, b) {
    return Promise.all([mPatch(table, a.id, { sort: b.sort }), mPatch(table, b.id, { sort: a.sort })]).then(mReload);
  }
  function render(m) {
    MENU = m;
    lastGroups = m.cats.map(function (c) {
      return { id: c.id, title: c.name_ar, items: m.items.filter(function (i) { return i.category_id === c.id && !i.hidden && i.kind !== 'sub' && i.prices.length; })
        .map(function (i) { return { name: i.name, prices: i.prices, key: i.name + '|' + i.prices.join('/') }; }) };
    }).filter(function (g) { return g.items.length; });
    lastOverrides = {};
    var host = $('groups'); host.textContent = '';
    var n = 0;
    // add category
    var addC = el('div', 'row'); addC.appendChild(el('div', 'name', 'إضافة قسم جديد'));
    var cId = el('input', 'm-in'); cId.placeholder = 'كود (انجليزي: shisha)'; cId.dir = 'ltr';
    var cAr = el('input', 'm-in'); cAr.placeholder = 'الاسم بالعربي';
    var cEn = el('input', 'm-in'); cEn.placeholder = 'الاسم بالانجليزي (اختياري)'; cEn.dir = 'ltr';
    var cBtn = el('button', 'btn small', 'إضافة القسم');
    cBtn.onclick = function () {
      var id = cId.value.trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,40}$/.test(id) || !cAr.value.trim()) { toast('كود إنجليزي (حروف وأرقام) واسم عربي مطلوبين', true); return; }
      var mx = m.cats.reduce(function (a, c) { return Math.max(a, c.sort); }, 0) + 10;
      withAuth(function () { return api('/rest/v1/menu_categories', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ id: id, name_ar: cAr.value.trim(), name_en: cEn.value.trim(), sort: mx }) }); })
        .then(function () { toast('اتضاف القسم'); return mReload(); }).catch(function (e) { toast('فشل: ' + e.message, true); });
    };
    addC.append(cId, cAr, cEn, cBtn); host.appendChild(addC);
    m.cats.forEach(function (c, ci) {
      var box = el('div', 'group'); var h = el('h3', null, c.name_ar + (c.hidden ? ' (مخفي)' : '')); box.appendChild(h);
      var ch = el('div', 'row');
      var nAr = el('input', 'm-in'); nAr.value = c.name_ar; nAr.setAttribute('aria-label', 'اسم القسم');
      var nEn = el('input', 'm-in'); nEn.value = c.name_en; nEn.dir = 'ltr';
      var nNav = el('input', 'm-in'); nNav.value = c.nav_ar || ''; nNav.placeholder = 'اسم التبويب (اختياري)';
      var hidL = el('label', 'chk'), hid = el('input'); hid.type = 'checkbox'; hid.checked = !!c.hidden; hidL.append(hid, document.createTextNode('مخفي'));
      var sv = el('button', 'btn small', 'حفظ القسم');
      sv.onclick = function () { mPatch('menu_categories', c.id, { name_ar: nAr.value.trim() || c.name_ar, name_en: nEn.value.trim(), nav_ar: nNav.value.trim(), hidden: hid.checked }).then(function () { toast('اتحفظ القسم'); return mReload(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
      var up = el('button', 'btn small ghost', '↑'), dn = el('button', 'btn small ghost', '↓');
      up.onclick = function () { if (ci > 0) swapSort('menu_categories', c, m.cats[ci - 1]); }; 
      dn.onclick = function () { if (ci < m.cats.length - 1) swapSort('menu_categories', c, m.cats[ci + 1]); };
      var del = el('button', 'btn small ghost danger', 'حذف القسم');
      del.onclick = function () {
        if (!confirm('حذف قسم "' + c.name_ar + '" وكل أصنافه؟')) return;
        withAuth(function () { return api('/rest/v1/menu_categories?id=eq.' + encodeURIComponent(c.id), { method: 'DELETE', headers: { prefer: 'return=minimal' } }); })
          .then(function () { toast('اتحذف القسم'); return mReload(); }).catch(function (e) { toast('فشل: ' + e.message, true); });
      };
      ch.append(nAr, nNav, nEn, hidL, sv, up, dn, del); box.appendChild(ch);
      var rows = m.items.filter(function (i) { return i.category_id === c.id; });
      rows.forEach(function (it, ri) {
        n++;
        var row = el('div', 'row' + (it.out_of_stock ? ' oos' : '')); row.dataset.name = norm(it.name);
        if (it.kind === 'sub') row.appendChild(el('div', 'cur', 'عنوان فرعي'));
        if (it.kind === 'extra') row.appendChild(el('div', 'cur', 'إضافة'));
        var nm = el('input', 'm-in'); nm.value = it.name; nm.setAttribute('aria-label', 'اسم الصنف');
        var ds = el('input', 'm-in'); ds.value = it.descr; ds.placeholder = 'وصف (اختياري)';
        var pr = el('input', 'price-in'); pr.value = it.prices.join('/'); pr.placeholder = '30/40'; pr.dir = 'ltr'; pr.setAttribute('aria-label', 'السعر');
        var im = el('input', 'm-in'); im.value = it.image_url; im.placeholder = 'رابط صورة https (اختياري)'; im.dir = 'ltr';
        row.appendChild(nm);
        if (it.kind !== 'sub') row.append(pr, ds, im);
        var oos, hi;
        function chk(label, v) { var L = el('label', 'chk'), i = el('input'); i.type = 'checkbox'; i.checked = !!v; L.append(i, document.createTextNode(label)); row.appendChild(L); return i; }
        if (it.kind !== 'sub') oos = chk('خلصان', it.out_of_stock);
        var hd = chk('مخفي', it.hidden);
        if (it.kind === 'item') hi = chk('مميز', it.highlight);
        var save = el('button', 'btn small', 'حفظ');
        save.onclick = function () {
          var ps = it.kind === 'sub' ? [] : parsePrices(pr.value);
          if (it.kind !== 'sub' && !ps.length) { toast('السعر لازم بين 1 و 2000', true); return; }
          if (!nm.value.trim()) { toast('الاسم مطلوب', true); return; }
          if (it.kind !== 'sub' && im.value.trim() && !/^https:\/\//.test(im.value.trim())) { toast('رابط الصورة لازم https', true); return; }
          save.disabled = true;
          mPatch('menu_items', it.id, { name: nm.value.trim(), descr: it.kind === 'sub' ? '' : ds.value.trim(), prices: ps, image_url: it.kind === 'sub' ? '' : im.value.trim(),
            hidden: hd.checked, out_of_stock: oos ? oos.checked : false, highlight: hi ? hi.checked : false, updated_at: new Date().toISOString() })
            .then(function () { toast('اتحفظ: ' + nm.value.trim()); return mReload(); }).catch(function (e) { toast('فشل الحفظ: ' + e.message, true); save.disabled = false; });
        };
        var u = el('button', 'btn small ghost', '↑'), d = el('button', 'btn small ghost', '↓');
        u.onclick = function () { if (ri > 0) swapSort('menu_items', it, rows[ri - 1]); };
        d.onclick = function () { if (ri < rows.length - 1) swapSort('menu_items', it, rows[ri + 1]); };
        var x = el('button', 'btn small ghost danger', 'حذف');
        x.onclick = function () {
          if (!confirm('حذف "' + it.name + '"؟')) return;
          withAuth(function () { return api('/rest/v1/menu_items?id=eq.' + it.id, { method: 'DELETE', headers: { prefer: 'return=minimal' } }); })
            .then(function () { toast('اتحذف'); return mReload(); }).catch(function (e) { toast('فشل: ' + e.message, true); });
        };
        row.append(save, u, d, x); box.appendChild(row);
      });
      var add = el('div', 'row'); add.appendChild(el('div', 'cur', 'صنف جديد في ' + c.name_ar));
      var aN = el('input', 'm-in'); aN.placeholder = 'اسم الصنف';
      var aP = el('input', 'price-in'); aP.placeholder = '30/40'; aP.dir = 'ltr';
      var aK = el('select', 'mini-s'); [['item', 'صنف'], ['extra', 'إضافة'], ['sub', 'عنوان فرعي']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; aK.appendChild(op); });
      var aB = el('button', 'btn small', 'إضافة');
      aB.onclick = function () {
        var ps = aK.value === 'sub' ? [] : parsePrices(aP.value);
        if (!aN.value.trim() || (aK.value !== 'sub' && !ps.length)) { toast('الاسم والسعر مطلوبين', true); return; }
        var mx = rows.reduce(function (a, r) { return Math.max(a, r.sort); }, 0) + 10;
        aB.disabled = true;
        withAuth(function () { return api('/rest/v1/menu_items', { method: 'POST', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ category_id: c.id, kind: aK.value, name: aN.value.trim(), prices: ps, sort: mx }) }); })
          .then(function () { toast('اتضاف: ' + aN.value.trim()); return mReload(); }).catch(function (e) { toast('فشل: ' + e.message, true); aB.disabled = false; });
      };
      add.append(aN, aP, aK, aB); box.appendChild(add);
      host.appendChild(box);
    });
    $('count').textContent = n + ' صنف';
  }

  // ---------- search ----------
  $('q').addEventListener('input', function () {
    var v = norm($('q').value);
    document.querySelectorAll('#groups .row').forEach(function (r) {
      r.classList.toggle('is-hidden', !!v && r.dataset.name.indexOf(v) === -1);
    });
  });

  // ---------- rooms v2: PS4/PS5 types, controller rates, session items, shifts ----------
  var roomTimers = [];
  function clearTimers() { roomTimers.forEach(clearInterval); roomTimers = []; }
  function fmtDur(ms) {
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return (h ? h + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
  }
  
  var RATES = {};

  function billModal(title, lines, extraBtn) {
    var ov = el('div', 'bill-ov');
    var box = el('div', 'bill-box');
    box.appendChild(el('h3', null, title));
    lines.forEach(function (ln) {
      if (ln[2] === 'sub') { box.appendChild(el('div', 'bill-sub', ln[0])); return; }
      var row = el('div', 'bill-row' + (ln[2] === 'total' ? ' total' : ''));
      row.append(el('span', null, ln[0]), el('span', null, ln[1]));
      box.appendChild(row);
    });
    if (extraBtn) box.appendChild(extraBtn);
    var ok = el('button', 'btn', 'تم');
    ok.onclick = function () { ov.remove(); };
    box.appendChild(ok); ov.appendChild(box); document.body.appendChild(ov);
  }

  // ---------- receipt (80mm thermal printer, via the browser print dialog) ----------
  // data: { place, meta:[[k,v]], lines:[[text, amount]], totals:[[label, value, 'total'?]] }
  function showReceipt(data) {
    var ov = el('div', 'bill-ov'), box = el('div', 'bill-box receipt-box');
    var paper = el('div', 'receipt-paper' + (CFG.rcWidth === 58 ? ' w58' : ''));
    if (CFG.receipt.logo && /^data:image\/png;base64,/.test(CFG.receipt.logo_img || '')) { var lg = el('img', 'rc-logo'); lg.alt = ''; lg.src = CFG.receipt.logo_img; paper.appendChild(lg); }
    paper.appendChild(el('div', 'rc-brand', CFG.brand.name));
    paper.appendChild(el('div', 'rc-sub', CFG.receipt.subtitle));
    if (CFG.receipt.extra) paper.appendChild(el('div', 'rc-sub', CFG.receipt.extra));
    paper.appendChild(el('div', 'rc-place', data.place));
    (data.meta || []).forEach(function (m) { var r = el('div', 'rc-row'); r.append(el('span', null, m[0]), el('span', null, m[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    (data.lines || []).forEach(function (l) { var r = el('div', 'rc-row' + (l[2] === 'sub' ? ' rc-subline' : '')); r.append(el('span', null, l[0]), el('span', null, l[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    (data.totals || []).forEach(function (l) { var r = el('div', 'rc-row' + (l[2] === 'total' ? ' rc-total' : '')); r.append(el('span', null, l[0]), el('span', null, l[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    paper.appendChild(el('div', 'rc-thanks', CFG.receipt.footer));
    box.appendChild(paper);
    var pr = el('button', 'btn', 'اطبع الإيصال');
    pr.onclick = function () { document.body.classList.add('print-receipt'); window.print(); document.body.classList.remove('print-receipt'); };
    var ok = el('button', 'btn ghost', 'تم'); ok.onclick = function () { ov.remove(); };
    box.append(pr, ok); ov.appendChild(box); document.body.appendChild(ov);
  }
  function stamp(d) {
    d = d || new Date();
    return d.toLocaleDateString('ar-EG') + ' ' + d.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
  }

  function loadRooms() {
    return withAuth(function () {
      return Promise.all([
        api('/rest/v1/rooms?active=eq.true&order=sort'),
        api('/rest/v1/room_sessions?ended_at=is.null&select=*'),
        api('/rest/v1/room_rates?select=*'),
        api('/rest/v1/shifts?closed_at=is.null&select=*&limit=1'),
        api('/rest/v1/shifts?closed_at=not.is.null&select=*&order=id.desc&limit=5')
      ]);
    }).then(function (p) {
      var open = p[1] || [];
      if (!open.length) { p = p.concat([[], []]); try { localStorage.setItem(C_KEY, JSON.stringify({ t: Date.now(), p: p })); } catch (e) {} return p; }
      var ids = open.map(function (x) { return x.id; }).join(',');
      return withAuth(function () {
        return Promise.all([
          api('/rest/v1/room_session_segments?session_id=in.(' + ids + ')&select=*'),
          api('/rest/v1/session_items?session_id=in.(' + ids + ')&select=*&order=id')
        ]);
      }).then(function (extra) { p = p.concat(extra); try { localStorage.setItem(C_KEY, JSON.stringify({ t: Date.now(), p: p })); } catch (e) {} return p; });
    });
  }

  // same algorithm as session_time_cost in the DB: newest to oldest; a segment is billed at the next
  // segment's controllers/vip when that change repriced the past (reprices_prior), else at its own
  function timeCostOf(segs, type, until) {
    var cost = 0, ec = null, ev = false, prevRp = false, list = (segs || []).slice().sort(function (a, b) { return b.id - a.id; });
    list.forEach(function (g, i) {
      if (i === 0 || !prevRp) { ec = g.controllers; ev = !!g.vip; }
      var end = g.ended_at ? new Date(g.ended_at).getTime() : (until || Date.now());
      var mins = Math.max(0, (end - new Date(g.started_at).getTime()) / 60000);
      cost += mins / 60 * (RATES[rkey(type, ec, ev)] || 0);
      prevRp = !!g.reprices_prior;
    });
    return cost;
  }
  function itemsCostOf(items) {
    return (items || []).reduce(function (a, x) { return x.voided_at ? a : a + x.price * x.qty; }, 0);
  }
  function menuChoices() {
    var out = [];
    lastGroups.forEach(function (g) {
      g.items.forEach(function (it) {
        var ov = lastOverrides[it.key];
        if (ov && ov.hidden) return;
        var eff = (ov && ov.prices) || it.prices;
        eff.forEach(function (p, i) {
          out.push({ name: it.name + (eff.length > 1 ? ' (' + (i + 1) + ')' : ''), price: p });
        });
      });
    });
    return out;
  }
  function adjCalc(kind, val, base) {
    val = Number(val) || 0;
    if (kind === 'percent') return Math.round(base * Math.min(Math.max(val, 0), 100) / 100);
    if (kind === 'amount') return Math.min(Math.max(val, 0), base);
    return 0;
  }
  function adjRow(label) {
    var kind = el('select', 'mini-s');
    [['', 'بدون ' + label], ['amount', label + ' جنيه'], ['percent', label + ' %']].forEach(function (o) {
      var op = el('option', null, o[1]); op.value = o[0]; kind.appendChild(op);
    });
    var val = el('input', 'mini-in'); val.inputMode = 'numeric'; val.placeholder = '0'; val.setAttribute('aria-label', label);
    return { kind: kind, val: val };
  }

  function renderRooms(rooms, open, rateRows, openShift, pastShifts, segs, items) {
    items = overlayQ(items);
    clearTimers();
    RATES = {}; (rateRows || []).forEach(function (r) { RATES[rkey(r.room_type, r.controllers, r.vip)] = r.hourly_price; });
    var host = $('rooms'); host.textContent = '';
    var dl = $('shiftNames'); if (dl) { dl.textContent = ''; CFG.shifts.forEach(function (n) { var o = el('option'); o.value = n; dl.appendChild(o); }); }

    // --- shift bar ---
    var shift = (openShift || [])[0] || null;
    var bar = el('div', 'shift-bar');
    if (shift) {
      bar.appendChild(el('span', 'shift-on', 'وردية مفتوحة: ' + (shift.label || ('#' + shift.id)) +
        ' · من ' + new Date(shift.opened_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })));
      var closeSh = el('button', 'btn small warn', 'قفل الوردية'); gate(closeSh, 'shift');
      closeSh.onclick = function () {
        closeSh.disabled = true;
        withAuth(function () { return api('/rest/v1/rpc/close_shift', { method: 'POST', body: '{}' }); })
          .then(function (rep) { showShiftReport('تقفيل الوردية ' + (shift.label || ''), rep, shift.id); bootRooms(); })
          .catch(function (e) { toast('فشل قفل الوردية: ' + e.message, true); closeSh.disabled = false; });
      };
      bar.appendChild(closeSh);
    } else {
      var lbl = el('input', 'mini-in wide'); lbl.setAttribute('list', 'shiftNames'); lbl.placeholder = 'اسم الوردية (صباحية / مسائية...)'; lbl.maxLength = 40;
      var openSh = el('button', 'btn small', 'فتح وردية'); gate(openSh, 'shift');
      openSh.onclick = function () {
        openSh.disabled = true;
        withAuth(function () { return api('/rest/v1/rpc/open_shift', { method: 'POST', body: JSON.stringify({ p_label: lbl.value.trim() }) }); })
          .then(function () { toast('الوردية اتفتحت'); bootRooms(); })
          .catch(function (e) { toast('فشل فتح الوردية: ' + e.message, true); openSh.disabled = false; });
      };
      bar.append(lbl, openSh);
      bar.appendChild(el('span', 'muted', 'مفيش وردية مفتوحة — الحسابات مش بتتسجل في وردية'));
    }
    var auditBtn = el('button', 'btn small ghost', 'سجل العمليات');
    auditBtn.onclick = showAudit;
    bar.appendChild(auditBtn);
    host.appendChild(bar);

    // --- past shifts ---
    (pastShifts || []).forEach(function (sh) {
      if (!sh.report) return;
      var line = el('button', 'shift-past',
        (sh.label || ('وردية #' + sh.id)) + ' · ' + new Date(sh.opened_at).toLocaleDateString('ar-EG') +
        ' · ' + sh.report.sessions + ' جلسة · إجمالي ' + sh.report.total + ' جنيه');
      line.onclick = function () { showShiftReport(sh.label || ('وردية #' + sh.id), sh.report, sh.id); };
      host.appendChild(line);
    });

    // --- rates editor ---
    var ratesBox = el('div', 'room rates adm-only');
    ratesBox.appendChild(el('div', 'r-title', 'أسعار الساعة'));
    var rateInputs = {};
    [false, true].forEach(function (vip) {
      if (vip) ratesBox.appendChild(el('div', 'r-title r-vip-title', 'أسعار VIP (غرفة VIP)'));
      typeIds().forEach(function (t) {
        [2, 4].forEach(function (c) {
          var row = el('div', 'rate-row');
          row.appendChild(el('span', null, typeLabel(t) + ' · ' + tierLabel(c) + (vip ? ' · VIP' : '')));
          var k = rkey(t, c, vip), inp = el('input', 'mini-in'); inp.inputMode = 'numeric';
          inp.value = RATES[k] != null ? RATES[k] : '';
          inp.setAttribute('aria-label', 'سعر ' + typeLabel(t) + ' ' + tierLabel(c) + (vip ? ' VIP' : ''));
          rateInputs[k] = inp;
          row.append(inp, el('span', 'muted', 'جنيه/ساعة'));
          ratesBox.appendChild(row);
        });
      });
    });
    var saveRates = el('button', 'btn small', 'حفظ الأسعار');
    saveRates.onclick = function () {
      var body = Object.keys(rateInputs).map(function (k) {
        var d = digits(rateInputs[k].value);
        return { room_type: k.split('|')[0], controllers: Number(k.split('|')[1]), vip: k.split('|')[2] === 'v', hourly_price: d.length ? d[0] : 0 };
      });
      if (body.some(function (r) { return !(r.hourly_price >= 0 && r.hourly_price <= 2000); })) { toast('السعر لازم يكون بين 0 و 2000', true); return; }
      saveRates.disabled = true;
      withAuth(function () {
        return api('/rest/v1/room_rates', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) });
      }).then(function () { toast('الأسعار اتحفظت'); bootRooms(); })
        .catch(function (e) { toast('فشل حفظ الأسعار: ' + e.message, true); saveRates.disabled = false; });
    };
    ratesBox.appendChild(saveRates);
    host.appendChild(ratesBox);

    // --- room cards ---
    rooms.forEach(function (r) {
      var ses = (open || []).find(function (x) { return x.room_id === r.id; });
      var card = el('div', 'room');
      var sg0 = ses ? (segs || []).filter(function (g) { return g.session_id === ses.id; }) : [];
      var curSeg0 = sg0.length ? sg0[sg0.length - 1] : null;
      var isVip = ses ? !!(curSeg0 && curSeg0.vip) : !!r.vip;
      var top = el('div', 'r-top');
      top.appendChild(el('span', 'r-name', r.name + ' (' + typeLabel(r.room_type || typeIds()[0]) + ')' + (isVip ? ' ⭐ VIP' : '')));
      top.appendChild(el('span', 'r-state ' + (ses ? (ses.paused_at ? 'paused' : 'busy') : 'free'), ses ? (ses.paused_at ? 'متوقفة' : 'مشغولة') : 'فاضية'));
      card.appendChild(top);
      if (isVip) card.classList.add('is-vip');
      var vipL = el('label', 'chk r-vipchk'), vipC = el('input'); vipC.type = 'checkbox'; vipC.checked = isVip;
      vipC.setAttribute('aria-label', 'VIP ' + r.name);
      vipL.append(vipC, document.createTextNode('VIP'));
      if (!can('vip')) { vipC.disabled = true; vipL.title = 'الأدمن قفل الصلاحية دي'; }
      if (ses && ses.paused_at) { vipC.disabled = true; vipL.title = 'كمّل الجلسة الأول'; }
      vipC.onchange = function () {
        var want = vipC.checked; vipC.disabled = true;
        var call = ses ? rpc('set_session_vip', { p_session_id: ses.id, p_vip: want }) : rpc('set_room_vip', { p_room_id: r.id, p_vip: want });
        call.then(function () { toast((want ? 'VIP شغّال' : 'VIP اتقفل') + (ses ? ' · الإجمالي اتحدّث' : '')); bootRooms(); })
          .catch(function (e) { toast('فشل تغيير VIP: ' + (e.offline ? 'محتاج نت' : e.message), true); vipC.checked = !want; vipC.disabled = false; });
      };
      card.appendChild(vipL);

      // room settings (name / code / type)
      var set = el('div', 'r-set adm-only');
      var nameIn = el('input', 'mini-in wide'); nameIn.value = r.name; nameIn.setAttribute('aria-label', 'اسم الغرفة');
      var codeIn = el('input', 'mini-in'); codeIn.value = r.code || ''; codeIn.placeholder = 'الكود'; codeIn.setAttribute('aria-label', 'كود الغرفة اللي الزبون يكتبه');
      var typeIn = el('select', 'mini-s');
      typeIds().forEach(function (t) { var op = el('option', null, typeLabel(t)); op.value = t; if ((r.room_type || typeIds()[0]) === t) op.selected = true; typeIn.appendChild(op); });
      var saveRoom = el('button', 'btn small ghost', 'حفظ');
      saveRoom.onclick = function () {
        saveRoom.disabled = true;
        withAuth(function () {
          return api('/rest/v1/rooms?id=eq.' + r.id, {
            method: 'PATCH', headers: { prefer: 'return=minimal' },
            body: JSON.stringify({ name: nameIn.value.trim().slice(0, 40) || r.name, code: codeIn.value.trim().slice(0, 10) || null, room_type: typeIn.value })
          });
        }).then(function () { toast('الغرفة اتحفظت'); bootRooms(); })
          .catch(function (e) { toast('فشل حفظ الغرفة: ' + e.message, true); saveRoom.disabled = false; });
      };
      set.append(nameIn, codeIn, typeIn, saveRoom);
      card.appendChild(set);
      card.appendChild(el('div', 'muted small-note',
        'السعر دلوقتي' + (isVip ? ' (VIP)' : '') + ': ' + tierLabel(2) + ' ' + (RATES[rkey(r.room_type || typeIds()[0], 2, isVip)] || 0) + ' / ' + tierLabel(4) + ' ' + (RATES[rkey(r.room_type || typeIds()[0], 4, isVip)] || 0) + ' جنيه في الساعة · كود الطلب: ' + (r.code || '—')));

      if (ses) {
        var sSegs = (segs || []).filter(function (g) { return g.session_id === ses.id; });
        var sItems = (items || []).filter(function (x) { return x.session_id === ses.id; });
        var openSeg = sSegs.find(function (g) { return !g.ended_at; });
        var timer = el('div', 'r-timer'), bill = el('div', 'r-bill');
        var disc = adjRow('خصم'), serv = adjRow('خدمة');
        function tick() {
          var tCost = timeCostOf(sSegs, ses.room_type || r.room_type || typeIds()[0]);
          var iCost = itemsCostOf(sItems);
          var base = tCost + iCost;
          var d = adjCalc(disc.kind.value, digits(disc.val.value)[0], base);
          var sv = adjCalc(serv.kind.value, digits(serv.val.value)[0], base - d) ;
          if (serv.kind.value === 'amount') sv = Math.max(Number(digits(serv.val.value)[0]) || 0, 0);
          var ms = sSegs.reduce(function (a, g) { return a + (g.ended_at ? new Date(g.ended_at).getTime() : Date.now()) - new Date(g.started_at).getTime(); }, 0);
          timer.textContent = fmtDur(ms) + (openSeg ? ' · ' + tierLabel(openSeg.controllers) + (openSeg.vip ? ' · VIP' : '') : ' · ⏸ متوقفة' + (isVip ? ' · VIP' : ''));
          var tot = Math.round(base - d + sv);
          bill.textContent = 'الوقت: ' + Math.round(tCost) + ' + الأصناف: ' + iCost +
            (d ? ' − خصم ' + d : '') + (sv ? ' + خدمة ' + sv : '') + ' = ' + tot + ' جنيه' +
            ((ses.deposit_amount || 0) ? ' · مدفوع مقدم ' + ses.deposit_amount + ' · الباقي ' + Math.max(tot - ses.deposit_amount, 0) : '');
        }
        tick(); roomTimers.push(setInterval(tick, 1000));
        card.append(timer, bill);

        // controller switch
        var sw = el('button', 'btn small ghost', 'حوّل لـ ' + tierLabel(openSeg && openSeg.controllers === 2 ? 4 : 2)); gate(sw, 'tier');
        sw.onclick = function () {
          sw.disabled = true;
          var to = openSeg && openSeg.controllers === 2 ? 4 : 2;
          withAuth(function () { return api('/rest/v1/rpc/switch_session_controllers', { method: 'POST', body: JSON.stringify({ p_session_id: ses.id, p_controllers: to }) }); })
            .then(function () { toast('اتحولت لـ ' + tierLabel(to)); bootRooms(); })
            .catch(function (e) { toast('فشل التحويل: ' + e.message, true); sw.disabled = false; });
        };
        if (!openSeg) { sw.disabled = true; }
        card.appendChild(sw);

        // pause / resume (no time billed while paused)
        var pz = el('button', 'btn small ghost', ses.paused_at ? 'كمّل الجلسة ▶' : 'إيقاف مؤقت ⏸'); gate(pz, 'pause');
        pz.onclick = function () {
          pz.disabled = true;
          var fn = ses.paused_at ? 'resume_session' : 'pause_session';
          withAuth(function () { return api('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify({ p_session_id: ses.id }) }); })
            .then(function () { toast(ses.paused_at ? 'الجلسة كملت' : 'الجلسة متوقفة، الوقت مش بيتحسب'); bootRooms(); })
            .catch(function (e) { toast('فشل: ' + e.message, true); pz.disabled = false; });
        };
        card.appendChild(pz);

        // deposit (advance payment)
        var depRow = el('div', 'r-add');
        var depIn = el('input', 'mini-in'); depIn.inputMode = 'numeric'; depIn.placeholder = 'مقدم';
        depIn.value = ses.deposit_amount || ''; depIn.setAttribute('aria-label', 'الدفع المقدم');
        var depBtn = el('button', 'btn small ghost', 'سجّل المقدم'); gate(depBtn, 'deposit');
        depBtn.onclick = function () {
          var v = digits(depIn.value)[0] || 0;
          depBtn.disabled = true;
          withAuth(function () { return api('/rest/v1/rpc/set_session_deposit', { method: 'POST', body: JSON.stringify({ p_session_id: ses.id, p_amount: Math.min(Math.max(v, 0), 100000) }) }); })
            .then(function () { toast('المقدم اتحفظ: ' + v + ' جنيه'); bootRooms(); })
            .catch(function (e) { toast('فشل حفظ المقدم: ' + e.message, true); depBtn.disabled = false; });
        };
        depRow.append(el('span', 'muted', 'مقدم:'), depIn, depBtn);
        card.appendChild(depRow);

        // explicit carry-over to next shift
        var carry = el('button', 'btn small ghost', ses.carried_over ? 'هينتقل للوردية الجاية ✓' : 'نقل للوردية الجاية'); gate(carry, 'carry_over');
        if (ses.carried_over) carry.disabled = true;
        carry.onclick = function () {
          carry.disabled = true;
          withAuth(function () { return api('/rest/v1/rpc/carry_over_session', { method: 'POST', body: JSON.stringify({ p_session_id: ses.id }) }); })
            .then(function () { toast('الجلسة هتتنقل عند قفل الوردية'); bootRooms(); })
            .catch(function (e) { toast('فشل النقل: ' + e.message, true); carry.disabled = false; });
        };
        card.appendChild(carry);

        // items
        var list = el('div', 'r-items');
        sItems.forEach(function (x) {
          var row = el('div', 'r-item' + (x.voided_at ? ' voided' : ''));
          row.appendChild(el('span', null, x.qty + ' × ' + x.name + ' = ' + (x.qty * x.price) + ' جنيه' + (x.source === 'order' ? ' (من المنيو)' : '') + (x.pending ? ' · مستني مزامنة' : '') +
            (x.voided_at ? ' · ملغي: ' + (x.void_reason || '') + (x.voided_by ? ' (بواسطة ' + String(x.voided_by).split('@')[0] + ')' : '') : '')));
          if (!x.voided_at) {
            var del = el('button', 'btn small ghost danger', 'إلغاء'); gate(del, 'void');
            del.onclick = function () {
              del.hidden = true;
              var why = el('input', 'mini-in wide'); why.placeholder = 'سبب الإلغاء (مطلوب)'; why.maxLength = 120; why.setAttribute('aria-label', 'سبب الإلغاء');
              var okb = el('button', 'btn small ghost danger', 'تأكيد الإلغاء');
              okb.onclick = function () {
                var rs = why.value.trim();
                if (rs.length < 2) { toast('اكتب سبب الإلغاء', true); why.focus(); return; }
                okb.disabled = true;
                var vop = uid();
                withAuth(function () { return api('/rest/v1/rpc/void_item', { method: 'POST', body: JSON.stringify({ p_op: vop, p_item_id: x.pending ? null : x.id, p_target_op: x.pending ? x.op : null, p_reason: rs }) }); })
                  .then(function () { toast('اتلغى: ' + x.name); bootRooms(); })
                  .catch(function (e) {
                    if (e.offline || (x.pending && OFFLINE)) { enqueue({ type: 'void', op: vop, item_id: x.pending ? null : x.id, target_op: x.pending ? x.op : null, reason: rs }); toast('أوفلاين: الإلغاء اتحفظ وهيتسجّل لما النت يرجع', true); bootRooms(); return; }
                    toast('فشل الإلغاء: ' + e.message, true); okb.disabled = false; });
              };
              row.append(why, okb);
            };
            row.appendChild(del);
          }
          list.appendChild(row);
        });
        if (!sItems.length) list.appendChild(el('div', 'muted', 'مفيش أصناف على الجلسة لحد دلوقتي'));
        card.appendChild(list);

        // manual add
        var addRow = el('div', 'r-add');
        var sel = el('select', 'mini-s grow');
        menuChoices().forEach(function (c, i) { var op = el('option', null, c.name + ' — ' + c.price); op.value = i; sel.appendChild(op); });
        var choices = menuChoices();
        var qty = el('input', 'mini-in'); qty.inputMode = 'numeric'; qty.value = '1'; qty.setAttribute('aria-label', 'العدد');
        var add = el('button', 'btn small', 'ضيف'); gate(add, 'add_items');
        add.onclick = function () {
          var c = choices[Number(sel.value)]; var q = digits(qty.value)[0] || 1;
          if (!c) return;
          add.disabled = true;
          var aop = uid(), aq = Math.min(Math.max(q, 1), 100);
          withAuth(function () {
            return api('/rest/v1/rpc/add_session_item', { method: 'POST', body: JSON.stringify({ p_op: aop, p_session: ses.id, p_name: c.name, p_price: c.price, p_qty: aq }) });
          }).then(function () { toast('اتضاف: ' + c.name); bootRooms(); })
            .catch(function (e) {
              if (e.offline) { enqueue({ type: 'add', op: aop, session_id: ses.id, name: c.name, price: c.price, qty: aq }); toast('أوفلاين: الصنف اتحفظ على الجهاز وهيتسجّل لما النت يرجع', true); bootRooms(); return; }
              toast('فشل الإضافة: ' + e.message, true); add.disabled = false; });
        };
        addRow.append(sel, qty, add);
        card.appendChild(addRow);

        // discount / service + close
        var adjBox = el('div', 'r-adj');
        adjBox.append(disc.kind, disc.val, serv.kind, serv.val);
        card.appendChild(adjBox);

        var close = el('button', 'btn', 'إنهاء وتحصيل'); gate(close, 'close');
        close.onclick = function () {
          close.disabled = true;
          var rcItems = sItems.filter(function (x) { return !x.voided_at; });
          var rcSegs = sSegs.slice(); var startedAt = new Date(ses.started_at);
          var body = {
            p_session_id: ses.id,
            p_discount_kind: disc.kind.value || null, p_discount_value: digits(disc.val.value)[0] || 0,
            p_service_kind: serv.kind.value || null, p_service_value: digits(serv.val.value)[0] || 0
          };
          var closeAt = Date.now();
          body.p_ended_at = new Date(closeAt).toISOString();
          function localRep() {
            var tc = timeCostOf(sSegs, ses.room_type || r.room_type || typeIds()[0], closeAt), ic = itemsCostOf(sItems), bs = tc + ic;
            var d = adjCalc(disc.kind.value, digits(disc.val.value)[0], bs), sv = adjCalc(serv.kind.value, digits(serv.val.value)[0], bs - d);
            if (serv.kind.value === 'amount') sv = Math.max(Number(digits(serv.val.value)[0]) || 0, 0);
            var ms = sSegs.reduce(function (a, g) { return a + (g.ended_at ? new Date(g.ended_at).getTime() : closeAt) - new Date(g.started_at).getTime(); }, 0);
            var tot = Math.round(bs - d + sv), dep = ses.deposit_amount || 0;
            return { minutes: Math.round(ms / 60000), time_amount: Math.round(tc), items_amount: ic, discount_amount: Math.round(d), service_amount: Math.round(sv), total: tot, deposit: dep, remaining: tot - dep, _offline: true };
          }
          withAuth(function () { return api('/rest/v1/rpc/close_room_session', { method: 'POST', body: JSON.stringify(body) }); })
            .catch(function (e) {
              if (!e.offline) throw e;
              var lr = localRep(), q = getQ();
              q.push({ body: body, room: r.name, local_total: lr.total, at: closeAt }); setQ(q);
              toast('أوفلاين: الحساب اتحفظ على الجهاز وهيتسجّل لما النت يرجع', true);
              return lr;
            })
            .then(function (rep) {
              billModal('حساب ' + r.name, [
                ['الوقت (' + rep.minutes + ' دقيقة)', rep.time_amount + ' جنيه'],
                ['المشروبات والأصناف', rep.items_amount + ' جنيه'],
                rep.discount_amount ? ['الخصم', '− ' + rep.discount_amount + ' جنيه'] : null,
                rep.service_amount ? ['الخدمة', '+ ' + rep.service_amount + ' جنيه'] : null,
                ['الإجمالي', rep.total + ' جنيه', 'total'],
                rep.deposit ? ['مدفوع مقدم', '− ' + rep.deposit + ' جنيه'] : null,
                rep.deposit ? (rep.remaining < 0 ? ['مستحق للعميل (استرداد)', Math.abs(rep.remaining) + ' جنيه', 'total'] : ['الباقي المطلوب', rep.remaining + ' جنيه', 'total']) : null
              ].filter(Boolean), (function () {
                var pb = el('button', 'btn ghost', 'اطبع الإيصال');
                pb.onclick = function () {
                  var now = Date.now();
                  var lines = [['الوقت (' + rep.minutes + ' دقيقة)', rep.time_amount + ' جنيه']];
                  if (rcSegs.length > 1) rcSegs.forEach(function (g) {
                    var m = Math.round(((g.ended_at ? new Date(g.ended_at).getTime() : now) - new Date(g.started_at).getTime()) / 60000);
                    if (m > 0) lines.push(['   ' + tierLabel(g.controllers) + (g.vip ? ' · VIP' : '') + ' · ' + m + ' د', '', 'sub']);
                  });
                  rcItems.forEach(function (x) { lines.push([x.qty + ' × ' + x.name, (x.qty * x.price) + ' جنيه']); });
                  var totals = (rep.discount_amount || rep.service_amount) ? [['المجموع', (rep.time_amount + rep.items_amount) + ' جنيه']] : [];
                  if (rep.discount_amount) totals.push(['الخصم', '− ' + rep.discount_amount + ' جنيه']);
                  if (rep.service_amount) totals.push(['الخدمة', '+ ' + rep.service_amount + ' جنيه']);
                  totals.push(['الإجمالي', rep.total + ' جنيه', 'total']);
                  if (rep.deposit) { totals.push(['مدفوع مقدم', '− ' + rep.deposit + ' جنيه']); totals.push(rep.remaining < 0 ? ['مستحق للعميل (استرداد)', Math.abs(rep.remaining) + ' جنيه', 'total'] : ['الباقي', rep.remaining + ' جنيه', 'total']); }
                  showReceipt({ place: r.name + ' (' + typeLabel(r.room_type || typeIds()[0]) + ')',
                    meta: [['من', stamp(startedAt)], ['إلى', stamp(new Date(now))]].concat(rcSegs.some(function (g) { return g.vip; }) ? [['النوع', 'VIP']] : []), lines: lines, totals: totals });
                };
                return pb;
              })());
              if (!rep._offline) bootRooms(); else { var cc = null; try { cc = JSON.parse(localStorage.getItem(C_KEY)); } catch (x) {} bootRooms(); }
            })
            .catch(function (e) { toast('فشل الإنهاء: ' + e.message, true); close.disabled = false; });
        };
        card.appendChild(close);
      } else {
        var startRow = el('div', 'r-start');
        var ctlSel = el('select', 'mini-s r-ctl'); ctlSel.setAttribute('aria-label', 'فردي / زوجي');
        [2, 4].forEach(function (c) { var op = el('option', null, tierLabel(c)); op.value = c; ctlSel.appendChild(op); });
        var start = el('button', 'btn', '▶ بدء جلسة'); gate(start, 'start');
        start.onclick = function () {
          if (OFFLINE) { toast('بدء جلسة جديدة محتاج نت. اكتب وقت البداية على ورقة', true); return; }
          start.disabled = true;
          withAuth(function () { return api('/rest/v1/rpc/start_room_session', { method: 'POST', body: JSON.stringify({ p_room_id: r.id, p_controllers: Number(ctlSel.value) }) }); })
            .then(function () { toast('بدأت الجلسة: ' + r.name); bootRooms(); })
            .catch(function (e) { toast('فشل البدء: ' + e.message, true); start.disabled = false; });
        };
        startRow.append(ctlSel, start);
        card.appendChild(startRow);
        if (!ses) {
          var delRoom = el('button', 'btn small ghost danger adm-only', 'حذف الغرفة');
          delRoom.onclick = function () {
            if (!confirm('حذف ' + r.name + '؟')) return;
            delRoom.disabled = true;
            withAuth(function () { return api('/rest/v1/rooms?id=eq.' + r.id, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ active: false }) }); })
              .then(function () { toast('اتحذفت'); bootRooms(); })
              .catch(function (e) { toast('فشل الحذف: ' + e.message, true); delRoom.disabled = false; });
          };
          card.appendChild(delRoom);
        }
      }
      host.appendChild(card);
    });

    // --- add room ---
    var addBox = el('div', 'room adm-only');
    addBox.appendChild(el('div', 'r-title', 'ضيف غرفة جديدة'));
    var nName = el('input', 'mini-in wide'); nName.placeholder = 'اسم الغرفة'; nName.maxLength = 40;
    var nCode = el('input', 'mini-in'); nCode.placeholder = 'الكود'; nCode.maxLength = 10;
    var nType = el('select', 'mini-s');
    typeIds().forEach(function (t) { var op = el('option', null, typeLabel(t)); op.value = t; nType.appendChild(op); });
    var addRoom = el('button', 'btn small', 'إضافة');
    addRoom.onclick = function () {
      if (!nName.value.trim()) { toast('اكتب اسم الغرفة', true); return; }
      addRoom.disabled = true;
      withAuth(function () {
        return api('/rest/v1/rooms', { method: 'POST', headers: { prefer: 'return=minimal' },
          body: JSON.stringify({ name: nName.value.trim(), code: nCode.value.trim() || null, room_type: nType.value, rate_per_hour: 0, sort: rooms.length + 1 }) });
      }).then(function () { toast('الغرفة اتضافت'); bootRooms(); })
        .catch(function (e) { toast('فشل الإضافة: ' + e.message, true); addRoom.disabled = false; });
    };
    var addRow2 = el('div', 'r-add'); addRow2.append(nName, nCode, nType, addRoom);
    addBox.appendChild(addRow2);
    host.appendChild(addBox);
  }


  // ---------- audit log ----------
  var AUDIT_AR = { start: 'بدء جلسة', close: 'إنهاء وتحصيل', item_add: 'إضافة صنف', item_void: 'إلغاء صنف', deposit: 'مقدم',
    carry_over: 'نقل للوردية الجاية', pause: 'إيقاف مؤقت', resume: 'استئناف', controllers: 'تغيير فردي/زوجي', vip: 'تغيير VIP' };
  function totalsTxt(d) { return d.total_before != null ? ' · الإجمالي ' + d.total_before + ' ← ' + d.total_after + ' (' + (d.mode === 'from_now' ? 'من دلوقتي' : 'الجلسة كلها') + ')' : ''; }
  function auditText(a) {
    var d = a.detail || {};
    switch (a.action) {
      case 'item_add': return d.qty + ' × ' + d.name + ' (' + (d.source === 'order' ? 'طلب' : 'يدوي') + ')';
      case 'item_void': return d.qty + ' × ' + d.name + ' · السبب: ' + (d.reason || '');
      case 'deposit': return d.amount + ' جنيه';
      case 'close': return 'الإجمالي ' + d.total + (d.discount ? ' · خصم ' + d.discount : '') + (d.service ? ' · خدمة ' + d.service : '');
      case 'controllers': return tierLabel(d.from) + ' ← ' + tierLabel(d.to) + totalsTxt(d);
      case 'vip': return (d.from ? 'VIP' : 'عادي') + ' ← ' + (d.to ? 'VIP' : 'عادي') + totalsTxt(d);
      default: return '';
    }
  }
  function showAudit() {
    withAuth(function () { return api('/rest/v1/session_audit?select=*&order=id.desc&limit=60'); }).then(function (rows) {
      var ov = el('div', 'bill-ov'), box = el('div', 'bill-box audit-box');
      box.appendChild(el('h3', null, 'سجل العمليات'));
      if (!rows || !rows.length) box.appendChild(el('div', 'muted', 'مفيش عمليات متسجلة'));
      (rows || []).forEach(function (a) {
        var row = el('div', 'audit-row');
        var t = new Date(a.at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });
        row.append(el('span', 'a-t', t), el('span', 'a-r', (a.room_name || '') + ' · ' + (AUDIT_AR[a.action] || a.action)),
          el('span', 'a-d', auditText(a) + (a.actor && a.actor !== 'system' ? ' · ' + a.actor.split('@')[0] : '')));
        box.appendChild(row);
      });
      var ok = el('button', 'btn', 'تم'); ok.onclick = function () { ov.remove(); };
      box.appendChild(ok); ov.appendChild(box); document.body.appendChild(ov);
    }).catch(function (e) { toast('فشل تحميل السجل: ' + e.message, true); });
  }

  function showShiftReport(title, rep, shiftId) {
    if (ROLE === 'admin' && shiftId && !rep.stock_counts) {
      rpc('shift_stock_json', { p_shift_id: shiftId }).then(function (x) { showShiftReport(title, Object.assign({}, rep, x), null); }).catch(function () { showShiftReport(title, rep, null); });
      return;
    }
    var lines = [
      ['جلسات متقفلة', String(rep.sessions)],
      ['وقت البلايستيشن', rep.time_amount + ' جنيه'],
      ['المشروبات والأصناف', rep.items_amount + ' جنيه'],
      ['الخصومات', '− ' + rep.discount_amount + ' جنيه'],
      ['الخدمة', '+ ' + rep.service_amount + ' جنيه'],
      ['إجمالي فواتير الوردية', rep.total + ' جنيه', 'total'],
      ['مقدمات استلمتها الوردية', (rep.deposits_received || 0) + ' جنيه'],
      ['باقي الفواتير المتقفلة', (rep.collected_at_close != null ? rep.collected_at_close : rep.total) + ' جنيه']
    ];
    (rep.stock_counts || []).forEach(function (c, i) {
      if (!i) lines.push(['جرد المخزون (المتوقع / الفعلي):', '', 'sub']);
      lines.push([c.item, c.expected + ' / ' + c.actual + ' ' + c.unit + (Number(c.diff) ? ' · فرق ' + c.diff : ' · مظبوط')]);
    });
    if (rep.sales_count) lines.push(['مبيعات بدون غرف (' + rep.sales_count + ')', '+ ' + rep.sales_total + ' جنيه']);
    if (rep.expenses != null) {
      lines.push(['مصروفات الوردية', '− ' + rep.expenses + ' جنيه']);
      (rep.expenses_list || []).forEach(function (x, i) {
        if (!i) lines.push(['تفاصيل المصروفات:', '', 'sub']);
        lines.push([x.reason + ' · ' + String(x.by || '').split('@')[0], '− ' + x.amount + ' جنيه']);
      });
      lines.push(['النقدية المتوقعة في الدرج', rep.expected_cash + ' جنيه', 'total']);
    }
    (rep.handed_over || []).forEach(function (h, i) {
      if (!i) lines.push(['جلسات اتنقلت للوردية الجاية:', '', 'sub']);
      lines.push([h.room + ' · ' + h.minutes + ' دقيقة · ' + tierLabel(h.controllers || 2), 'متراكم ' + h.subtotal + ' جنيه']);
    });
    var pbtn = el('button', 'btn ghost', 'اطبع التقرير');
    pbtn.onclick = function () {
      var body = lines.filter(function (l) { return l[2] !== 'total'; }), tot = lines.filter(function (l) { return l[2] === 'total'; });
      document.querySelectorAll('.bill-ov').forEach(function (o) { o.remove(); });
      showReceipt({ place: title, meta: [['التاريخ', stamp()]], lines: body.map(function (l) { return [l[0], l[1], l[2]]; }), totals: tot });
    };
    billModal(title, lines, pbtn);
  }

  function bootRooms() {
    lowBadge();
    loadRooms().then(function (p) { renderRooms(p[0] || [], p[1] || [], p[2] || [], p[3] || [], p[4] || [], p[5] || [], p[6] || []); })
      .catch(function (e) {
        var c = null; try { c = JSON.parse(localStorage.getItem(C_KEY) || 'null'); } catch (x) {}
        if (e.offline && c) {
          var done = getQ().map(function (x) { return x.body.p_session_id; }), p = c.p;
          renderRooms(p[0] || [], (p[1] || []).filter(function (x) { return done.indexOf(x.id) < 0; }), p[2] || [], p[3] || [], p[4] || [], p[5] || [], p[6] || []);
          toast('أوفلاين: معروض من آخر نسخة محفوظة (' + stamp(new Date(c.t)) + ')', true);
        } else toast('فشل تحميل الغرف: ' + e.message, true);
      });
  }

  // ---------- orders tab: recent menu orders + receipt ----------
  var STATUS_AR = { new: 'جديد', accepted: 'اتقبل', preparing: 'بيتحضّر', ready: 'جاهز' };
  function bootOrders() {
    var host = $('orders'); host.textContent = '';
    withAuth(function () { return api('/rest/v1/orders?select=id,status,summary,created_at&order=created_at.desc&limit=30'); }).then(function (rows) {
      if (!rows || !rows.length) { host.appendChild(el('div', 'muted', 'مفيش طلبات لسه')); return; }
      rows.forEach(function (o) {
        var sm = o.summary || {};
        var card = el('div', 'room');
        var top = el('div', 'r-top');
        top.appendChild(el('span', 'r-name', (sm.type || '') + ' ' + (sm.num || '') + (sm.who ? ' · ' + sm.who : '')));
        top.appendChild(el('span', 'r-state busy', STATUS_AR[o.status] || o.status));
        card.appendChild(top);
        card.appendChild(el('div', 'muted small-note', stamp(new Date(o.created_at)) + ' · ' + (sm.total || 0) + ' جنيه'));
        var pb = el('button', 'btn small ghost', 'اطبع الإيصال');
        pb.onclick = function () {
          showReceipt({ place: (sm.type || '') + ' رقم ' + (sm.num || ''),
            meta: [['التاريخ', stamp(new Date(o.created_at))]].concat(sm.who ? [['الاسم', sm.who]] : []),
            lines: (sm.items || []).map(function (x) { return [x.qty + ' × ' + x.name, (x.qty * x.price) + ' جنيه']; }),
            totals: [['الإجمالي', (sm.total || 0) + ' جنيه', 'total']] });
        };
        card.appendChild(pb);
        host.appendChild(card);
      });
    }).catch(function (e) { toast('فشل تحميل الطلبات: ' + e.message, true); });
  }
  function pick(tab) {
    ['Menu', 'Rooms', 'Orders', 'Sale', 'Ops', 'Stock', 'Dash', 'Staff', 'Settings'].forEach(function (n) {
      $('tab' + n).classList.toggle('on', n === tab); $((n.toLowerCase()) + 'Tab').hidden = n !== tab;
    });
    clearTimers();
  }
  $('tabMenu').onclick = function () { pick('Menu'); };
  $('tabSettings').onclick = function () { pick('Settings'); bootSettings(); };
  $('tabStaff').onclick = function () { pick('Staff'); bootStaff(); };
  $('tabOps').onclick = function () { pick('Ops'); bootOps(); };
  $('tabStock').onclick = function () { pick('Stock'); bootStock(); };
  $('tabSale').onclick = function () { pick('Sale'); bootSale(); };
  $('tabDash').onclick = function () { pick('Dash'); bootDash(); };
  $('tabRooms').onclick = function () {
    pick('Rooms'); bootRooms();
  };
  $('tabOrders').onclick = function () {
    pick('Orders'); bootOrders();
  };


  // ---------- attendance, petty expenses, salary advances ----------
  function myEmail() { try { var t = JSON.parse(localStorage.getItem('evo-admin-session')).access_token; return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).email; } catch (e) { return ''; } }
  function who(e) { return String(e || '').replace(/@staff\.evo\.invalid$/, '').replace(/@.*$/, ''); }
  function fmtT(d) { return d ? new Date(d).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }) : '—'; }
  function dayKey(d) { var x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); }
  function localInput(d) { if (!d) return ''; var x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); }
  function csvDown(name, rows) {
    var t = '\ufeff' + rows.map(function (r) { return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = name; a.click();
  }
  function monthRange(v) { var p = v.split('-'), a = new Date(Number(p[0]), Number(p[1]) - 1, 1), b = new Date(Number(p[0]), Number(p[1]), 1); return [a.toISOString(), b.toISOString()]; }
  function sec(host, title) { var b = el('div', 'room ops-sec'); b.appendChild(el('div', 'r-title', title)); host.appendChild(b); return b; }

  // ---------- inventory ----------
  function num(v) { var n = Number(String(v).replace(/[٠-٩]/g, function (d) { return d.charCodeAt(0) - 1632; }).replace(',', '.')); return isFinite(n) ? n : NaN; }
  function fq(n) { return String(Math.round(Number(n) * 1000) / 1000); }
  function lowBadge() {
    rpc('stock_list').then(function (r) {
      var n = (r || []).filter(function (x) { return x.active && x.low; }).length;
      $('tabStock').textContent = 'المخزون' + (n ? ' ⚠ ' + n : '');
    }).catch(function () {});
  }
  function bootStock() {
    var host = $('stockTab'); host.textContent = '';
    var admin = ROLE === 'admin';
    var secI = sec(host, 'المخزون'), secR = admin ? sec(host, 'الوصفات والتكلفة (خصم تلقائي عند البيع)') : null, secM = admin ? sec(host, 'سجل الحركات') : null;
    var items = [], menu = [];
    function load() {
      lowBadge();
      Promise.all([rpc('stock_list'), admin ? rpcGet('/rest/v1/menu_items?select=id,name,prices&hidden=eq.false&order=name&limit=1000') : Promise.resolve([])])
        .then(function (r) { items = r[0] || []; menu = r[1] || []; drawItems(); if (admin) { drawRecipes(); drawMoves(); } })
        .catch(function (e) { secI.appendChild(el('div', 'muted', 'تعذر التحميل: ' + e.message)); });
    }
    function fresh(s2) { s2.querySelectorAll('.ops-body').forEach(function (n) { n.remove(); }); var b2 = el('div', 'ops-body'); s2.appendChild(b2); return b2; }
    function drawItems() {
      var body = fresh(secI), act = items.filter(function (i) { return i.active; });
      var low = act.filter(function (i) { return i.low; });
      if (low.length) body.appendChild(el('div', 'bill-row total', '⚠ تحت الحد الأدنى: ' + low.map(function (i) { return i.name + (admin ? ' (' + fq(i.qty) + ' ' + i.unit + ')' : ''); }).join('، ')));
      var cnt = {}, value = 0;
      act.forEach(function (i) {
        if (admin) value += Number(i.qty) * Number(i.cost);
        var row = el('div', 'row' + (i.low ? ' oos' : ''));
        row.appendChild(el('div', 'cur', i.name + (admin ? ' · الحد الأدنى ' + fq(i.min_level) + ' ' + i.unit + ' · تكلفة الوحدة ' + fq(i.cost) : ' (' + i.unit + ')') + (i.low ? ' · ⚠ منخفض' : '')));
        if (admin) row.appendChild(el('div', 'name', fq(i.qty) + ' ' + i.unit));
        var q = el('input', 'price-in'); q.inputMode = 'decimal'; q.placeholder = 'الكمية';
        var nt = el('input', 'm-in'); nt.placeholder = 'سبب (للصادر/الهالك)'; nt.maxLength = 80;
        var bi = el('button', 'btn small', 'وارد'), bo = el('button', 'btn small ghost', 'صادر'), bw = el('button', 'btn small ghost danger', 'هالك');
        [bi, bo, bw].forEach(function (b2) { gate(b2, 'stock_move'); });
        var mv = function (kind) { return function () { var v = num(q.value); if (!(v > 0)) { toast('اكتب الكمية', true); return; }
          rpc('stock_move', { p_item: i.id, p_qty: v, p_kind: kind, p_note: nt.value }).then(function () { toast('اتسجل'); load(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); }; };
        bi.onclick = mv('in'); bo.onclick = mv('out'); bw.onclick = mv('waste');
        row.append(q, nt, bi, bo, bw);
        if (admin) {
          var ed = el('button', 'btn small ghost', 'تعديل');
          ed.onclick = function () { var n = prompt('الاسم', i.name); if (!n) return; var u = prompt('الوحدة', i.unit); var m = prompt('الحد الأدنى', i.min_level); if (m == null) return; var c = prompt('تكلفة الوحدة (جنيه)', i.cost); if (c == null) return;
            rpc('stock_item_save', { p_id: i.id, p_name: n, p_unit: u, p_min: num(m) || 0, p_active: true, p_cost: num(c) || 0 }).then(function () { toast('اتعدل'); load(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
          var ar = el('button', 'btn small ghost danger', 'إيقاف');
          ar.onclick = function () { if (!confirm('إيقاف ' + i.name + '؟ الوصفات المرتبطة هتفضل لكن مش هتتحسب.')) return;
            rpc('stock_item_save', { p_id: i.id, p_name: i.name, p_unit: i.unit, p_min: i.min_level, p_active: false, p_cost: i.cost }).then(load).catch(function (e) { toast('فشل: ' + e.message, true); }); };
          row.append(ed, ar);
        }
        cnt[i.id] = el('input', 'price-in'); cnt[i.id].inputMode = 'decimal'; cnt[i.id].placeholder = 'الفعلي';
        body.appendChild(row);
      });
      if (!act.length) body.appendChild(el('div', 'muted', 'مفيش أصناف مخزون لسه'));
      if (admin && act.length) body.appendChild(el('div', 'cur', 'قيمة المخزون بالتكلفة: ' + Math.round(value) + ' جنيه'));
      if (admin) {
        var f = el('div', 'row'); f.appendChild(el('div', 'cur', 'صنف مخزون جديد'));
        var n = el('input', 'm-in'); n.placeholder = 'الاسم (مثال: لبن)'; n.maxLength = 80;
        var u = el('input', 'mini-in'); u.placeholder = 'الوحدة'; u.maxLength = 20;
        var m = el('input', 'price-in'); m.placeholder = 'الحد الأدنى'; m.inputMode = 'decimal';
        var c = el('input', 'price-in'); c.placeholder = 'تكلفة الوحدة'; c.inputMode = 'decimal';
        var b = el('button', 'btn small', 'إضافة');
        b.onclick = function () { if (!n.value.trim()) return; rpc('stock_item_save', { p_id: null, p_name: n.value, p_unit: u.value, p_min: num(m.value) || 0, p_active: true, p_cost: num(c.value) || 0 }).then(function () { toast('اتضاف'); load(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
        f.append(n, u, m, c, b); body.appendChild(f);
      }
      // physical count (جرد), tied to the open shift. Cashiers count blind: no expected quantity is shown.
      var cb = el('div', 'ops-emp'); cb.appendChild(el('div', 'name', 'جرد فعلي عند قفل الوردية (اكتب الكمية الموجودة فعلاً)'));
      act.forEach(function (i) { var r = el('div', 'row'); r.appendChild(el('div', 'cur', i.name + ' (' + i.unit + ')')); r.appendChild(cnt[i.id]); cb.appendChild(r); });
      var go = el('button', 'btn small', 'سجّل الجرد'); gate(go, 'stock_count');
      go.onclick = function () {
        var lines = act.filter(function (i) { return cnt[i.id].value.trim() !== ''; }).map(function (i) { return { item_id: i.id, actual: num(cnt[i.id].value) }; });
        if (!lines.length || lines.some(function (l) { return !(l.actual >= 0); })) { toast('اكتب الكميات الفعلية', true); return; }
        go.disabled = true;
        rpc('stock_count', { p_counts: lines, p_note: '' }).then(function (res) {
          if (!admin) { toast('اتسجل الجرد (' + res.length + ' صنف). الأدمن هيشوف الفروق.'); load(); return; }
          var by = {}; items.forEach(function (i) { by[i.id] = i; });
          billModal('نتيجة الجرد', res.map(function (r) { var d = Number(r.diff); return [by[r.item_id].name, 'المتوقع ' + fq(r.expected) + ' · الفعلي ' + fq(r.actual) + (d ? ' · فرق ' + (d > 0 ? '+' : '') + fq(d) : ' · مظبوط'), d ? 'sub' : '']; }));
          load();
        }).catch(function (e) { toast('فشل: ' + e.message, true); go.disabled = false; });
      };
      cb.appendChild(go); if (act.length) body.appendChild(cb);
    }
    function mlabel(m) { return m.name + (m.prices.length > 1 ? ' (' + m.prices.join('/') + ')' : ' (' + m.prices[0] + ')'); }
    function drawRecipes() {
      var body = fresh(secR), act = items.filter(function (i) { return i.active; });
      Promise.all([rpcGet('/rest/v1/recipes?select=*&order=menu_item_id'), rpcGet('/rest/v1/menu_costs?select=*')]).then(function (rr) {
        var rs = rr[0] || [], costs = {}; (rr[1] || []).forEach(function (c) { costs[c.menu_item_id] = c.cost; });
        var by = {}; rs.forEach(function (r) { var k = r.menu_item_id + '|' + (r.size_idx || 0); (by[k] = by[k] || []).push(r); });
        var nm = {}; items.forEach(function (i) { nm[i.id] = i; }); var mm = {}; menu.forEach(function (m) { mm[m.id] = m; });
        Object.keys(by).forEach(function (k) {
          var pr = k.split('|'), m = mm[pr[0]], sz = Number(pr[1]);
          var cost = by[k].reduce(function (a, r) { return a + Number(r.qty) * Number((nm[r.item_id] || {}).cost || 0); }, 0);
          var row = el('div', 'row'); row.appendChild(el('div', 'cur', (m ? m.name : '?') + (sz ? ' · مقاس ' + sz : ' · كل المقاسات') + ' ← ' + by[k].map(function (r) { return fq(r.qty) + ' ' + (nm[r.item_id] ? nm[r.item_id].unit + ' ' + nm[r.item_id].name : '?'); }).join(' + ') + ' · تكلفة ' + (Math.round(cost * 100) / 100) + ' جنيه'));
          var rm = el('button', 'btn small ghost danger', 'حذف'); rm.onclick = function () { rpc('recipe_set', { p_menu_item_id: Number(pr[0]), p_size: sz || null, p_lines: [] }).then(drawRecipes).catch(function (e) { toast('فشل: ' + e.message, true); }); };
          row.appendChild(rm); body.appendChild(row);
        });
        if (!rs.length) body.appendChild(el('div', 'muted', 'مفيش وصفات. اربط صنف المنيو بمكوناته من المخزون.'));
        if (!act.length || !menu.length) return;
        var f = el('div', 'row'); f.appendChild(el('div', 'cur', 'وصفة لصنف من المنيو (بتتربط بالصنف نفسه، مش بالاسم)'));
        var ms = el('select', 'mini-s'); menu.forEach(function (m) { var o = el('option', null, mlabel(m)); o.value = m.id; ms.appendChild(o); });
        var zs = el('select', 'mini-s');
        var fillSz = function () { zs.textContent = ''; var m = mm[ms.value]; var o0 = el('option', null, 'كل المقاسات'); o0.value = ''; zs.appendChild(o0); if (m && m.prices.length > 1) m.prices.forEach(function (p, i) { var o = el('option', null, 'مقاس ' + (i + 1) + ' (' + p + ')'); o.value = i + 1; zs.appendChild(o); }); };
        ms.onchange = fillSz; fillSz();
        var si = el('select', 'mini-s'); act.forEach(function (i) { var o = el('option', null, i.name + ' (' + i.unit + ')'); o.value = i.id; si.appendChild(o); });
        var q = el('input', 'price-in'); q.inputMode = 'decimal'; q.placeholder = 'الكمية للوحدة';
        var b = el('button', 'btn small', 'أضف مكون');
        b.onclick = function () { var v = num(q.value); if (!(v > 0)) { toast('الكمية مطلوبة', true); return; }
          var key = ms.value + '|' + (zs.value || 0);
          var lines = (by[key] || []).filter(function (r) { return String(r.item_id) !== si.value; }).map(function (r) { return { item_id: r.item_id, qty: Number(r.qty) }; });
          lines.push({ item_id: Number(si.value), qty: v });
          rpc('recipe_set', { p_menu_item_id: Number(ms.value), p_size: zs.value ? Number(zs.value) : null, p_lines: lines }).then(function () { toast('اتحفظت الوصفة'); drawRecipes(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
        f.append(ms, zs, si, q, b); body.appendChild(f);
        // fallback cost for items without a recipe
        var g = el('div', 'row'); g.appendChild(el('div', 'cur', 'تكلفة صنف بدون وصفة (جنيه للقطعة)'));
        var ms2 = el('select', 'mini-s'); menu.forEach(function (m) { var o = el('option', null, mlabel(m) + (costs[m.id] != null ? ' · ' + costs[m.id] : '')); o.value = m.id; ms2.appendChild(o); });
        var cv = el('input', 'price-in'); cv.inputMode = 'decimal'; cv.placeholder = 'التكلفة';
        var cb2 = el('button', 'btn small', 'احفظ');
        cb2.onclick = function () { var v = num(cv.value); if (!(v >= 0)) { toast('اكتب التكلفة', true); return; } rpc('menu_cost_set', { p_menu_item_id: Number(ms2.value), p_cost: v }).then(function () { toast('اتحفظت التكلفة'); drawRecipes(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
        g.append(ms2, cv, cb2); body.appendChild(g);
      });
    }
    function drawMoves() {
      var body = fresh(secM), nm = {}; items.forEach(function (i) { nm[i.id] = i; });
      var K = { 'in': 'وارد', out: 'صادر', waste: 'هالك', sale: 'بيع', void_restore: 'استرجاع (إلغاء)', count: 'تسوية جرد', adjust: 'تعديل' };
      rpcGet('/rest/v1/stock_moves?select=*&order=id.desc&limit=40').then(function (rows) {
        (rows || []).forEach(function (m) { var i = nm[m.item_id] || { name: '?', unit: '' };
          body.appendChild(el('div', 'cur', fmtT(m.at) + ' · ' + K[m.kind] + ' · ' + i.name + ' ' + (Number(m.delta) > 0 ? '+' : '') + fq(m.delta) + ' ' + i.unit + ' · ' + who(m.actor) + (m.note ? ' · ' + m.note : ''))); });
        if (!rows || !rows.length) body.appendChild(el('div', 'muted', 'مفيش حركات'));
        var ex = el('button', 'btn small ghost', 'تصدير CSV');
        ex.onclick = function () { csvDown('stock-moves.csv', [['الوقت', 'النوع', 'الصنف', 'الكمية', 'بواسطة', 'ملاحظة']].concat((rows || []).map(function (m) { return [m.at, K[m.kind], (nm[m.item_id] || {}).name, m.delta, who(m.actor), m.note]; }))); };
        body.appendChild(ex);
      });
    }
    load();
  }

  // ---------- quick sale: takeaway / table, no room ----------
  function bootSale() {
    var host = $('saleTab'); host.textContent = '';
    var cart = {}, menu = [], cats = [];
    var secS = sec(host, 'بيع سريع (تيك أواي / ترابيزة)'), secL = sec(host, 'مبيعات الوردية');
    var body = el('div', 'ops-body'); secS.appendChild(body);
    function total() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k].price * cart[k].qty; }, 0); }
    function drawCart() {
      cartBox.textContent = '';
      var ks = Object.keys(cart);
      ks.forEach(function (k) {
        var l = cart[k], row = el('div', 'row');
        row.appendChild(el('div', 'cur', l.name + ' · ' + l.price + ' جنيه'));
        var mi = el('button', 'btn small ghost', '−'), pl = el('button', 'btn small ghost', '+');
        mi.onclick = function () { l.qty--; if (l.qty <= 0) delete cart[k]; drawCart(); };
        pl.onclick = function () { if (l.qty < 50) l.qty++; drawCart(); };
        row.append(mi, el('div', 'name', String(l.qty)), pl, el('div', 'name', (l.price * l.qty) + ' جنيه'));
        cartBox.appendChild(row);
      });
      if (!ks.length) cartBox.appendChild(el('div', 'muted', 'السلة فاضية. اختار أصناف من تحت.'));
      tot.textContent = 'الإجمالي: ' + total() + ' جنيه';
    }
    var cartBox = el('div', 'ops-emp'), tot = el('div', 'bill-row total', '');
    var kind = el('select', 'mini-s'); [['takeaway', 'تيك أواي'], ['table', 'ترابيزة']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; kind.appendChild(op); });
    var label = el('input', 'mini-in'); label.placeholder = 'رقم الترابيزة / الاسم'; label.maxLength = 40;
    var dk = el('select', 'mini-s'); [['', 'بدون خصم'], ['percent', 'خصم %'], ['amount', 'خصم جنيه']].forEach(function (o) { var op = el('option', null, o[1]); op.value = o[0]; dk.appendChild(op); });
    var dv = el('input', 'price-in'); dv.inputMode = 'numeric'; dv.placeholder = 'قيمة الخصم';
    var note = el('input', 'm-in'); note.placeholder = 'ملاحظة'; note.maxLength = 120;
    var go = el('button', 'btn', 'تأكيد البيع'); gate(go, 'sale');
    go.onclick = function () {
      var ks = Object.keys(cart); if (!ks.length) { toast('السلة فاضية', true); return; }
      go.disabled = true;
      var lines = ks.map(function (k) { var l = cart[k]; return l.id ? { menu_item_id: l.id, size_idx: l.size || null, qty: l.qty } : { name: l.name, price: l.price, qty: l.qty }; });
      var args = { p_op: uid(), p_kind: kind.value, p_label: label.value, p_items: lines, p_disc_kind: dk.value || null, p_disc_val: digits(dv.value)[0] || 0, p_note: note.value };
      var snap = ks.map(function (k) { return cart[k]; }), dsum = dk.value === 'percent' ? Math.round(total() * Math.min(digits(dv.value)[0] || 0, 100) / 100) : dk.value === 'amount' ? Math.min(digits(dv.value)[0] || 0, total()) : 0, tsum = total();
      function done(queued) {
        var rl = snap.map(function (l) { return [l.qty + ' × ' + l.name, (l.qty * l.price) + ' جنيه']; });
        var tt = dsum ? [['المجموع', tsum + ' جنيه'], ['الخصم', '− ' + dsum + ' جنيه']] : [];
        tt.push(['الإجمالي', (tsum - dsum) + ' جنيه', 'total']);
        showReceipt({ place: (kind.value === 'table' ? 'ترابيزة ' : 'تيك أواي ') + label.value, meta: [['الوقت', stamp()]], lines: rl, totals: tt });
        cart = {}; label.value = ''; dv.value = ''; note.value = ''; drawCart(); go.disabled = false; if (!queued) loadList();
      }
      withAuth(function () { return api('/rest/v1/rpc/create_sale', { method: 'POST', body: JSON.stringify(args) }); })
        .then(function () { toast('اتسجل البيع'); done(false); })
        .catch(function (e) {
          if (e.offline) { enqueue({ type: 'sale', body: args, total: tsum - dsum }); toast('أوفلاين: البيع اتحفظ وهيتسجّل لما النت يرجع', true); done(true); return; }
          toast('فشل: ' + e.message, true); go.disabled = false; });
    };
    var cust = el('div', 'row');
    var cn = el('input', 'm-in'); cn.placeholder = 'صنف خارج المنيو (الاسم)'; cn.maxLength = 60; var cp = el('input', 'price-in'); cp.inputMode = 'numeric'; cp.placeholder = 'السعر';
    var cb = el('button', 'btn small ghost', 'أضف'); gate(cb, 'add_items');
    cb.onclick = function () { var pr = digits(cp.value)[0]; if (!cn.value.trim() || !(pr >= 0) || pr > 2000) { toast('الاسم والسعر (حتى 2000)', true); return; } var k = 'c|' + cn.value.trim() + '|' + pr; cart[k] = cart[k] || { name: cn.value.trim(), price: pr, qty: 0 }; cart[k].qty++; cn.value = ''; cp.value = ''; drawCart(); };
    cust.append(cn, cp, cb);
    var q = el('input', 'm-in'); q.placeholder = 'ابحث في المنيو'; var cs = el('select', 'mini-s');
    var pick2 = el('div', 'ops-emp');
    function drawMenu() {
      pick2.textContent = '';
      var t = q.value.trim(), cat = cs.value, n = 0;
      menu.forEach(function (m) {
        if (m.hidden || m.out_of_stock || !m.prices.length) return;
        if (cat && m.category_id !== cat) return; if (t && m.name.indexOf(t) < 0) return;
        if (n++ > 80) return;
        var row = el('div', 'row'); row.appendChild(el('div', 'cur', m.name));
        m.prices.forEach(function (pr, i) {
          var b = el('button', 'btn small ghost', (m.prices.length > 1 ? 'مقاس ' + (i + 1) + ' · ' : '') + pr);
          b.onclick = function () { var k = m.id + '|' + (m.prices.length > 1 ? i + 1 : 0); cart[k] = cart[k] || { id: m.id, size: m.prices.length > 1 ? i + 1 : null, name: m.name + (m.prices.length > 1 ? ' (' + (i + 1) + ')' : ''), price: pr, qty: 0 }; cart[k].qty++; drawCart(); };
          row.appendChild(b);
        });
        pick2.appendChild(row);
      });
      if (!n) pick2.appendChild(el('div', 'muted', 'مفيش أصناف مطابقة'));
    }
    q.oninput = drawMenu; cs.onchange = drawMenu;
    var f1 = el('div', 'row'); f1.append(kind, label); var f2 = el('div', 'row'); f2.append(dk, dv, note);
    body.append(f1, cartBox, tot, cust, f2, go, q, cs, pick2);
    drawCart();
    var lb = el('div', 'ops-body'); secL.appendChild(lb);
    function loadList() {
      lb.textContent = '';
      rpcGet('/rest/v1/sales?select=*,sale_items(name,qty,price)&order=id.desc&limit=30').then(function (rows) {
        (rows || []).forEach(function (sl) {
          var row = el('div', 'row' + (sl.voided_at ? ' oos' : ''));
          row.appendChild(el('div', 'cur', fmtT(sl.at) + ' · ' + (sl.kind === 'order' ? 'طلب تطبيق' : sl.kind === 'table' ? 'ترابيزة' : 'تيك أواي') + ' ' + (sl.label || '') + ' · ' + who(sl.actor) + ' · ' + (sl.sale_items || []).map(function (x) { return x.qty + '×' + x.name; }).join('، ') + (sl.voided_at ? ' · ملغي: ' + sl.void_reason : '')));
          row.appendChild(el('div', 'name', sl.total + ' جنيه'));
          if (!sl.voided_at) {
            var vb = el('button', 'btn small ghost danger', 'إلغاء'); gate(vb, 'void');
            vb.onclick = function () { var r = prompt('سبب الإلغاء؟'); if (!r || r.trim().length < 2) return;
              rpc('void_sale', { p_op: uid(), p_id: sl.id, p_reason: r.trim() }).then(function () { toast('اتلغى'); loadList(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
            row.appendChild(vb);
          }
          lb.appendChild(row);
        });
        if (!rows || !rows.length) lb.appendChild(el('div', 'muted', 'مفيش مبيعات'));
      }).catch(function (e) { lb.appendChild(el('div', 'muted', 'تعذر التحميل: ' + e.message)); });
    }
    Promise.all([rpcGet('/rest/v1/menu_categories?select=id,name_ar,sort&hidden=eq.false&order=sort'), rpcGet('/rest/v1/menu_items?select=id,category_id,name,prices,hidden,out_of_stock&kind=eq.item&order=sort&limit=1000')]).then(function (r) {
      cats = r[0] || []; menu = r[1] || [];
      var o0 = el('option', null, 'كل الأقسام'); o0.value = ''; cs.appendChild(o0);
      cats.forEach(function (c) { var o = el('option', null, c.name_ar); o.value = c.id; cs.appendChild(o); });
      drawMenu();
    }).catch(function (e) { pick2.appendChild(el('div', 'muted', 'تعذر تحميل المنيو: ' + e.message)); });
    loadList();
  }

  // ---------- dashboard: sales, costs, profit (admin) ----------
  function bootDash() {
    var host = $('dashTab'); host.textContent = '';
    var sc = sec(host, 'التقارير: المبيعات والأرباح');
    var bar = el('div', 'row');
    var d1 = el('input', 'mini-in'), d2 = el('input', 'mini-in'); d1.type = 'date'; d2.type = 'date';
    var now = new Date(), pad = function (n) { return String(n).padStart(2, '0'); }, ymd = function (d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    d1.value = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); d2.value = ymd(now);
    var bT = el('button', 'btn small ghost', 'النهارده'), bM = el('button', 'btn small ghost', 'الشهر ده'), bG = el('button', 'btn small', 'اعرض');
    bT.onclick = function () { d1.value = d2.value = ymd(new Date()); run(); };
    bM.onclick = function () { d1.value = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); d2.value = ymd(new Date()); run(); };
    bG.onclick = run; bar.append(el('div', 'cur', 'من'), d1, el('div', 'cur', 'إلى'), d2, bT, bM, bG); sc.appendChild(bar);
    var out = el('div', 'ops-body'); sc.appendChild(out);
    function table(head, rows) {
      var t = el('div', 'dash-t'); var h = el('div', 'dash-r dash-h'); head.forEach(function (x) { h.appendChild(el('span', null, x)); }); t.appendChild(h);
      rows.forEach(function (r) { var rr = el('div', 'dash-r'); r.forEach(function (x) { rr.appendChild(el('span', null, String(x))); }); t.appendChild(rr); });
      return t;
    }
    function run() {
      out.textContent = '';
      rpc('dashboard', { p_from: d1.value, p_to: d2.value }).then(function (d) {
        var days = d.days || [], sum = function (k) { return days.reduce(function (a, x) { return a + Number(x[k]); }, 0); };
        var rev = sum('revenue'), cost = sum('cost'), exp = sum('expenses'), pr = sum('profit');
        var cards = el('div', 'dash-cards');
        [['الإيراد', rev], ['تكلفة الأصناف', cost], ['المصروفات', exp], ['صافي الربح', pr], ['هامش الربح', rev ? Math.round(pr / rev * 100) + '%' : '—']].forEach(function (c, i) {
          var cd = el('div', 'dash-card' + (i === 3 ? ' hi' : '')); cd.append(el('div', 'dash-k', c[0]), el('div', 'dash-v', typeof c[1] === 'number' ? Math.round(c[1]) + ' جنيه' : c[1])); cards.appendChild(cd);
        });
        out.appendChild(cards);
        out.appendChild(el('div', 'muted', 'اليوم التجاري بتوقيت ' + d.tz + ' ويبدأ الساعة ' + d.day_start_hour + ':00. التكلفة بتتحسب من الوصفات أو تكلفة الصنف، والأصناف بدون تكلفة بتتحسب صفر.'));
        var mx = Math.max.apply(null, days.map(function (x) { return Number(x.revenue); }).concat([1]));
        out.appendChild(el('div', 'name', 'يوم بيوم'));
        var dl = el('div', 'dash-t'); var hh = el('div', 'dash-r dash-h'); ['اليوم', 'غرف', 'مبيعات', 'مصروفات', 'تكلفة', 'ربح'].forEach(function (x) { hh.appendChild(el('span', null, x)); }); dl.appendChild(hh);
        days.forEach(function (x) {
          var rr = el('div', 'dash-r'); [x.day, x.rooms, x.sales, x.expenses, Math.round(x.cost), Math.round(x.profit)].forEach(function (v) { rr.appendChild(el('span', null, String(v))); });
          var bb = el('i', 'dash-bar'); bb.style.width = Math.round(Number(x.revenue) / mx * 100) + '%'; rr.appendChild(bb); dl.appendChild(rr);
        });
        out.appendChild(dl);
        out.appendChild(el('div', 'name', 'أعلى الأصناف مبيعاً'));
        out.appendChild(table(['الصنف', 'العدد', 'الإيراد', 'التكلفة'], (d.top_items || []).map(function (x) { return [x.name, x.qty, x.revenue, Math.round(x.cost)]; })));
        out.appendChild(el('div', 'name', 'أوقات الذروة (الإيراد حسب الساعة)'));
        var hm = Math.max.apply(null, (d.hours || []).map(function (x) { return Number(x.revenue); }).concat([1])), hb = el('div', 'dash-t');
        (d.hours || []).forEach(function (x) { var rr = el('div', 'dash-r'); rr.append(el('span', null, pad(x.hr) + ':00'), el('span', null, x.n + ' عملية'), el('span', null, x.revenue + ' جنيه')); var bb = el('i', 'dash-bar'); bb.style.width = Math.round(Number(x.revenue) / hm * 100) + '%'; rr.appendChild(bb); hb.appendChild(rr); });
        out.appendChild(hb);
        out.appendChild(el('div', 'name', 'حسب الغرفة'));
        out.appendChild(table(['الغرفة', 'جلسات', 'دقائق', 'الإيراد'], (d.rooms || []).map(function (x) { return [x.name, x.sessions, x.minutes, x.amount]; })));
        out.appendChild(el('div', 'name', 'حسب الكاشير'));
        out.appendChild(table(['الكاشير', 'عمليات', 'الإيراد'], (d.cashiers || []).map(function (x) { return [who(x.who), x.n, x.amount]; })));
        var ex = el('button', 'btn small ghost', 'تصدير CSV');
        ex.onclick = function () { csvDown('report-' + d1.value + '_' + d2.value + '.csv', [['اليوم', 'غرف', 'مبيعات', 'إيراد', 'مصروفات', 'تكلفة', 'ربح']].concat(days.map(function (x) { return [x.day, x.rooms, x.sales, x.revenue, x.expenses, x.cost, x.profit]; }))); };
        var fx = el('button', 'btn small ghost', 'نسخة احتياطية كاملة (JSON)');
        fx.onclick = function () { rpc('export_all').then(function (j) { var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' })); a.download = 'backup-' + ymd(new Date()) + '.json'; a.click(); toast('اتحملت النسخة'); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
        out.append(ex, fx);
      }).catch(function (e) { out.appendChild(el('div', 'muted', 'تعذر التحميل: ' + e.message)); });
    }
    run();
  }
  function bootOps() {
    var host = $('opsTab'); host.textContent = '';
    var admin = ROLE === 'admin', me = myEmail();
    var mi = el('input', 'mini-in'); mi.type = 'month'; mi.value = dayKey(new Date()).slice(0, 7);
    var top = el('div', 'row'); top.append(el('div', 'cur', 'الشهر'), mi); 
    if (admin) host.appendChild(top);
    var secA = sec(host, 'الحضور والانصراف'), secE = sec(host, 'مصروفات الوردية'), secV = sec(host, 'السلف');
    var run = function () { loadAtt(); loadExp(); loadAdv(); };
    mi.onchange = run;

    // ----- attendance
    function loadAtt() {
      secA.querySelectorAll('.ops-body').forEach(function (n) { n.remove(); });
      var body = el('div', 'ops-body'); secA.appendChild(body);
      var rg = monthRange(mi.value);
      var q = '/rest/v1/attendance?select=*&order=check_in.desc&limit=2000' + (admin ? '&check_in=gte.' + encodeURIComponent(rg[0]) + '&check_in=lt.' + encodeURIComponent(rg[1]) : '&limit=60');
      rpcGet(q).then(function (rows) {
        rows = rows || [];
        var mine = rows.find(function (r) { return r.staff_email === me && !r.check_out; });
        var st = el('div', 'cur', mine ? 'انت حاضر من ' + fmtT(mine.check_in) : 'انت مش مسجل حضور');
        var bIn = el('button', 'btn small', 'تسجيل حضور'), bOut = el('button', 'btn small warn', 'تسجيل انصراف');
        gate(bIn, 'attendance'); gate(bOut, 'attendance');
        if (mine) bIn.disabled = true; else bOut.disabled = true;
        bIn.onclick = function () { bIn.disabled = true; rpc('check_in').then(function () { toast('اتسجل حضورك'); bootOps(); }).catch(function (e) { toast('فشل: ' + e.message, true); bIn.disabled = false; }); };
        bOut.onclick = function () { bOut.disabled = true; rpc('check_out').then(function () { toast('اتسجل انصرافك'); bootOps(); }).catch(function (e) { toast('فشل: ' + e.message, true); bOut.disabled = false; }); };
        var bar = el('div', 'row'); bar.append(st, bIn, bOut); body.appendChild(bar);
        if (!admin) {
          rows.slice(0, 10).forEach(function (r) { body.appendChild(el('div', 'cur', dayKey(r.check_in) + ' · ' + fmtT(r.check_in) + ' → ' + fmtT(r.check_out))); });
          return;
        }
        var by = {}; rows.forEach(function (r) { (by[r.staff_email] = by[r.staff_email] || []).push(r); });
        var csv = [['الموظف', 'اليوم', 'حضور', 'انصراف', 'ساعات']];
        Object.keys(by).sort().forEach(function (em) {
          var days = {}, tot = 0;
          by[em].forEach(function (r) {
            var h = r.check_out ? (new Date(r.check_out) - new Date(r.check_in)) / 3600000 : 0; tot += h;
            days[dayKey(r.check_in)] = (days[dayKey(r.check_in)] || 0) + h;
            csv.push([who(em), dayKey(r.check_in), fmtT(r.check_in), r.check_out ? fmtT(r.check_out) : '', h.toFixed(2)]);
          });
          var box = el('div', 'ops-emp'); box.appendChild(el('div', 'name', who(em) + ' · ' + Object.keys(days).length + ' يوم · ' + tot.toFixed(1) + ' ساعة في الشهر'));
          by[em].forEach(function (r) {
            var row = el('div', 'row ops-rec');
            var h = r.check_out ? ((new Date(r.check_out) - new Date(r.check_in)) / 3600000).toFixed(1) + ' س' : 'لسه موجود';
            row.appendChild(el('div', 'cur', dayKey(r.check_in) + ' · ' + h + (r.edited_by ? ' · معدّل' : '')));
            var i1 = el('input', 'mini-in'); i1.type = 'datetime-local'; i1.value = localInput(r.check_in);
            var i2 = el('input', 'mini-in'); i2.type = 'datetime-local'; i2.value = localInput(r.check_out);
            var sv = el('button', 'btn small ghost', 'حفظ التعديل');
            sv.onclick = function () { rpc('attendance_set', { p_id: r.id, p_email: null, p_in: new Date(i1.value).toISOString(), p_out: i2.value ? new Date(i2.value).toISOString() : null, p_note: null })
              .then(function () { toast('اتعدل'); loadAtt(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
            row.append(i1, i2, sv); box.appendChild(row);
          });
          body.appendChild(box);
        });
        if (!rows.length) body.appendChild(el('div', 'muted', 'مفيش تسجيلات الشهر ده'));
        var ex = el('button', 'btn small ghost', 'تصدير CSV'); ex.onclick = function () { csvDown('attendance-' + mi.value + '.csv', csv); }; body.appendChild(ex);
        // manual add
        rpc('staff_names').then(function (names) {
          var add = el('div', 'row'); add.appendChild(el('div', 'cur', 'إضافة حضور نسيه الموظف'));
          var sel = el('select', 'mini-s'); (names || []).forEach(function (n) { var o = el('option', null, who(n)); o.value = n; sel.appendChild(o); });
          var a1 = el('input', 'mini-in'); a1.type = 'datetime-local'; var a2 = el('input', 'mini-in'); a2.type = 'datetime-local';
          var b = el('button', 'btn small', 'إضافة');
          b.onclick = function () { if (!a1.value) { toast('اكتب وقت الحضور', true); return; }
            rpc('attendance_set', { p_id: null, p_email: sel.value, p_in: new Date(a1.value).toISOString(), p_out: a2.value ? new Date(a2.value).toISOString() : null, p_note: 'manual' })
              .then(function () { toast('اتضاف'); loadAtt(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
          add.append(sel, a1, a2, b); body.appendChild(add);
        }).catch(function () {});
      }).catch(function (e) { body.appendChild(el('div', 'muted', 'تعذر التحميل: ' + e.message)); });
    }

    // ----- expenses
    function loadExp() {
      secE.querySelectorAll('.ops-body').forEach(function (n) { n.remove(); });
      var body = el('div', 'ops-body'); secE.appendChild(body);
      rpcGet('/rest/v1/shifts?select=id,label&closed_at=is.null&order=id.desc&limit=1').then(function (sh) {
        var shift = sh && sh[0];
        if (!shift) { body.appendChild(el('div', 'muted', 'مفيش وردية مفتوحة. افتح وردية من صفحة الغرف الأول.')); return; }
        var f = el('div', 'row'); f.appendChild(el('div', 'cur', 'مصروف جديد في الوردية ' + (shift.label || '#' + shift.id) + (admin || !CFG.expenseCap ? '' : ' · الحد ' + CFG.expenseCap + ' جنيه للمرة')));
        var am = el('input', 'price-in'); am.inputMode = 'numeric'; am.placeholder = 'المبلغ';
        var rs = el('input', 'm-in'); rs.placeholder = 'السبب (مثال: ثلج، منظفات)'; rs.maxLength = 120;
        var b = el('button', 'btn small', 'سجّل المصروف'); gate(b, 'expense');
        b.onclick = function () {
          var v = digits(am.value)[0]; if (!(v > 0) || rs.value.trim().length < 2) { toast('المبلغ والسبب مطلوبين', true); return; }
          b.disabled = true;
          var eop = uid();
          rpc('log_expense', { p_amount: v, p_reason: rs.value.trim(), p_op: eop }).then(function () { toast('اتسجل المصروف'); loadExp(); }).catch(function (e) {
            if (e.offline) { enqueue({ type: 'expense', op: eop, amount: v, reason: rs.value.trim() }); toast('أوفلاين: المصروف اتحفظ وهيتسجّل لما النت يرجع', true); b.disabled = false; return; }
            toast('فشل: ' + e.message, true); b.disabled = false; });
        };
        f.append(am, rs, b); body.appendChild(f);
        rpcGet('/rest/v1/expenses?select=*&shift_id=eq.' + shift.id + '&order=id.desc').then(function (rows) {
          var tot = 0;
          (rows || []).forEach(function (x) {
            if (!x.voided_at) tot += x.amount;
            var row = el('div', 'row' + (x.voided_at ? ' oos' : ''));
            row.appendChild(el('div', 'cur', fmtT(x.at) + ' · ' + who(x.actor) + ' · ' + x.reason + (x.voided_at ? ' · ملغي: ' + x.void_reason : '')));
            row.appendChild(el('div', 'name', x.amount + ' جنيه'));
            if (admin && !x.voided_at) {
              var vb = el('button', 'btn small ghost danger', 'إلغاء');
              vb.onclick = function () { var r = prompt('سبب إلغاء المصروف؟'); if (!r || r.trim().length < 2) return;
                rpc('void_expense', { p_id: x.id, p_reason: r.trim() }).then(function () { toast('اتلغى'); loadExp(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); };
              row.appendChild(vb);
            }
            body.appendChild(row);
          });
          body.appendChild(el('div', 'bill-row total', 'إجمالي مصروفات الوردية: ' + tot + ' جنيه (بيتخصم من النقدية المتوقعة عند قفل الوردية)'));
        });
      });
    }

    // ----- advances
    function loadAdv() {
      secV.querySelectorAll('.ops-body').forEach(function (n) { n.remove(); });
      var body = el('div', 'ops-body'); secV.appendChild(body);
      var rg = monthRange(mi.value);
      rpcGet('/rest/v1/advances?select=*&order=id.desc&limit=2000').then(function (rows) {
        rows = (rows || []).filter(function (r) { return !r.voided_at; });
        var bal = {}, inMonth = {};
        rows.forEach(function (r) {
          var sgn = r.kind === 'repay' ? -1 : 1; bal[r.staff_email] = (bal[r.staff_email] || 0) + sgn * r.amount;
          if (r.at >= rg[0] && r.at < rg[1]) inMonth[r.staff_email] = (inMonth[r.staff_email] || 0) + sgn * r.amount;
        });
        var addRow = function (names) {
          var f = el('div', 'row'); f.appendChild(el('div', 'cur', 'تسجيل سلفة'));
          var sel = el('select', 'mini-s'); names.forEach(function (n) { var o = el('option', null, who(n)); o.value = n; sel.appendChild(o); });
          var am = el('input', 'price-in'); am.inputMode = 'numeric'; am.placeholder = 'المبلغ';
          var nt = el('input', 'm-in'); nt.placeholder = 'ملاحظة'; nt.maxLength = 100;
          var kind = el('select', 'mini-s'); [['advance', 'سلفة'], ['repay', 'خصم من المرتب (سداد)']].forEach(function (o) { if (o[0] === 'repay' && !admin) return; var op = el('option', null, o[1]); op.value = o[0]; kind.appendChild(op); });
          var b = el('button', 'btn small', 'سجّل'); gate(b, 'advance');
          b.onclick = function () { var v = digits(am.value)[0]; if (!(v > 0)) { toast('اكتب المبلغ', true); return; }
            b.disabled = true; rpc('give_advance', { p_email: sel.value, p_amount: v, p_note: nt.value, p_kind: kind.value }).then(function () { toast('اتسجل'); loadAdv(); }).catch(function (e) { toast('فشل: ' + e.message, true); b.disabled = false; }); };
          f.append(sel, am, nt, kind, b); body.insertBefore(f, body.firstChild);
        };
        if (can('advance')) rpc('staff_names').then(addRow).catch(function () {});
        var mine = el('div', 'cur', 'رصيد سلفك: ' + (bal[me] || 0) + ' جنيه'); if (!admin) body.appendChild(mine);
        if (admin) {
          var csv = [['الموظف', 'رصيد السلف المتبقي', 'صافي الشهر']];
          var tb = el('div', 'ops-emp'); tb.appendChild(el('div', 'name', 'أرصدة السلف (السلف − المسدد) وصافي حركة الشهر'));
          Object.keys(bal).sort().forEach(function (em) {
            tb.appendChild(el('div', 'cur', who(em) + ' · الرصيد ' + bal[em] + ' جنيه · الشهر ' + (inMonth[em] || 0) + ' جنيه'));
            csv.push([who(em), bal[em], inMonth[em] || 0]);
          });
          if (!Object.keys(bal).length) tb.appendChild(el('div', 'muted', 'مفيش سلف مسجلة'));
          body.appendChild(tb);
          var ex = el('button', 'btn small ghost', 'تصدير CSV'); ex.onclick = function () { csvDown('advances-' + mi.value + '.csv', csv); }; body.appendChild(ex);
        }
        rows.slice(0, 40).forEach(function (r) {
          var row = el('div', 'row');
          row.appendChild(el('div', 'cur', dayKey(r.at) + ' · ' + who(r.staff_email) + ' · ' + (r.kind === 'repay' ? 'سداد ' : 'سلفة ') + r.amount + ' جنيه' + (r.note ? ' · ' + r.note : '') + ' · بواسطة ' + who(r.actor)));
          if (admin) { var vb = el('button', 'btn small ghost danger', 'إلغاء');
            vb.onclick = function () { var x = prompt('سبب الإلغاء؟'); if (!x || x.trim().length < 2) return; rpc('void_advance', { p_id: r.id, p_reason: x.trim() }).then(function () { toast('اتلغى'); loadAdv(); }).catch(function (e) { toast('فشل: ' + e.message, true); }); }; row.appendChild(vb); }
          body.appendChild(row);
        });
      }).catch(function (e) { body.appendChild(el('div', 'muted', 'تعذر التحميل: ' + e.message)); });
    }
    run();
  }

  // ---------- settings (admin only) ----------
  var PRESETS = [
    { n: 'نيلي (افتراضي)', primary: '#22d3ee', accent: '#f472b6', bg: '#080c15', surface: '#121a2c', text: '#eaf0ff' },
    { n: 'دهبي', primary: '#f5c800', accent: '#d9774a', bg: '#17100b', surface: '#221810', text: '#f7eddc' },
    { n: 'زمردي', primary: '#34d399', accent: '#fbbf24', bg: '#06120e', surface: '#0e1f19', text: '#e9fff6' },
    { n: 'وردي', primary: '#fb7185', accent: '#fbbf24', bg: '#140a0e', surface: '#22121a', text: '#fff1f4' },
    { n: 'بنفسجي', primary: '#818cf8', accent: '#f472b6', bg: '#0b0b1a', surface: '#15152b', text: '#eef0ff' },
    { n: 'فاتح', primary: '#0891b2', accent: '#f59e0b', bg: '#f1f5f9', surface: '#ffffff', text: '#0f172a' }
  ];
  var themeAction = null; // null = leave the stored theme alone, 'set' = save the pickers, 'reset' = clear to the originals
  function buildPresets() {
    var host = $('sPresets'); if (!host || host.firstChild) return;
    var rb = el('button', 'preset'); rb.type = 'button'; rb.appendChild(el('span', null, 'الألوان الأصلية'));
    rb.style.background = 'repeating-linear-gradient(45deg,#2a2f3d 0 8px,#1b1f2b 8px 16px)';
    rb.onclick = function () { themeAction = 'reset'; toast('هترجع ألوان المنيو والأدمن الأصلية (اضغط حفظ الإعدادات)'); };
    host.appendChild(rb);
    ['sPrimary', 'sAccent', 'sBg', 'sSurface', 'sText'].forEach(function (id) { $(id).addEventListener('input', function () { themeAction = 'set'; }); });
    PRESETS.forEach(function (p) {
      var b = el('button', 'preset'); b.type = 'button'; b.title = p.n;
      b.style.background = 'linear-gradient(135deg,' + p.bg + ' 0 50%,' + p.primary + ' 50% 75%,' + p.accent + ' 75%)';
      b.appendChild(el('span', null, p.n));
      b.onclick = function () { themeAction = 'set'; $('sPrimary').value = p.primary; $('sAccent').value = p.accent; $('sBg').value = p.bg; $('sSurface').value = p.surface; $('sText').value = p.text; toast('اتختار: ' + p.n + ' (اضغط حفظ)'); };
      host.appendChild(b);
    });
  }
  function bootPerms() {
    var host = $('sPerms'); if (!host) return; host.textContent = '';
    PERMS.forEach(function (p) {
      var L = el('label', 'chk perm-row'), c = el('input'); c.type = 'checkbox'; c.dataset.perm = p[0]; c.checked = p[0] === 'advance' ? (CFG.perms || {})[p[0]] === true : (CFG.perms || {})[p[0]] !== false;
      L.append(c, document.createTextNode(p[1])); host.appendChild(L);
    });
    var hist = $('sPermHist'); if (hist) {
      rpcGet('/rest/v1/settings_audit?select=at,actor,detail&order=id.desc&limit=8').then(function (rows) {
        hist.textContent = '';
        (rows || []).forEach(function (r) {
          var f = r.detail.from || {}, t = r.detail.to || {}, ch = [];
          PERMS.forEach(function (p) { var a = f[p[0]] !== false, b = t[p[0]] !== false; if (a !== b) ch.push(p[1] + (b ? ' ✓' : ' ✗')); });
          hist.appendChild(el('div', 'cur', new Date(r.at).toLocaleString('ar-EG') + ' · ' + String(r.actor).split('@')[0] + ' · ' + (ch.join('، ') || 'بدون تغيير')));
        });
      }).catch(function () {});
    }
  }
  function rpcGet(path) { return withAuth(function () { return api(path); }); }
  // receipt logo: converted in the browser to a black-and-white (1-bit look) PNG, max 300px wide, so thermal printers print it sharp
  var rcImg = '';
  function drawRcLogo() { var p = $('sRcLogoPrev'); if (!p) return; p.hidden = !rcImg; if (rcImg) p.src = rcImg; }
  function toBW(src, cb) {
    var im = new Image();
    im.onload = function () {
      var w = Math.min(300, im.naturalWidth || 300), h = Math.max(1, Math.round(w * (im.naturalHeight || 1) / (im.naturalWidth || 1)));
      if (h > 200) { h = 200; w = Math.max(1, Math.round(h * (im.naturalWidth || 1) / (im.naturalHeight || 1))); }
      var c = document.createElement('canvas'); c.width = w; c.height = h; var x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(im, 0, 0, w, h);
      var d = x.getImageData(0, 0, w, h), a = d.data;
      for (var i = 0; i < a.length; i += 4) { var v = (a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114) < 170 ? 0 : 255; a[i] = a[i + 1] = a[i + 2] = v; a[i + 3] = 255; }
      x.putImageData(d, 0, 0); cb(c.toDataURL('image/png'));
    };
    im.onerror = function () { toast('الصورة مش مقروءة (PNG أو JPG أو SVG)', true); };
    im.src = src;
  }
  // ---------- settings: every setting is a choice (select / checkboxes); saved custom values stay selectable ----------
  var TZS = [['Africa/Cairo', 'القاهرة'], ['Asia/Riyadh', 'الرياض'], ['Asia/Dubai', 'دبي'], ['Asia/Kuwait', 'الكويت'], ['Asia/Qatar', 'قطر'], ['Asia/Bahrain', 'البحرين'], ['Asia/Baghdad', 'بغداد'], ['Asia/Amman', 'عمّان'], ['Asia/Beirut', 'بيروت'], ['Africa/Casablanca', 'الدار البيضاء'], ['Africa/Tunis', 'تونس'], ['Africa/Algiers', 'الجزائر'], ['Africa/Khartoum', 'الخرطوم'], ['Europe/Istanbul', 'إسطنبول'], ['Europe/London', 'لندن'], ['Europe/Paris', 'باريس'], ['America/New_York', 'نيويورك'], ['UTC', 'UTC']];
  var CURS = ['جنيه', 'ج.م', 'EGP', 'ريال', 'ر.س', 'SAR', 'درهم', 'AED', 'دينار', 'KWD', '$', '€', '£'].map(function (x) { return [x, x]; });
  var T_OPTS = [['فردي', 'فردي'], ['زوجي', 'زوجي'], ['2 يد', '2 يد'], ['4 يد', '4 يد'], ['Single', 'Single'], ['Multi', 'Multi'], ['2P', '2P'], ['4P', '4P']];
  var SUBS = [['إيصال', 'إيصال'], ['فاتورة', 'فاتورة'], ['Receipt', 'Receipt'], ['Invoice', 'Invoice'], ['', 'بدون عنوان فرعي']];
  var FOOTS = [['شكراً لزيارتكم', 'شكراً لزيارتكم'], ['نورتونا', 'نورتونا'], ['بالهنا والشفا', 'بالهنا والشفا'], ['منتظرينكم تاني', 'منتظرينكم تاني'], ['Thank you for visiting', 'Thank you for visiting'], ['', 'بدون رسالة']];
  var HOURS = []; for (var hh = 0; hh <= 12; hh++) HOURS.push([String(hh), hh === 0 ? 'منتصف الليل (12 ص)' : hh === 12 ? '12 الظهر' : hh + ' ص']);
  var CAPS = [['0', 'بدون حد'], ['50', '50'], ['100', '100'], ['200', '200'], ['300', '300'], ['500', '500'], ['1000', '1000'], ['2000', '2000'], ['5000', '5000'], ['10000', '10000']];
  var TYPE_PRE = [['ps4', 'PS4'], ['ps5', 'PS5'], ['vip', 'VIP'], ['xbox', 'Xbox'], ['pc', 'PC'], ['billiard', 'بلياردو'], ['pingpong', 'بينج بونج'], ['foosball', 'فوتبول'], ['vr', 'VR']];
  var SHIFT_PRE = ['صباحي', 'مسائي', 'ليلي', 'الصباح', 'المساء', 'Morning', 'Evening', 'Night'];
  function fillSel(id, opts, cur) {
    var sel = $(id); if (!sel) return; sel.textContent = '';
    cur = String(cur == null ? '' : cur);
    var has = opts.some(function (o) { return o[0] === cur; });
    var all = has ? opts : opts.concat([[cur, cur + ' (الحالي)']]);
    all.forEach(function (o) { var op = document.createElement('option'); op.value = o[0]; op.textContent = o[1]; sel.appendChild(op); });
    sel.value = cur;
  }
  function chips(boxId, taId, presets, parse, fmt) {
    var box = $(boxId), ta = $(taId); if (!box || !ta) return;
    var cur = ta.value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean).map(parse);
    var all = presets.slice();
    cur.forEach(function (c) { if (!all.some(function (a) { return a.k === c.k; })) all.push(c); });
    box.textContent = '';
    all.forEach(function (a) {
      var l = document.createElement('label'); l.className = 'chip';
      var c = document.createElement('input'); c.type = 'checkbox'; c.dataset.k = a.k; c.checked = cur.some(function (x) { return x.k === a.k; });
      var sp = document.createElement('span'); sp.textContent = a.label;
      l.append(c, sp); box.appendChild(l);
      c.onchange = function () {
        ta.value = all.filter(function (x) { var cb = box.querySelector('input[data-k="' + x.k.replace(/"/g, '') + '"]'); return cb && cb.checked; }).map(fmt).join('\n');
      };
    });
  }
  function enhanceSettings() {
    var rc = CFG.receipt || {};
    fillSel('sCur', CURS, CFG.currency); fillSel('sT2', T_OPTS, tierLabel(2)); fillSel('sT4', T_OPTS, tierLabel(4));
    fillSel('sTz', TZS, CFG.tz); fillSel('sDayStart', HOURS, CFG.dayStart); fillSel('sExpCap', CAPS, CFG.expenseCap);
    fillSel('sSub', SUBS, rc.subtitle); fillSel('sFoot', FOOTS, rc.footer);
    chips('sTypesBox', 'sTypes', TYPE_PRE.map(function (t) { return { k: t[0], label: t[1], id: t[0] }; }),
      function (l) { var p = l.split('|'); var id = (p[0] || '').trim().toLowerCase(); return { k: id, id: id, label: (p[1] || p[0] || '').trim() }; },
      function (x) { return x.id + '|' + x.label; });
    chips('sShiftsBox', 'sShifts', SHIFT_PRE.map(function (n) { return { k: n, label: n }; }),
      function (l) { return { k: l, label: l }; }, function (x) { return x.label; });
  }
  function bootSettings() {
    buildPresets(); bootPerms(); themeAction = null;
    var b = CFG.brand, t = CFG.theme || {}, rc = CFG.receipt;
    $('sName').value = b.name; $('sLogo').value = b.logo_url || '';
    $('sPrimary').value = t.primary || '#22d3ee'; $('sAccent').value = t.accent || '#f472b6'; $('sBg').value = t.bg || '#080c15'; $('sSurface').value = t.surface || '#121a2c'; $('sText').value = t.text || '#eaf0ff';
    $('sExpCap').value = CFG.expenseCap; $('sTz').value = CFG.tz; $('sDayStart').value = CFG.dayStart; $('sRcW').value = String(CFG.rcWidth); $('sRep').value = CFG.reprice ? 'all' : 'from_now'; $('sT2').value = tierLabel(2); $('sT4').value = tierLabel(4); $('sDir').value = CFG.dir; $('sCur').value = CFG.currency;
    $('sRcLogo').checked = !!rc.logo; rcImg = rc.logo_img || ''; drawRcLogo(); $('sSub').value = rc.subtitle; $('sFoot').value = rc.footer; $('sExtra').value = rc.extra || '';
    $('sTypes').value = CFG.room_types.map(function (x) { return x.id + '|' + x.label; }).join('\n');
    $('sShifts').value = CFG.shifts.join('\n'); $('sLabels').value = CFG.labels || ''; enhanceSettings();
  }
  $('sRcLogoFile').onchange = function () {
    var f = this.files && this.files[0]; if (!f) return;
    if (f.size > 2000000) { toast('الصورة كبيرة (الحد 2 ميجا)', true); return; }
    var r = new FileReader(); r.onload = function () { toBW(r.result, function (u) { rcImg = u; $('sRcLogo').checked = true; drawRcLogo(); }); }; r.readAsDataURL(f);
  };
  $('sRcLogoEvo').onclick = function () { toBW('../assets/evo-logo-bw.svg', function (u) { rcImg = u; $('sRcLogo').checked = true; drawRcLogo(); }); };
  $('sRcLogoClear').onclick = function () { rcImg = ''; $('sRcLogo').checked = false; drawRcLogo(); };
  $('sPermSave').onclick = function () {
    var o = {}; document.querySelectorAll('#sPerms input[data-perm]').forEach(function (c) { o[c.dataset.perm] = c.checked; });
    $('sPermSave').disabled = true;
    rpc('set_cashier_perms', { p: o }).then(function () { CFG.perms = o; toast('صلاحيات الكاشير اتحفظت'); bootPerms(); })
      .catch(function (e) { toast('فشل: ' + e.message, true); }).then(function () { $('sPermSave').disabled = false; });
  };
  $('sSave').onclick = function () {
    var types = $('sTypes').value.split('\n').map(function (l) { var p = l.split('|'); return { id: (p[0] || '').trim().toLowerCase(), label: (p[1] || p[0] || '').trim() }; })
      .filter(function (x) { return /^[a-z0-9_-]{1,20}$/.test(x.id) && x.label; });
    if (!types.length) { toast('لازم نوع غرفة واحد على الأقل (مثال: vip|VIP)', true); return; }
    if (/^https?:/.test($('sLogo').value.trim()) && !/^https:/.test($('sLogo').value.trim())) { toast('رابط اللوجو لازم https', true); return; }
    var val = { brand: { name: $('sName').value.trim().slice(0, 40) || 'Cafe', logo_url: $('sLogo').value.trim() },
      // a theme is written ONLY when the admin picked/changed colors (or pressed reset, which clears it); otherwise the stored value is kept untouched
      theme: themeAction === 'reset' ? {} : themeAction === 'set' ? { primary: $('sPrimary').value, accent: $('sAccent').value, bg: $('sBg').value, surface: $('sSurface').value, text: $('sText').value } : (CFG.theme || {}),
      reprice_elapsed: $('sRep').value === 'all',
      cashier_perms: CFG.perms || {}, tz: $('sTz').value.trim() || 'Africa/Cairo', day_start_hour: Math.max(0, Math.min(12, Number($('sDayStart').value) || 0)), expense_cap: Math.max(0, Math.min(100000, Number($('sExpCap').value) || 0)),
      tiers: { '2': $('sT2').value.trim().slice(0, 20) || 'فردي', '4': $('sT4').value.trim().slice(0, 20) || 'زوجي' },
      dir: $('sDir').value, currency: $('sCur').value.trim().slice(0, 12) || 'جنيه',
      receipt: { subtitle: $('sSub').value.trim(), footer: $('sFoot').value.trim(), extra: $('sExtra').value.trim(), logo: $('sRcLogo').checked && !!rcImg, logo_img: rcImg, width: Number($('sRcW').value) === 58 ? 58 : 80 },
      room_types: types, shifts: $('sShifts').value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 12),
      labels: $('sLabels').value.slice(0, 2000) };
    $('sSave').disabled = true;
    withAuth(function () { return api('/rest/v1/app_settings', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ key: 'config', value: val, updated_at: new Date().toISOString() }) }); })
      .then(function () { toast('الإعدادات اتحفظت'); setTimeout(function () { location.reload(); }, 700); })
      .catch(function (e) { toast('فشل الحفظ: ' + e.message, true); })
      .then(function () { $('sSave').disabled = false; });
  };

  // ---------- staff accounts (admin only) ----------
  function rpc(fn, args) { return withAuth(function () { return api('/rest/v1/rpc/' + fn, { method: 'POST', body: JSON.stringify(args || {}) }); }); }
  function bootStaff() {
    var host = $('staffList'); host.textContent = '';
    rpc('staff_list').then(function (rows) {
      if (!rows || !rows.length) host.appendChild(el('div', 'muted', 'مفيش موظفين لسه. ضيف أول كاشير من فوق.'));
      (rows || []).forEach(function (u) {
        var card = el('div', 'room' + (u.active ? '' : ' off'));
        var top = el('div', 'r-top');
        var nm = el('span', 'r-name', u.username); nm.style.direction = 'ltr';
        top.append(nm, el('span', 'r-state ' + (u.active ? 'free' : 'paused'), u.active ? 'شغّال' : 'موقوف'));
        card.appendChild(top);
        var pw = el('input', 'mini-in wide'); pw.type = 'password'; pw.placeholder = 'باسورد جديد (8+)'; pw.autocomplete = 'new-password'; pw.dir = 'ltr';
        var rs = el('button', 'btn small ghost', 'غيّر الباسورد');
        rs.onclick = function () {
          if (pw.value.length < 8) { toast('الباسورد 8 حروف على الأقل', true); return; }
          rs.disabled = true;
          rpc('staff_reset_password', { p_username: u.username, p_password: pw.value })
            .then(function () { pw.value = ''; toast('الباسورد اتغيّر وتم تسجيل خروجه'); })
            .catch(function (e) { toast('فشل: ' + e.message, true); }).then(function () { rs.disabled = false; });
        };
        var row = el('div', 'r-add'); row.append(pw, rs); card.appendChild(row);
        var tg = el('button', 'btn small ghost', u.active ? 'إيقاف الحساب' : 'تشغيل الحساب');
        tg.onclick = function () {
          tg.disabled = true;
          rpc('staff_set_active', { p_username: u.username, p_active: !u.active })
            .then(function () { toast(u.active ? 'الحساب اتوقف' : 'الحساب اشتغل'); bootStaff(); })
            .catch(function (e) { toast('فشل: ' + e.message, true); tg.disabled = false; });
        };
        var dl = el('button', 'btn small ghost danger', 'حذف الحساب');
        dl.onclick = function () {
          if (!confirm('حذف ' + u.username + ' نهائيًا؟')) return;
          dl.disabled = true;
          rpc('staff_delete', { p_username: u.username })
            .then(function () { toast('اتحذف'); bootStaff(); })
            .catch(function (e) { toast('فشل: ' + e.message, true); dl.disabled = false; });
        };
        var r2 = el('div', 'r-adj'); r2.append(tg, dl); card.appendChild(r2);
        host.appendChild(card);
      });
    }).catch(function (e) { toast('فشل تحميل الموظفين: ' + e.message, true); });
  }
  $('staffAdd').onclick = function () {
    var u = $('staffUser').value.trim().toLowerCase(), p = $('staffPass').value;
    if (!/^[a-z0-9._-]{3,20}$/.test(u)) { toast('اسم المستخدم: 3-20 حرف إنجليزي/أرقام', true); return; }
    if (p.length < 8) { toast('الباسورد 8 حروف على الأقل', true); return; }
    $('staffAdd').disabled = true;
    rpc('staff_create', { p_username: u, p_password: p })
      .then(function () { $('staffUser').value = ''; $('staffPass').value = ''; toast('الكاشير اتضاف'); bootStaff(); })
      .catch(function (e) { toast('فشل: ' + e.message, true); })
      .then(function () { $('staffAdd').disabled = false; });
  };

  $('obSummary').onclick = manualSummary;
  paintBanner();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () {});
  setTimeout(flushQ, 1500);

  // ---------- boot ----------
  function boot() {
    show('items');
    loadCfg();
    rpc('staff_role').then(function (role) {
      ROLE = role === 'admin' ? 'admin' : 'staff';
      document.body.classList.toggle('role-staff', ROLE === 'staff');
      document.body.classList.toggle('role-admin', ROLE === 'admin');
      if (ROLE === 'staff') { pick('Rooms'); bootRooms(); return; }
      pick('Menu');
      return Promise.all([loadMenu(), loadOverrides()]).then(function (parts) { render(parts[0], parts[1]); });
    })
      .catch(function (e) { toast('فشل التحميل: ' + e.message, true); if (e.status === 401) { clearSes(); show('login'); } });
  }
  loadCfg();
  if (ses && ses.access_token) {
    // cheap validity check: try a read with the token; on 401 refresh once
    rpc('staff_role')
      .then(boot)
      .catch(function () { clearSes(); show('login'); });
  } else show('login');
})();
