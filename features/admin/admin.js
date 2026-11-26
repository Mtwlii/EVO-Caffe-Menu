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

  function render(groups, overrides) {
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
