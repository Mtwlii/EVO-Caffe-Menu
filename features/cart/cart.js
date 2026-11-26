(function () {
  var WA = ((window.EVO_CONTACT || {}).whatsapp || '').replace(/\D/g, '');
  if (!WA) return; // ordering needs a WhatsApp number in contact.config.js
  var CUR = 'جنيه';
  var cart = {}; // key -> {name, price, note, qty}
  try { cart = JSON.parse(localStorage.getItem('evo-cart2') || '{}'); } catch (e) {}
  var info = { type: 'طاولة', num: '', who: '', note: '' };
  try { info = Object.assign(info, JSON.parse(localStorage.getItem('evo-info') || '{}')); } catch (e) {}
  // Per-room QR: /?room=CODE preselects the room for the order.
  try {
    var qroom = new URLSearchParams(location.search).get('room');
    if (qroom && /^[0-9A-Za-z\u0600-\u06FF-]{1,10}$/.test(qroom)) { info.type = 'غرفة'; info.num = qroom; localStorage.setItem('evo-info', JSON.stringify(info)); }
  } catch (e) {}

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function key(n, p, note) { return n + '|' + p + '|' + (note || ''); }
  function save() { try { localStorage.setItem('evo-cart2', JSON.stringify(cart)); localStorage.setItem('evo-info', JSON.stringify(info)); } catch (e) {} }
  function count() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k].qty; }, 0); }
  function total() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k].qty * cart[k].price; }, 0); }
  function qtyOf(name, price) { return Object.keys(cart).reduce(function (a, k) { var l = cart[k]; return a + (l.name === name && l.price === price ? l.qty : 0); }, 0); }
  function add(name, price, d, note) {
    note = (note || '').trim();
    var k = key(name, price, note), l = cart[k] || (cart[k] = { name: name, price: price, note: note, qty: 0 });
    l.qty += d; if (l.qty <= 0) delete cart[k];
    save(); refresh();
  }
  function quickMinus(name, price) { // remove one from the most recent line of this item
    var ks = Object.keys(cart).filter(function (k) { return cart[k].name === name && cart[k].price === price; });
    if (ks.length) add(name, price, -1, cart[ks[ks.length - 1]].note);
  }

  // ---------- controls on every menu item ----------
  function decorate() {
    document.querySelectorAll('.item, .extra-pill, .f-card').forEach(function (it) {
      if (it.querySelector('.qty')) return;
      var nameEl = it.querySelector('.item-name'), priceEl = it.querySelector('.item-price');
      var name = (nameEl ? nameEl.firstChild.textContent : it.firstElementChild.textContent).trim();
      if (!priceEl) return;
      var nums = (priceEl.textContent.match(/\d+/g) || []).map(Number);
      if (!nums.length) return;
      var descEl = it.querySelector('.item-desc'), desc = descEl ? descEl.textContent.trim() : '';
      var box = el('div', 'qty'); box.dataset.name = name;
      nums.forEach(function (p) {
        var c = el('div', 'qty-c'); c.dataset.price = p;
        if (nums.length > 1) c.appendChild(el('span', 'qty-p', p));
        var minus = el('button', 'q-btn q-minus', '−'); minus.setAttribute('aria-label', 'إنقاص');
        var n = el('span', 'q-n', '0');
        var plus = el('button', 'q-btn q-plus', '+'); plus.setAttribute('aria-label', 'إضافة ' + name);
        minus.onclick = function (e) { e.stopPropagation(); quickMinus(name, p); };
        plus.onclick = function (e) { e.stopPropagation(); add(name, p, 1); };
        c.append(minus, n, plus); box.appendChild(c);
      });
      if (nums.length > 1) it.classList.add('dual');
      it.appendChild(box);
      var open = it.querySelector('.item-left') || nameEl || it.firstElementChild;
      if (open) { open.classList.add('tap'); open.onclick = function () { openDetail(name, nums, desc); }; }
    });
  }

  // ---------- sheet ----------
  var sheet = el('div', 'sheet'); sheet.hidden = true;
  var back = el('div', 'sheet-back'), body = el('div', 'sheet-body');
  body.setAttribute('role', 'dialog'); body.setAttribute('aria-modal', 'true');
  sheet.append(back, body); document.body.appendChild(sheet);
  var bar = el('button', 'cart-bar'); bar.hidden = true; document.body.appendChild(bar);

  function head(title, onBack) {
    var h = el('div', 'sheet-head');
    if (onBack) { var b = el('button', 'sheet-back-btn', '→'); b.setAttribute('aria-label', 'رجوع'); b.onclick = onBack; h.appendChild(b); }
    h.appendChild(el('strong', null, title));
    var x = el('button', 'sheet-x', '×'); x.setAttribute('aria-label', 'إغلاق'); x.onclick = closeSheet; h.appendChild(x);
    return h;
  }
  function show(nodes) { body.textContent = ''; nodes.forEach(function (n) { body.appendChild(n); }); sheet.hidden = false; document.body.classList.add('sheet-open'); body.scrollTop = 0; }
  function closeSheet() { sheet.hidden = true; document.body.classList.remove('sheet-open'); }
  back.onclick = closeSheet;
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !sheet.hidden) closeSheet(); });

  // D: item detail
  function openDetail(name, prices, desc) {
    var state = { p: prices[0], q: 1 };
    var nodes = [head(name)];
    if (desc) nodes.push(el('div', 'd-desc', desc));
    var sizes = el('div', 'd-prices');
    function price() { return el('div', 'd-price', state.p + ' ' + CUR); }
    var priceBox = el('div', 'd-row');
    priceBox.append(el('span', 'd-lbl', 'السعر'), price());
    nodes.push(priceBox);
    if (prices.length > 1) {
      prices.forEach(function (p) {
        var b = el('button', 'chip' + (p === state.p ? ' on' : ''), p + ' ' + CUR);
        b.onclick = function () { state.p = p; sizes.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c === b); }); upd(); };
        sizes.appendChild(b);
      });
      nodes.push(sizes);
    }
    var q = el('div', 'd-row'), st = el('div', 'stepper'), qn = el('span', 'q-n on', '1');
    var m = el('button', 'q-btn', '−'), pl = el('button', 'q-btn', '+');
    m.onclick = function () { if (state.q > 1) { state.q--; upd(); } }; pl.onclick = function () { state.q++; upd(); };
    st.append(pl, qn, m); q.append(el('span', 'd-lbl', 'الكمية'), st); nodes.push(q);
    var note = el('input'); note.placeholder = 'ملاحظة على الصنف (اختياري) مثال: بدون سكر'; note.setAttribute('aria-label', 'ملاحظة على الصنف'); note.maxLength = 80;
    nodes.push(note);
    var go = el('button', 'send'); nodes.push(go);
    function upd() { qn.textContent = state.q; go.textContent = 'أضف إلى الطلب · ' + state.q * state.p + ' ' + CUR; }
    go.onclick = function () { add(name, state.p, state.q, note.value); closeSheet(); toast('تمت إضافة ' + name); };
    upd(); show(nodes);
  }

  // Step 1: cart
  function openCart() {
    if (!count()) return;
    var nodes = [head('طلبك')], L = el('div', 'sheet-lines');
    Object.keys(cart).forEach(function (k) {
      var l = cart[k], row = el('div', 'line'), top = el('div', 'line-top');
      var inf = el('div', 'l-info'); inf.append(el('div', 'l-name', l.name), el('div', 'l-sub', l.price + ' ' + CUR));
      var st = el('div', 'stepper'), m = el('button', 'q-btn', '−'), p = el('button', 'q-btn', '+');
      m.onclick = function () { add(l.name, l.price, -1, l.note); if (count()) openCart(); }; p.onclick = function () { add(l.name, l.price, 1, l.note); openCart(); };
      st.append(p, el('span', 'q-n on', l.qty), m);
      top.append(inf, st, el('div', 'l-sum', l.qty * l.price));
      var n = el('input', 'l-note'); n.placeholder = 'ملاحظة على الصنف'; n.value = l.note; n.maxLength = 80; n.setAttribute('aria-label', 'ملاحظة على ' + l.name);
      n.onchange = function () { // re-key the line with the new note
        var nn = n.value.trim(); if (nn === l.note) return;
        delete cart[k]; var k2 = key(l.name, l.price, nn);
        if (cart[k2]) cart[k2].qty += l.qty; else cart[k2] = { name: l.name, price: l.price, note: nn, qty: l.qty };
        save(); refresh(); openCart();
      };
      row.append(top, n); L.appendChild(row);
    });
    nodes.push(L);
    var tot = el('div', 'sheet-total'); tot.append(el('span', null, 'الإجمالي'), el('span', 't-val', total() + ' ' + CUR)); nodes.push(tot);
    var next = el('button', 'send', 'متابعة'); next.onclick = openDetails; nodes.push(next);
    var clr = el('button', 'clear', 'مسح الطلب'); clr.onclick = function () { cart = {}; save(); refresh(); closeSheet(); }; nodes.push(clr);
    show(nodes);
  }

  // Step 2: where + send
  function message() {
    var lines = ['طلب جديد من منيو EVO', info.type + ' رقم: ' + info.num.trim()];
    if (info.who.trim()) lines.push('الاسم: ' + info.who.trim());
    lines.push('');
    Object.keys(cart).forEach(function (k) {
      var l = cart[k]; lines.push(l.qty + ' × ' + l.name + ' (' + l.price + ') = ' + l.qty * l.price);
      if (l.note) lines.push('   ملاحظة: ' + l.note);
    });
    lines.push('', 'الإجمالي: ' + total() + ' ' + CUR);
    if (info.note.trim()) lines.push('ملاحظات: ' + info.note.trim());
    return lines.join('\n');
  }
  window.__evoOrderUrl = function () { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(message()); };

  function openDetails() {
    var nodes = [head('بيانات الطلب', openCart)];
    var seg = el('div', 'seg'), num = el('input'), err = el('div', 'place-err', 'اكتب رقم الطاولة أو الغرفة الأول'), send = el('button', 'send', 'أرسل الطلب على واتساب');
    err.hidden = true; num.id = 'placeNum'; num.inputMode = 'numeric'; num.autocomplete = 'off'; num.value = info.num;
    ['طاولة', 'غرفة'].forEach(function (t) {
      var b = el('button', info.type === t ? 'on' : '', t); b.onclick = function () { info.type = t; save(); seg.querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); }); num.placeholder = 'رقم ' + t + ' (مطلوب)'; };
      seg.appendChild(b);
    });
    num.placeholder = 'رقم ' + info.type + ' (مطلوب)'; num.setAttribute('aria-label', 'رقم الطاولة أو الغرفة');
    var place = el('div', 'place'); place.append(seg, num);
    var who = el('input'); who.id = 'who'; who.placeholder = 'الاسم (اختياري)'; who.value = info.who; who.maxLength = 40; who.setAttribute('aria-label', 'الاسم');
    var note = el('input'); note.id = 'orderNote'; note.placeholder = 'ملاحظات على الطلب (اختياري)'; note.value = info.note; note.maxLength = 120; note.setAttribute('aria-label', 'ملاحظات');
    var sum = el('div', 'sheet-total'); sum.append(el('span', null, count() + ' صنف'), el('span', 't-val', total() + ' ' + CUR));
    function ok() { return num.value.trim().length > 0; }
    function sync() { send.disabled = !ok(); }
    num.oninput = function () { info.num = num.value; save(); err.hidden = true; sync(); };
    who.oninput = function () { info.who = who.value; save(); }; note.oninput = function () { info.note = note.value; save(); };
    send.onclick = function () {
      if (!ok()) { err.hidden = false; num.focus(); return; }
      if (!(window.EVO_CONTACT || {}).autoOrder) { window.open(window.__evoOrderUrl(), '_blank', 'noopener'); openDone(false); return; }
      send.disabled = true; send.textContent = 'جاري الإرسال...';
      // Order tracking (milestone 2): id + per-order key let the customer follow status.
      var oid = null, okey = null;
      try {
        oid = crypto.randomUUID();
        var rb = new Uint8Array(8); crypto.getRandomValues(rb);
        okey = Array.prototype.map.call(rb, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
      } catch (e) { oid = null; okey = null; }
      var payload = { type: info.type, num: info.num.trim(), who: info.who.trim(), note: info.note.trim(), id: oid, key: okey,
        items: Object.keys(cart).map(function (k) { return { name: cart[k].name, price: cart[k].price, qty: cart[k].qty, note: cart[k].note }; }) };
      var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, 10000);
      fetch('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctl.signal })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok && j.ok, tracked: !!j.tracked }; }); })
        .catch(function () { return { ok: false, tracked: false }; })
        .then(function (res2) {
          clearTimeout(to);
          var trackUrl = res2.ok && res2.tracked && oid ? 'order.html?id=' + oid + '&key=' + okey : null;
          openDone(res2.ok ? 'auto' : 'failed', trackUrl);
        });
    };
    nodes.push(sum, place, err, who, note, send); sync(); show(nodes);
  }

  // Success screen
  function openDone(mode, trackUrl) {
    var nodes = [head('جهزنا طلبك')];
    var ok = el('div', 'done-mark'); ok.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>';
    nodes.push(ok);
    nodes.push(el('div', 'done-t', mode === 'auto' ? 'طلبك وصل للكافيه' : mode === 'failed' ? 'مقدرناش نبعت الطلب تلقائي. ابعته من واتساب' : 'اضغط "إرسال" في واتساب عشان الطلب يوصل للكافيه'));
    nodes.push(el('div', 'done-s', info.type + ' رقم ' + info.num.trim() + ' · ' + count() + ' صنف · ' + total() + ' ' + CUR));
    if (mode !== 'auto') { var again = el('button', 'send', mode === 'failed' ? 'ابعت على واتساب' : 'فتح واتساب تاني'); again.onclick = function () { window.open(window.__evoOrderUrl(), '_blank', 'noopener'); }; nodes.push(again); }
    if (trackUrl) { var track = el('button', 'send', 'تابع حالة طلبك'); track.onclick = function () { location.href = trackUrl; }; nodes.push(track); }
    var fin = el('button', 'clear strong', mode === 'failed' ? 'بعتّه، طلب جديد' : mode === 'auto' ? 'طلب جديد' : 'تم الإرسال، طلب جديد'); fin.onclick = function () { cart = {}; info.note = ''; save(); refresh(); closeSheet(); toast('الطلب اتمسح، تقدر تطلب تاني'); }; nodes.push(fin);
    var keep = el('button', 'clear', 'رجوع للمنيو (الطلب يفضل محفوظ)'); keep.onclick = closeSheet; nodes.push(keep);
    show(nodes);
  }

  // toast
  var tm, tEl = el('div', 'toast'); tEl.hidden = true; document.body.appendChild(tEl);
  function toast(t) { tEl.textContent = t; tEl.hidden = false; clearTimeout(tm); tm = setTimeout(function () { tEl.hidden = true; }, 1800); }

  function refresh() {
    document.querySelectorAll('.qty-c').forEach(function (c) {
      var q = qtyOf(c.parentNode.dataset.name, Number(c.dataset.price));
      c.querySelector('.q-n').textContent = q; c.classList.toggle('on', q > 0);
    });
    var n = count();
    bar.hidden = !n; document.body.classList.toggle('has-cart', n > 0);
    bar.innerHTML = '<span class="cb-n">' + n + '</span><span>عرض الطلب</span><span class="cb-t">' + total() + ' ' + CUR + '</span>';
    if (!n && !sheet.hidden && body.querySelector('.sheet-lines')) closeSheet();
  }
  bar.onclick = openCart;
  // Wait for menu overrides (prices, out-of-stock) before decorating, when the
  // data layer is configured; otherwise decorate immediately as before.
  (window.__evoDataReady || Promise.resolve()).then(function () { decorate(); refresh(); });
})();
