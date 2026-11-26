// EVO customer menu from the database (tables menu_categories / menu_items, settings theme).
// Runs before the other page scripts: it renders the sections, then loads the rest in order.
// Opens fast from a localStorage cache; waits briefly for fresh data, falls back to the cache,
// and finally to the static HTML already in the page (the menu always opens).
(function () {
  var cfg = window.EVO_DATA || {};
  var SCRIPTS = ['features/data/data.js', 'features/nav/nav.js', 'features/menu/photos.config.js', 'features/menu/menu.js',
    'features/contact/contact.config.js', 'features/contact/contact.js', 'features/cart/cart.js'];
  var KEY = 'evo-menu-cache-v1';

  function loadScripts() {
    SCRIPTS.forEach(function (s) { var e = document.createElement('script'); e.src = s; e.async = false; document.body.appendChild(e); });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeImg(u) { return /^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : ''; }

  function applyTheme(c) {
    var th = (c && c.theme) || {}, r = document.documentElement.style;
    var map = { primary: '--brand', accent: '--accent', bg: '--bg', surface: '--surface', text: '--text' };
    Object.keys(map).forEach(function (k) {
      if (/^#[0-9a-f]{6}$/i.test(th[k] || '')) r.setProperty(map[k], th[k]); else r.removeProperty(map[k]);
    });
    if (/^#[0-9a-f]{6}$/i.test(th.primary || '')) {
      r.setProperty('--brand-deep', 'color-mix(in srgb, ' + th.primary + ' 82%, #000)');
      r.setProperty('--line-strong', 'color-mix(in srgb, ' + th.primary + ' 35%, transparent)');
    }
    if (/^#[0-9a-f]{6}$/i.test(th.surface || '')) r.setProperty('--surface-2', 'color-mix(in srgb, ' + th.surface + ' 88%, #fff)');
    if (/^#[0-9a-f]{6}$/i.test(th.text || '')) {
      r.setProperty('--text-soft', 'color-mix(in srgb, ' + th.text + ' 72%, ' + (th.bg || '#000') + ')');
      r.setProperty('--line', 'color-mix(in srgb, ' + th.text + ' 12%, transparent)');
    }
    var m = document.querySelector('meta[name=theme-color]'); if (m && th.bg) m.setAttribute('content', th.bg);
    if (c && c.brand && c.brand.name) document.title = c.brand.name;
  }

  function priceHtml(p) {
    if (!p || !p.length) return '';
    return '<div class="item-price">' + p[0] + (p.length > 1 ? '<span class="price-unit">/' + p.slice(1).join('/') + '</span>' : '') + '</div>';
  }
  function render(d) {
    var all = document.getElementById('all'), tabs = document.getElementById('navTabs');
    if (!all || !tabs) return false;
    document.querySelectorAll('.section:not(#all)').forEach(function (s) { s.remove(); });
    tabs.querySelectorAll('.nav-tab:not(:first-child)').forEach(function (t) { t.remove(); });
    var prev = all, n = 0;
    d.cats.filter(function (c) { return !c.hidden; }).sort(function (a, b) { return a.sort - b.sort; }).forEach(function (c) {
      var rows = d.items.filter(function (i) { return i.category_id === c.id && !i.hidden; }).sort(function (a, b) { return a.sort - b.sort || a.id - b.id; });
      if (!rows.length) return;
      n++;
      var h = '<div class="sec-header"><div class="sec-num">' + String(n).padStart(2, '0') + '</div><div class="sec-title-wrap"><div class="sec-title-en">' + esc(c.name_en) + '</div><div class="sec-title-ar">' + esc(c.name_ar) + '</div></div></div>';
      var open = null, out = '';
      function close() { if (open) { out += '</div>'; open = null; } }
      rows.forEach(function (i) {
        if (i.kind === 'sub') { close(); out += '<div class="sub-group"><span class="sub-group-label">' + esc(i.name) + '</span><div class="sub-group-line"></div></div>'; return; }
        var want = i.kind === 'extra' ? 'extras-grid' : 'items-list';
        if (open !== want) { close(); out += '<div class="' + want + '">'; open = want; }
        var oos = i.out_of_stock ? ' oos' : '';
        if (i.kind === 'extra') { out += '<div class="extra-pill' + oos + '"><span>' + esc(i.name) + '</span>' + priceHtml(i.prices) + '</div>'; return; }
        var img = safeImg(i.image_url);
        out += '<div class="item' + (i.highlight ? ' highlight-item' : '') + oos + (img ? ' has-img' : '') + '">' +
          (img ? '<img class="item-img" src="' + esc(img) + '" alt="" loading="lazy">' : '') +
          '<div class="item-left"><div class="item-name">' + esc(i.name) + '</div>' + (i.descr ? '<div class="item-desc">' + esc(i.descr) + '</div>' : '') +
          (i.out_of_stock ? '<span class="oos-badge">خلص</span>' : '') + '</div>' + priceHtml(i.prices) + '</div>';
      });
      close();
      var sec = document.createElement('section'); sec.className = 'section'; sec.id = c.id; sec.innerHTML = h + out;
      prev.after(sec); prev = sec;
      var b = document.createElement('button'); b.className = 'nav-tab';
      b.setAttribute('onclick', "showSection('" + c.id + "',this)");
      var ico = document.getElementById('i-' + c.id) ? 'i-' + c.id : 'i-all';
      b.innerHTML = '<svg class="ico" aria-hidden="true"><use href="#' + ico + '"/></svg>' + esc(c.name_ar);
      tabs.appendChild(b);
    });
    window.__evoMenuDB = true;
    return true;
  }

  var cache = null;
  try { cache = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (cache) { applyTheme(cache.cfg); }

  function get(path, ms) {
    var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, ms);
    return fetch(cfg.url.replace(/\/$/, '') + path, { headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey }, signal: ctl.signal })
      .then(function (r) { clearTimeout(to); if (!r.ok) throw new Error(r.status); return r.json(); });
  }
  function go(d) {
    try { if (d && d.cats && d.cats.length) render(d); } catch (e) { /* keep static menu */ }
    loadScripts();
  }
  if (!cfg.url || !cfg.anonKey) { loadScripts(); return; }
  var ms = cache ? 1500 : 4000;
  Promise.all([get('/rest/v1/menu_categories?select=*&order=sort', ms), get('/rest/v1/menu_items?select=*&order=sort&limit=2000', ms),
    get('/rest/v1/app_settings?key=eq.config&select=value', ms).catch(function () { return null; })])
    .then(function (p) {
      var d = { cats: p[0], items: p[1], cfg: p[2] && p[2][0] ? p[2][0].value : (cache && cache.cfg) || null, ts: Date.now() };
      try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (e) {}
      applyTheme(d.cfg); go(d);
    })
    .catch(function () { go(cache); });
})();
