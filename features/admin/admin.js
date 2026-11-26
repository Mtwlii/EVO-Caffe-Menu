// EVO admin dashboard (milestone 1): edit prices, mark out-of-stock, hide items.
// Reads the live menu page as the item source, reads/writes overrides in Supabase.
// Auth: Supabase email/password. Only a signed-in admin can write (RLS).
(function () {
  var cfg = window.EVO_DATA || {};
  var $ = function (id) { return document.getElementById(id); };
  if (!cfg.url || !cfg.anonKey) { $('configMsg').hidden = false; return; }
  var base = cfg.url.replace(/\/$/, '');

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
    return fetch(base + path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!r.ok) { var e = new Error((j && (j.message || j.error_description || j.error)) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
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
  $('loginBtn').onclick = function () {
    var btn = $('loginBtn'); btn.disabled = true; $('loginErr').hidden = true;
    api('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: $('email').value.trim(), password: $('password').value })
    }).then(function (j) { saveSes(j); boot(); })
      .catch(function (e) { $('loginErr').textContent = 'دخول فاشل: ' + e.message; $('loginErr').hidden = false; })
      .then(function () { btn.disabled = false; });
  };
  $('logout').onclick = function () { clearSes(); show('login'); };

  // ---------- menu source: parse the live menu page ----------
  function keyOf(name, prices) { return name + '|' + prices.join('/'); }
  function digits(s) { return (String(s).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).match(/\d+/g) || []).map(Number); }
  function norm(t) { return t.replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase().trim(); }

  function loadMenu() {
    return fetch('../').then(function (r) { return r.text(); }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var groups = [];
      doc.querySelectorAll('.section:not(#all)').forEach(function (sec) {
        var t = sec.querySelector('.sec-title-ar');
        var g = { id: sec.id, title: t ? t.textContent.trim() : sec.id, items: [] };
        sec.querySelectorAll('.item, .extra-pill').forEach(function (el) {
          var nameEl = el.querySelector('.item-name');
          var name = nameEl ? nameEl.textContent.trim() : (el.firstElementChild ? el.firstElementChild.textContent.trim() : '');
          var priceEl = el.querySelector('.item-price');
          var prices = priceEl ? digits(priceEl.textContent) : [];
          if (name && prices.length) g.items.push({ name: name, prices: prices, key: keyOf(name, prices) });
        });
        if (g.items.length) groups.push(g);
      });
      return groups;
    });
  }
  function loadOverrides() {
    return withAuth(function () { return api('/rest/v1/menu_overrides?select=*'); })
      .then(function (rows) { var m = {}; (rows || []).forEach(function (r) { m[r.item_key] = r; }); return m; });
  }

  // ---------- render ----------
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  var tm;
  function toast(t, bad) {
    var x = $('toast'); x.textContent = t; x.className = 'toast' + (bad ? ' bad' : ''); x.hidden = false;
    clearTimeout(tm); tm = setTimeout(function () { x.hidden = true; }, 2200);
  }

  var lastGroups = [], lastOverrides = {};
  function render(groups, overrides) {
    lastGroups = groups; lastOverrides = overrides;
    var host = $('groups'); host.textContent = '';
    var n = 0;
    groups.forEach(function (g) {
      var box = el('div', 'group'); box.appendChild(el('h3', null, g.title));
      g.items.forEach(function (it) {
        n++;
        var ov = overrides[it.key] || {};
        var row = el('div', 'row' + (ov.out_of_stock ? ' oos' : ''));
        row.dataset.key = it.key; row.dataset.name = norm(it.name);
        if (ov.hidden) row.dataset.hidden = '1';
        row.appendChild(el('div', 'name', it.name));
        row.appendChild(el('div', 'cur', 'الحالي: ' + (ov.prices || it.prices).join(' / ') + ' جنيه' + (ov.prices ? ' (الأصل: ' + it.prices.join(' / ') + ')' : '')));
        var eff = ov.prices || it.prices;
        var inputs = it.prices.map(function (_, i) {
          var inp = el('input', 'price-in'); inp.type = 'text'; inp.inputMode = 'numeric';
          inp.value = eff[i] != null ? eff[i] : it.prices[i];
          inp.setAttribute('aria-label', 'سعر ' + it.name + (it.prices.length > 1 ? ' ' + (i + 1) : ''));
          return inp;
        });
        inputs.forEach(function (inp) { row.appendChild(inp); });
        var oosL = el('label', 'chk'), oos = el('input'); oos.type = 'checkbox'; oos.checked = !!ov.out_of_stock;
        oosL.append(oos, document.createTextNode('خلصان')); row.appendChild(oosL);
        var hidL = el('label', 'chk'), hid = el('input'); hid.type = 'checkbox'; hid.checked = !!ov.hidden;
        hidL.append(hid, document.createTextNode('مخفي')); row.appendChild(hidL);
        var save = el('button', 'btn small', 'حفظ');
        save.onclick = function () {
          var vals = inputs.map(function (inp) { var d = digits(inp.value); return d.length ? d[0] : 0; });
          var changed = vals.some(function (v, i) { return v !== it.prices[i]; });
          if (vals.some(function (v) { return !(v > 0 && v <= 2000); })) { toast('السعر لازم يكون بين 1 و 2000', true); return; }
          save.disabled = true;
          var body = { item_key: it.key, prices: changed ? vals : null, out_of_stock: oos.checked, hidden: hid.checked, updated_at: new Date().toISOString() };
          withAuth(function () {
            return api('/rest/v1/menu_overrides', {
              method: 'POST',
              headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
              body: JSON.stringify(body)
            });
          }).then(function () {
            overrides[it.key] = body;
            row.classList.toggle('oos', oos.checked);
            row.dataset.hidden = hid.checked ? '1' : '';
            row.querySelector('.cur').textContent = 'الحالي: ' + (body.prices || it.prices).join(' / ') + ' جنيه' + (body.prices ? ' (الأصل: ' + it.prices.join(' / ') + ')' : '');
            toast('اتحفظ: ' + it.name);
          }).catch(function (e) { toast('فشل الحفظ: ' + e.message, true); })
            .then(function () { save.disabled = false; });
        };
        row.appendChild(save);
        box.appendChild(row);
      });
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
  var TYPE_AR = { ps4: 'فور', ps5: 'فايف' };
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
    var paper = el('div', 'receipt-paper');
    paper.appendChild(el('div', 'rc-brand', 'EVO Café'));
    paper.appendChild(el('div', 'rc-sub', 'إيصال'));
    paper.appendChild(el('div', 'rc-place', data.place));
    (data.meta || []).forEach(function (m) { var r = el('div', 'rc-row'); r.append(el('span', null, m[0]), el('span', null, m[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    (data.lines || []).forEach(function (l) { var r = el('div', 'rc-row' + (l[2] === 'sub' ? ' rc-subline' : '')); r.append(el('span', null, l[0]), el('span', null, l[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    (data.totals || []).forEach(function (l) { var r = el('div', 'rc-row' + (l[2] === 'total' ? ' rc-total' : '')); r.append(el('span', null, l[0]), el('span', null, l[1])); paper.appendChild(r); });
    paper.appendChild(el('div', 'rc-sep'));
    paper.appendChild(el('div', 'rc-thanks', 'شكراً لزيارتكم'));
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
      if (!open.length) return p.concat([[], []]);
      var ids = open.map(function (x) { return x.id; }).join(',');
      return withAuth(function () {
        return Promise.all([
          api('/rest/v1/room_session_segments?session_id=in.(' + ids + ')&select=*'),
          api('/rest/v1/session_items?session_id=in.(' + ids + ')&select=*&order=id')
        ]);
      }).then(function (extra) { return p.concat(extra); });
    });
  }

  function timeCostOf(segs, type, until) {
    var cost = 0;
    (segs || []).forEach(function (g) {
      var end = g.ended_at ? new Date(g.ended_at).getTime() : (until || Date.now());
      var mins = Math.max(0, (end - new Date(g.started_at).getTime()) / 60000);
      cost += mins / 60 * (RATES[type + '|' + g.controllers] || 0);
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
    clearTimers();
    RATES = {}; (rateRows || []).forEach(function (r) { RATES[r.room_type + '|' + r.controllers] = r.hourly_price; });
    var host = $('rooms'); host.textContent = '';

    // --- shift bar ---
    var shift = (openShift || [])[0] || null;
    var bar = el('div', 'shift-bar');
    if (shift) {
      bar.appendChild(el('span', 'shift-on', 'وردية مفتوحة: ' + (shift.label || ('#' + shift.id)) +
        ' · من ' + new Date(shift.opened_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })));
      var closeSh = el('button', 'btn small warn', 'قفل الوردية');
      closeSh.onclick = function () {
        closeSh.disabled = true;
        withAuth(function () { return api('/rest/v1/rpc/close_shift', { method: 'POST', body: '{}' }); })
          .then(function (rep) { showShiftReport('تقفيل الوردية ' + (shift.label || ''), rep); bootRooms(); })
          .catch(function (e) { toast('فشل قفل الوردية: ' + e.message, true); closeSh.disabled = false; });
      };
      bar.appendChild(closeSh);
    } else {
      var lbl = el('input', 'mini-in wide'); lbl.placeholder = 'اسم الوردية (صباحية / مسائية...)'; lbl.maxLength = 40;
      var openSh = el('button', 'btn small', 'فتح وردية');
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
      line.onclick = function () { showShiftReport(sh.label || ('وردية #' + sh.id), sh.report); };
      host.appendChild(line);
    });

    // --- rates editor ---
    var ratesBox = el('div', 'room rates');
    ratesBox.appendChild(el('div', 'r-title', 'أسعار الساعة'));
    var rateInputs = {};
    ['ps4', 'ps5'].forEach(function (t) {
      [2, 4].forEach(function (c) {
        var row = el('div', 'rate-row');
        row.appendChild(el('span', null, TYPE_AR[t] + ' · ' + c + ' إيد'));
        var inp = el('input', 'mini-in'); inp.inputMode = 'numeric';
        inp.value = RATES[t + '|' + c] != null ? RATES[t + '|' + c] : '';
        inp.setAttribute('aria-label', 'سعر ' + TYPE_AR[t] + ' ' + c + ' إيد');
        rateInputs[t + '|' + c] = inp;
        row.append(inp, el('span', 'muted', 'جنيه/ساعة'));
        ratesBox.appendChild(row);
      });
    });
    var saveRates = el('button', 'btn small', 'حفظ الأسعار');
    saveRates.onclick = function () {
      var body = Object.keys(rateInputs).map(function (k) {
        var d = digits(rateInputs[k].value);
        return { room_type: k.split('|')[0], controllers: Number(k.split('|')[1]), hourly_price: d.length ? d[0] : 0 };
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
      var top = el('div', 'r-top');
      top.appendChild(el('span', 'r-name', r.name + ' (' + TYPE_AR[r.room_type || 'ps4'] + ')'));
      top.appendChild(el('span', 'r-state ' + (ses ? 'busy' : 'free'), ses ? 'مشغولة' : 'فاضية'));
      card.appendChild(top);

      // room settings (name / code / type)
      var set = el('div', 'r-set');
      var nameIn = el('input', 'mini-in wide'); nameIn.value = r.name; nameIn.setAttribute('aria-label', 'اسم الغرفة');
      var codeIn = el('input', 'mini-in'); codeIn.value = r.code || ''; codeIn.placeholder = 'الكود'; codeIn.setAttribute('aria-label', 'كود الغرفة اللي الزبون يكتبه');
      var typeIn = el('select', 'mini-s');
      ['ps4', 'ps5'].forEach(function (t) { var op = el('option', null, TYPE_AR[t]); op.value = t; if ((r.room_type || 'ps4') === t) op.selected = true; typeIn.appendChild(op); });
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
      var qrBtn = el('button', 'btn small ghost', 'QR');
      qrBtn.onclick = function () { showQr(r); };
      if (!r.code) qrBtn.disabled = true;
      set.append(nameIn, codeIn, typeIn, saveRoom, qrBtn);
      card.appendChild(set);
      card.appendChild(el('div', 'muted small-note',
        'السعر دلوقتي: 2 إيد ' + (RATES[(r.room_type || 'ps4') + '|2'] || 0) + ' / 4 إيد ' + (RATES[(r.room_type || 'ps4') + '|4'] || 0) + ' جنيه في الساعة · كود الطلب: ' + (r.code || '—')));

      if (ses) {
        var sSegs = (segs || []).filter(function (g) { return g.session_id === ses.id; });
        var sItems = (items || []).filter(function (x) { return x.session_id === ses.id; });
        var openSeg = sSegs.find(function (g) { return !g.ended_at; });
        var timer = el('div', 'r-timer'), bill = el('div', 'r-bill');
        var disc = adjRow('خصم'), serv = adjRow('خدمة');
        function tick() {
          var tCost = timeCostOf(sSegs, ses.room_type || r.room_type || 'ps4');
          var iCost = itemsCostOf(sItems);
          var base = tCost + iCost;
          var d = adjCalc(disc.kind.value, digits(disc.val.value)[0], base);
          var sv = adjCalc(serv.kind.value, digits(serv.val.value)[0], base - d) ;
          if (serv.kind.value === 'amount') sv = Math.max(Number(digits(serv.val.value)[0]) || 0, 0);
          var ms = sSegs.reduce(function (a, g) { return a + (g.ended_at ? new Date(g.ended_at).getTime() : Date.now()) - new Date(g.started_at).getTime(); }, 0);
          timer.textContent = fmtDur(ms) + (openSeg ? ' · ' + openSeg.controllers + ' إيد' : ' · ⏸ متوقفة');
          var tot = Math.round(base - d + sv);
          bill.textContent = 'الوقت: ' + Math.round(tCost) + ' + الأصناف: ' + iCost +
            (d ? ' − خصم ' + d : '') + (sv ? ' + خدمة ' + sv : '') + ' = ' + tot + ' جنيه' +
            ((ses.deposit_amount || 0) ? ' · مدفوع مقدم ' + ses.deposit_amount + ' · الباقي ' + Math.max(tot - ses.deposit_amount, 0) : '');
        }
        tick(); roomTimers.push(setInterval(tick, 1000));
        card.append(timer, bill);

        // controller switch
        var sw = el('button', 'btn small ghost', openSeg && openSeg.controllers === 2 ? 'حوّل لـ 4 إيد' : 'حوّل لـ 2 إيد');
        sw.onclick = function () {
          sw.disabled = true;
          var to = openSeg && openSeg.controllers === 2 ? 4 : 2;
          withAuth(function () { return api('/rest/v1/rpc/switch_session_controllers', { method: 'POST', body: JSON.stringify({ p_session_id: ses.id, p_controllers: to }) }); })
            .then(function () { toast('اتحولت لـ ' + to + ' إيد'); bootRooms(); })
            .catch(function (e) { toast('فشل التحويل: ' + e.message, true); sw.disabled = false; });
        };
        if (!openSeg) { sw.disabled = true; }
        card.appendChild(sw);

        // pause / resume (no time billed while paused)
        var pz = el('button', 'btn small ghost', ses.paused_at ? 'كمّل الجلسة ▶' : 'إيقاف مؤقت ⏸');
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
        var depBtn = el('button', 'btn small ghost', 'سجّل المقدم');
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
        var carry = el('button', 'btn small ghost', ses.carried_over ? 'هينتقل للوردية الجاية ✓' : 'نقل للوردية الجاية');
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
          row.appendChild(el('span', null, x.qty + ' × ' + x.name + ' = ' + (x.qty * x.price) + ' جنيه' + (x.source === 'order' ? ' (من المنيو)' : '') +
            (x.voided_at ? ' · ملغي: ' + (x.void_reason || '') : '')));
          if (!x.voided_at) {
            var del = el('button', 'btn small ghost danger', 'إلغاء');
            del.onclick = function () {
              del.hidden = true;
              var why = el('input', 'mini-in wide'); why.placeholder = 'سبب الإلغاء (مطلوب)'; why.maxLength = 120; why.setAttribute('aria-label', 'سبب الإلغاء');
              var okb = el('button', 'btn small danger', 'تأكيد الإلغاء');
              okb.onclick = function () {
                var rs = why.value.trim();
                if (rs.length < 2) { toast('اكتب سبب الإلغاء', true); why.focus(); return; }
                okb.disabled = true;
                withAuth(function () { return api('/rest/v1/rpc/void_session_item', { method: 'POST', body: JSON.stringify({ p_item_id: x.id, p_reason: rs }) }); })
                  .then(function () { toast('اتلغى: ' + x.name); bootRooms(); })
                  .catch(function (e) { toast('فشل الإلغاء: ' + e.message, true); okb.disabled = false; });
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
        var add = el('button', 'btn small', 'ضيف');
        add.onclick = function () {
          var c = choices[Number(sel.value)]; var q = digits(qty.value)[0] || 1;
          if (!c) return;
          add.disabled = true;
          withAuth(function () {
            return api('/rest/v1/session_items', { method: 'POST', headers: { prefer: 'return=minimal' },
              body: JSON.stringify({ session_id: ses.id, name: c.name, price: c.price, qty: Math.min(Math.max(q, 1), 100), source: 'manual' }) });
          }).then(function () { toast('اتضاف: ' + c.name); bootRooms(); })
            .catch(function (e) { toast('فشل الإضافة: ' + e.message, true); add.disabled = false; });
        };
        addRow.append(sel, qty, add);
        card.appendChild(addRow);

        // discount / service + close
        var adjBox = el('div', 'r-adj');
        adjBox.append(disc.kind, disc.val, serv.kind, serv.val);
        card.appendChild(adjBox);

        var close = el('button', 'btn', 'إنهاء وتحصيل');
        close.onclick = function () {
          close.disabled = true;
          var rcItems = sItems.filter(function (x) { return !x.voided_at; });
          var rcSegs = sSegs.slice(); var startedAt = new Date(ses.started_at);
          var body = {
            p_session_id: ses.id,
            p_discount_kind: disc.kind.value || null, p_discount_value: digits(disc.val.value)[0] || 0,
            p_service_kind: serv.kind.value || null, p_service_value: digits(serv.val.value)[0] || 0
          };
          withAuth(function () { return api('/rest/v1/rpc/close_room_session', { method: 'POST', body: JSON.stringify(body) }); })
            .then(function (rep) {
              billModal('حساب ' + r.name, [
                ['الوقت (' + rep.minutes + ' دقيقة)', rep.time_amount + ' جنيه'],
                ['المشروبات والأصناف', rep.items_amount + ' جنيه'],
                rep.discount_amount ? ['الخصم', '− ' + rep.discount_amount + ' جنيه'] : null,
                rep.service_amount ? ['الخدمة', '+ ' + rep.service_amount + ' جنيه'] : null,
                ['الإجمالي', rep.total + ' جنيه', 'total'],
                rep.deposit ? ['مدفوع مقدم', '− ' + rep.deposit + ' جنيه'] : null,
                rep.deposit ? ['الباقي المطلوب', rep.remaining + ' جنيه', 'total'] : null
              ].filter(Boolean), (function () {
                var pb = el('button', 'btn ghost', 'اطبع الإيصال');
                pb.onclick = function () {
                  var now = Date.now();
                  var lines = [['الوقت (' + rep.minutes + ' دقيقة)', rep.time_amount + ' جنيه']];
                  if (rcSegs.length > 1) rcSegs.forEach(function (g) {
                    var m = Math.round(((g.ended_at ? new Date(g.ended_at).getTime() : now) - new Date(g.started_at).getTime()) / 60000);
                    if (m > 0) lines.push(['   ' + g.controllers + ' إيد · ' + m + ' د', '', 'sub']);
                  });
                  rcItems.forEach(function (x) { lines.push([x.qty + ' × ' + x.name, (x.qty * x.price) + ' جنيه']); });
                  var totals = (rep.discount_amount || rep.service_amount) ? [['المجموع', (rep.time_amount + rep.items_amount) + ' جنيه']] : [];
                  if (rep.discount_amount) totals.push(['الخصم', '− ' + rep.discount_amount + ' جنيه']);
                  if (rep.service_amount) totals.push(['الخدمة', '+ ' + rep.service_amount + ' جنيه']);
                  totals.push(['الإجمالي', rep.total + ' جنيه', 'total']);
                  if (rep.deposit) { totals.push(['مدفوع مقدم', '− ' + rep.deposit + ' جنيه']); totals.push(['الباقي', rep.remaining + ' جنيه', 'total']); }
                  showReceipt({ place: r.name + ' (' + TYPE_AR[r.room_type || 'ps4'] + ')',
                    meta: [['من', stamp(startedAt)], ['إلى', stamp(new Date(now))]], lines: lines, totals: totals });
                };
                return pb;
              })());
              bootRooms();
            })
            .catch(function (e) { toast('فشل الإنهاء: ' + e.message, true); close.disabled = false; });
        };
        card.appendChild(close);
      } else {
        var startRow = el('div', 'r-add');
        var ctlSel = el('select', 'mini-s');
        [2, 4].forEach(function (c) { var op = el('option', null, c + ' إيد'); op.value = c; ctlSel.appendChild(op); });
        var start = el('button', 'btn small', 'بدء جلسة');
        start.onclick = function () {
          start.disabled = true;
          withAuth(function () { return api('/rest/v1/rpc/start_room_session', { method: 'POST', body: JSON.stringify({ p_room_id: r.id, p_controllers: Number(ctlSel.value) }) }); })
            .then(function () { toast('بدأت الجلسة: ' + r.name); bootRooms(); })
            .catch(function (e) { toast('فشل البدء: ' + e.message, true); start.disabled = false; });
        };
        startRow.append(ctlSel, start);
        card.appendChild(startRow);
        if (!ses) {
          var delRoom = el('button', 'btn small ghost danger', 'حذف الغرفة');
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
    var addBox = el('div', 'room');
    addBox.appendChild(el('div', 'r-title', 'ضيف غرفة جديدة'));
    var nName = el('input', 'mini-in wide'); nName.placeholder = 'اسم الغرفة'; nName.maxLength = 40;
    var nCode = el('input', 'mini-in'); nCode.placeholder = 'الكود'; nCode.maxLength = 10;
    var nType = el('select', 'mini-s');
    ['ps4', 'ps5'].forEach(function (t) { var op = el('option', null, TYPE_AR[t]); op.value = t; nType.appendChild(op); });
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


  // ---------- QR per room: opens the menu with the room already selected ----------
  function showQr(r) {
    var url = location.origin + '/?room=' + encodeURIComponent(r.code);
    var ov = el('div', 'bill-ov'), box = el('div', 'bill-box qr-box');
    box.appendChild(el('h3', null, 'QR ' + r.name));
    var holder = el('div', 'qr-img');
    try {
      var q = qrcode(0, 'M'); q.addData(url); q.make();
      holder.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) { holder.textContent = 'مقدرتش أعمل QR'; }
    box.appendChild(holder);
    box.appendChild(el('div', 'qr-url', url));
    box.appendChild(el('div', 'muted small-note', 'الزبون يمسح الكود، المنيو بيفتح على ' + r.name + ' والطلب بينزل على حساب الجلسة'));
    var pr = el('button', 'btn small ghost', 'اطبع');
    pr.onclick = function () { document.body.classList.add('print-qr'); window.print(); document.body.classList.remove('print-qr'); };
    var ok = el('button', 'btn', 'تم'); ok.onclick = function () { ov.remove(); };
    box.append(pr, ok); ov.appendChild(box); document.body.appendChild(ov);
  }

  // ---------- audit log ----------
  var AUDIT_AR = { start: 'بدء جلسة', close: 'إنهاء وتحصيل', item_add: 'إضافة صنف', item_void: 'إلغاء صنف', deposit: 'مقدم',
    carry_over: 'نقل للوردية الجاية', pause: 'إيقاف مؤقت', resume: 'استئناف', controllers: 'تغيير الإيدي' };
  function auditText(a) {
    var d = a.detail || {};
    switch (a.action) {
      case 'item_add': return d.qty + ' × ' + d.name + ' (' + (d.source === 'order' ? 'طلب' : 'يدوي') + ')';
      case 'item_void': return d.qty + ' × ' + d.name + ' · السبب: ' + (d.reason || '');
      case 'deposit': return d.amount + ' جنيه';
      case 'close': return 'الإجمالي ' + d.total + (d.discount ? ' · خصم ' + d.discount : '') + (d.service ? ' · خدمة ' + d.service : '');
      case 'controllers': return d.from + ' ← ' + d.to + ' إيد';
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

  function showShiftReport(title, rep) {
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
    (rep.handed_over || []).forEach(function (h, i) {
      if (!i) lines.push(['جلسات اتنقلت للوردية الجاية:', '', 'sub']);
      lines.push([h.room + ' · ' + h.minutes + ' دقيقة · ' + (h.controllers || 2) + ' إيد', 'متراكم ' + h.subtotal + ' جنيه']);
    });
    billModal(title, lines);
  }

  function bootRooms() {
    loadRooms().then(function (p) { renderRooms(p[0] || [], p[1] || [], p[2] || [], p[3] || [], p[4] || [], p[5] || [], p[6] || []); })
      .catch(function (e) { toast('فشل تحميل الغرف: ' + e.message, true); });
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
  $('tabMenu').onclick = function () {
    $('tabMenu').classList.add('on'); $('tabRooms').classList.remove('on'); $('tabOrders').classList.remove('on');
    $('menuTab').hidden = false; $('roomsTab').hidden = true; $('ordersTab').hidden = true; clearTimers();
  };
  $('tabRooms').onclick = function () {
    $('tabRooms').classList.add('on'); $('tabMenu').classList.remove('on'); $('tabOrders').classList.remove('on');
    $('roomsTab').hidden = false; $('menuTab').hidden = true; $('ordersTab').hidden = true; bootRooms();
  };
  $('tabOrders').onclick = function () {
    $('tabOrders').classList.add('on'); $('tabMenu').classList.remove('on'); $('tabRooms').classList.remove('on');
    $('ordersTab').hidden = false; $('menuTab').hidden = true; $('roomsTab').hidden = true; clearTimers(); bootOrders();
  };

  // ---------- boot ----------
  function boot() {
    show('items');
    Promise.all([loadMenu(), loadOverrides()])
      .then(function (parts) { render(parts[0], parts[1]); })
      .catch(function (e) { toast('فشل التحميل: ' + e.message, true); if (e.status === 401) { clearSes(); show('login'); } });
  }
  if (ses && ses.access_token) {
    // cheap validity check: try a read with the token; on 401 refresh once
    withAuth(function () { return api('/rest/v1/menu_overrides?select=item_key&limit=1'); })
      .then(boot)
      .catch(function () { clearSes(); show('login'); });
  } else show('login');
})();
