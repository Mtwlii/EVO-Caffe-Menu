(function () {
  var WA = ((window.EVO_CONTACT || {}).whatsapp || '').replace(/\D/g, '');
  if (!WA) return; // ordering needs a WhatsApp number in contact.config.js
  var CUR = 'جنيه';
  var cart = {}; // key -> {name, price, qty}
  try { cart = JSON.parse(localStorage.getItem('evo-cart') || '{}'); } catch (e) {}
  var place = { type: 'طاولة', num: '', note: '' };
  try { place = Object.assign(place, JSON.parse(localStorage.getItem('evo-place') || '{}')); } catch (e) {}

  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function key(n, p) { return n + '|' + p; }
  function save() { try { localStorage.setItem('evo-cart', JSON.stringify(cart)); localStorage.setItem('evo-place', JSON.stringify(place)); } catch (e) {} }
  function count() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k].qty; }, 0); }
  function total() { return Object.keys(cart).reduce(function (a, k) { return a + cart[k].qty * cart[k].price; }, 0); }
  function change(name, price, d) {
    var k = key(name, price), l = cart[k] || (cart[k] = { name: name, price: price, qty: 0 });
    l.qty += d; if (l.qty <= 0) delete cart[k];
    save(); refresh();
  }

  // Controls on every menu item (works for the All view and featured clones too)
  function decorate() {
    document.querySelectorAll('.item, .extra-pill, .f-card').forEach(function (it) {
      if (it.querySelector('.qty')) return;
      var nameEl = it.querySelector('.item-name'), priceEl = it.querySelector('.item-price');
      var name = (nameEl ? nameEl.firstChild.textContent : it.firstElementChild.textContent).trim();
      if (!priceEl) return;
      var nums = (priceEl.textContent.match(/\d+/g) || []).map(Number);
      if (!nums.length) return;
      var box = el('div', 'qty'); box.dataset.name = name;
      nums.forEach(function (p) {
        var c = el('div', 'qty-c'); c.dataset.price = p;
        if (nums.length > 1) c.appendChild(el('span', 'qty-p', p));
        var minus = el('button', 'q-btn q-minus', '−'); minus.setAttribute('aria-label', 'إنقاص');
        var n = el('span', 'q-n', '0');
        var plus = el('button', 'q-btn q-plus', '+'); plus.setAttribute('aria-label', 'إضافة ' + name);
        minus.onclick = function () { change(name, p, -1); };
        plus.onclick = function () { change(name, p, 1); };
        c.append(minus, n, plus); box.appendChild(c);
      });
      if (nums.length > 1) it.classList.add('dual');
      it.appendChild(box);
    });
  }

  // UI shell
  var bar = el('button', 'cart-bar'); bar.hidden = true;
  var sheet = el('div', 'sheet'); sheet.hidden = true;
  sheet.innerHTML = '<div class="sheet-back"></div><div class="sheet-body" role="dialog" aria-label="طلبك">' +
    '<div class="sheet-head"><strong>طلبك</strong><button class="sheet-x" aria-label="إغلاق">×</button></div>' +
    '<div class="sheet-lines"></div>' +
    '<div class="sheet-total"><span>الإجمالي</span><span class="t-val"></span></div>' +
    '<div class="place"><div class="seg"><button data-t="طاولة">طاولة</button><button data-t="غرفة">غرفة</button></div>' +
    '<input id="placeNum" inputmode="numeric" autocomplete="off" placeholder="رقم الطاولة (مطلوب)" aria-label="رقم الطاولة أو الغرفة"></div>' +
    '<div class="place-err" hidden>اكتب رقم الطاولة أو الغرفة الأول</div>' +
    '<input id="orderNote" placeholder="ملاحظات (اختياري)" aria-label="ملاحظات">' +
    '<button class="send" disabled>أرسل الطلب على واتساب</button>' +
    '<button class="clear">مسح الطلب</button></div>';
  document.body.append(bar, sheet);
  var $ = function (s) { return sheet.querySelector(s); };
  var num = $('#placeNum'), note = $('#orderNote'), send = $('.send'), err = $('.place-err');

  function valid() { return num.value.trim().length > 0; }
  function refresh() {
    document.querySelectorAll('.qty-c').forEach(function (c) {
      var k = key(c.parentNode.dataset.name, c.dataset.price), q = cart[k] ? cart[k].qty : 0;
      c.querySelector('.q-n').textContent = q;
      c.classList.toggle('on', q > 0);
    });
    var n = count();
    bar.hidden = !n; document.body.classList.toggle('has-cart', n > 0);
    bar.innerHTML = '<span class="cb-n">' + n + '</span><span>عرض الطلب</span><span class="cb-t">' + total() + ' ' + CUR + '</span>';
    var L = $('.sheet-lines'); L.textContent = '';
    Object.keys(cart).forEach(function (k) {
      var l = cart[k], row = el('div', 'line');
      var info = el('div', 'l-info'); info.append(el('div', 'l-name', l.name), el('div', 'l-sub', l.price + ' ' + CUR));
      var st = el('div', 'stepper');
      var m = el('button', 'q-btn', '−'), p = el('button', 'q-btn', '+');
      m.onclick = function () { change(l.name, l.price, -1); }; p.onclick = function () { change(l.name, l.price, 1); };
      st.append(m, el('span', 'q-n on', l.qty), p);
      row.append(info, st, el('div', 'l-sum', l.qty * l.price)); L.appendChild(row);
    });
    $('.t-val').textContent = total() + ' ' + CUR;
    send.disabled = !n || !valid();
    if (!n && !sheet.hidden) closeSheet();
  }
  function setType(t) {
    place.type = t; save();
    sheet.querySelectorAll('.seg button').forEach(function (b) { b.classList.toggle('on', b.dataset.t === t); });
    num.placeholder = 'رقم ' + t + ' (مطلوب)';
  }
  function openSheet() { sheet.hidden = false; document.body.classList.add('sheet-open'); num.value = place.num; note.value = place.note; setType(place.type); refresh(); }
  function closeSheet() { sheet.hidden = true; document.body.classList.remove('sheet-open'); }
  bar.onclick = openSheet;
  $('.sheet-x').onclick = closeSheet; $('.sheet-back').onclick = closeSheet;
  sheet.querySelectorAll('.seg button').forEach(function (b) { b.onclick = function () { setType(b.dataset.t); }; });
  num.oninput = function () { place.num = num.value; save(); err.hidden = true; send.disabled = !count() || !valid(); };
  note.oninput = function () { place.note = note.value; save(); };
  $('.clear').onclick = function () { cart = {}; save(); refresh(); };

  function message() {
    var lines = ['طلب جديد من منيو EVO', place.type + ' رقم: ' + num.value.trim(), ''];
    Object.keys(cart).forEach(function (k) { var l = cart[k]; lines.push(l.qty + ' × ' + l.name + ' (' + l.price + ') = ' + l.qty * l.price); });
    lines.push('', 'الإجمالي: ' + total() + ' ' + CUR);
    if (note.value.trim()) lines.push('ملاحظات: ' + note.value.trim());
    return lines.join('\n');
  }
  window.__evoOrderUrl = function () { return 'https://wa.me/' + WA + '?text=' + encodeURIComponent(message()); };
  send.onclick = function () {
    if (!valid()) { err.hidden = false; num.focus(); return; }
    if (!count()) return;
    window.open(window.__evoOrderUrl(), '_blank', 'noopener');
  };

  decorate(); refresh();
})();
