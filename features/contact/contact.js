(function () {
  var c = window.EVO_CONTACT || {}, links = [];
  var I = {
    phone: '<path d="M6 4h3l1.5 4-2 1.3a10 10 0 005.2 5.2L15 12.5l4 1.5v3c0 1-1 2-2.2 2C10 19 5 14 5 6.200 5 5 5.500 4 6 4z"/>',
    whatsapp: '<path d="M4 20l1.2-4A8 8 0 1112 20a8 8 0 01-3.800-1zM9 9c0 3 3 6 6 6l1-1.500-2-1-1 .8c-1-.4-2-1.400-2.400-2.400l.8-1-1-2z"/>',
    map: '<path d="M12 21s6-5.400 6-10.500a6 6 0 10-12 0C6 15.600 12 21 12 21zM12 8.500a2 2 0 100 4 2 2 0 000-4z"/>',
    instagram: '<rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.800"/><circle cx="16.800" cy="7.200" r=".6"/>',
    facebook: '<path d="M14 21v-8h2.600l.4-3H14V8.200c0-.9.400-1.500 1.600-1.500H17V4.100C16.600 4 15.800 4 15 4c-2.200 0-3.600 1.300-3.600 3.700V10H9v3h2.400v8z"/>',
    tiktok: '<path d="M14 4v10.500a3.500 3.500 0 11-3.500-3.500M14 4c.4 2.400 2 3.800 4.500 4"/>'
  };
  function esc(t) { return String(t).replace(/[&<>"']/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]; }); }
  function href(k, v) { return k === 'phone' ? 'tel:+' + v.replace(/\D/g, '') : k === 'whatsapp' ? 'https://wa.me/' + v.replace(/\D/g, '') : /^https:\/\//i.test(v) ? v : '#'; }
  var labels = { phone: 'اتصل', whatsapp: 'واتساب', map: 'الموقع', instagram: 'انستجرام', facebook: 'فيسبوك', tiktok: 'تيك توك' };
  ['phone', 'whatsapp', 'map', 'instagram', 'facebook', 'tiktok'].forEach(function (k) {
    if (c[k]) links.push('<a class="c-btn c-' + k + '" href="' + esc(href(k, c[k])) + '" target="_blank" rel="noopener"><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">' + I[k] + '</svg><span>' + labels[k] + '</span></a>');
  });
  var f = document.querySelector('.footer');
  var info = '';
  if (c.address) info += '<div class="c-line">' + esc(c.address) + '</div>';
  if (c.hours) info += '<div class="c-line">' + esc(c.hours) + '</div>';
  if (c.hoursEn) info += '<div class="c-line c-en" dir="ltr">' + esc(c.hoursEn) + '</div>';
  if (links.length || info) {
    var box = document.createElement('div'); box.className = 'contact';
    box.innerHTML = info + (links.length ? '<div class="c-row">' + links.join('') + '</div>' : '');
    f.prepend(box);
  }
  // sticky quick-action bar on phones: call / whatsapp / map only
  var quick = links.filter(function (l) { return /c-(phone|whatsapp|map)/.test(l); });
  if (quick.length) {
    var bar = document.createElement('div'); bar.className = 'quickbar'; bar.innerHTML = quick.join('');
    document.body.appendChild(bar); document.body.classList.add('has-quickbar');
  }
  // back to top
  var t = document.createElement('button'); t.className = 'to-top'; t.setAttribute('aria-label', 'للأعلى');
  t.innerHTML = '<svg class="ico" viewBox="0 0 24 24"><path d="M6 14l6-6 6 6"/></svg>';
  t.onclick = function () { window.scrollTo({ top: 0, behavior: 'smooth' }); };
  document.body.appendChild(t);
  window.addEventListener('scroll', function () { t.classList.toggle('show', window.scrollY > 900); }, { passive: true });
})();
