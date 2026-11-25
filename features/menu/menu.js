(function () {
  var star = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.200l2.600 5.600 6.100.7-4.500 4.200 1.200 6L12 16.600 6.600 19.700l1.200-6L3.300 9.500l6.100-.7z"/></svg>';
  document.querySelectorAll('.highlight-item .item-name').forEach(function (n) {
    n.insertAdjacentHTML('beforeend', '<span class="badge">' + star + 'مميز</span>');
  });
})();
(function () {
  // "All" view is generated from the category sections: one source of truth.
  var all = document.getElementById('all'), html = '';
  document.querySelectorAll('.section:not(#all)').forEach(function (sec) {
    var ar = sec.querySelector('.sec-title-ar'), head = sec.querySelector('.sec-header'), body = '';
    for (var n = head.nextElementSibling; n; n = n.nextElementSibling) body += n.outerHTML;
    html += '<div class="all-section-block"><div class="all-section-title"><svg class="ico" aria-hidden="true"><use href="#i-' + sec.id + '"/></svg>' + ar.textContent + '</div>' + body + '</div>';
  });
  all.innerHTML = html;
})();
(function () {
  // Featured strip from items the owner already marked as highlighted
  var seen = {}, cards = '';
  document.querySelectorAll('.section:not(#all) .highlight-item').forEach(function (el) {
    var name = el.querySelector('.item-name').textContent.trim();
    if (seen[name]) return; seen[name] = 1;
    var cat = el.closest('.section').querySelector('.sec-title-ar');
    cards += '<div class="f-card"><span class="f-cat">' + (cat ? cat.textContent : '') + '</span>' + el.innerHTML.replace('item-left', 'item-left').replace(/^/, '') + '</div>';
  });
  if (cards) {
    var f = document.createElement('section');
    f.className = 'featured';
    f.innerHTML = '<div class="featured-title">اختيارات ايفو</div><div class="featured-sub">الأصناف المميزة في المنيو</div><div class="featured-row">' + cards + '</div>';
    document.querySelector('.menu-body').before(f);
    f.querySelectorAll('.item').forEach(function (i) { i.style.display = 'block'; });
  }

  // Category photos (optional, see photos.config.js)
  var P = window.CATEGORY_PHOTOS || {};
  Object.keys(P).forEach(function (id) {
    var h = document.querySelector('#' + id + ' .sec-header');
    if (!h) return;
    var img = new Image(); img.className = 'photo-banner'; img.loading = 'lazy'; img.alt = '';
    img.src = 'assets/photos/' + P[id]; h.after(img);
  });

  // Search across all category pages
  var q = document.getElementById('q'), empty = document.getElementById('qEmpty');
  function norm(t) { return t.replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').toLowerCase().trim(); }
  q.addEventListener('input', function () {
    var v = norm(q.value), any = false;
    document.body.classList.toggle('searching', !!v);
    document.querySelectorAll('.section:not(#all)').forEach(function (sec) {
      var hit = 0;
      sec.querySelectorAll('.item, .extra-pill').forEach(function (it) {
        var ok = !v || norm(it.textContent).indexOf(v) > -1;
        it.classList.toggle('is-hidden', !ok); if (ok) hit++;
      });
      sec.querySelectorAll('.sub-group').forEach(function (g) { g.classList.toggle('is-hidden', !!v); });
      sec.querySelectorAll('.extras-grid').forEach(function (g) { g.classList.toggle('is-hidden', !!v && !g.querySelector('.extra-pill:not(.is-hidden)')); });
      sec.classList.toggle('is-hidden', !!v && !hit);
      if (hit) any = true;
    });
    empty.hidden = !v || any;
  });
})();
