// EVO data layer: fetches menu overrides from Supabase and applies them to the
// page (price changes, out-of-stock, hidden). Resolves only after the DOM and
// the generated views (All tab, featured strip) exist, so every copy gets the
// override. The cart waits on window.__evoDataReady before decorating, so its
// quantity controls always use the final prices. No-ops cleanly when not
// configured or when the fetch fails - the static menu always keeps working.
(function () {
  var cfg = window.EVO_DATA || {};
  if (window.__evoMenuDB) return; // menu already comes from the database (hidden/out-of-stock/prices built in)
  if (!cfg.url || !cfg.anonKey) return; // window.__evoDataReady stays unset

  var domReady = new Promise(function (res) {
    if (document.readyState !== 'loading') res();
    else document.addEventListener('DOMContentLoaded', res);
  });

  var fetched = (function () {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 4000);
    return fetch(cfg.url.replace(/\/$/, '') + '/rest/v1/menu_overrides?select=*', {
      headers: { apikey: cfg.anonKey, authorization: 'Bearer ' + cfg.anonKey },
      signal: ctl.signal
    }).then(function (r) { clearTimeout(to); return r.ok ? r.json() : []; })
      .catch(function () { clearTimeout(to); return []; });
  })();

  window.__evoDataReady = Promise.all([fetched, domReady]).then(function (parts) {
    var byKey = {};
    (parts[0] || []).forEach(function (row) { byKey[row.item_key] = row; });
    applyAll(byKey);
    window.__evoOverrides = byKey;
  }).catch(function () { /* offline: static menu */ });

  function keyOf(el) {
    var nameEl = el.querySelector('.item-name'), priceEl = el.querySelector('.item-price');
    var name = nameEl ? nameEl.textContent.replace(/مميز/g, '').trim()
                      : (el.firstElementChild ? el.firstElementChild.textContent.trim() : '');
    var nums = priceEl ? (priceEl.textContent.match(/\d+/g) || []) : [];
    return name + '|' + nums.join('/');
  }
  function priceText(prices) {
    if (prices.length === 1) return String(prices[0]);
    return prices[0] + '<span class="price-unit">/' + prices.slice(1).join('/') + '</span>';
  }
  function applyAll(byKey) {
    document.querySelectorAll('.item, .extra-pill, .f-card').forEach(function (el) {
      var row = byKey[keyOf(el)];
      if (!row) return;
      if (Array.isArray(row.prices) && row.prices.length) {
        var clean = row.prices.map(Number).filter(function (n) { return n > 0; });
        var p = el.querySelector('.item-price');
        if (p && clean.length) p.innerHTML = priceText(clean);
      }
      if (row.out_of_stock) {
        el.classList.add('oos');
        var q = el.querySelector('.qty'); if (q) q.remove();
        if (!el.querySelector('.oos-badge')) {
          var b = document.createElement('span'); b.className = 'oos-badge'; b.textContent = 'خلص';
          (el.querySelector('.item-left') || el).appendChild(b);
        }
      }
      if (row.hidden) el.style.display = 'none';
    });
  }
})();
