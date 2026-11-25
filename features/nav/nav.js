function showSection(id, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  var q = document.getElementById('q'); if (q && q.value) { q.value = ''; q.dispatchEvent(new Event('input')); }
  var f = document.querySelector('.featured'); if (f) f.classList.toggle('is-hidden', id !== 'all');
  const nav = document.getElementById('mainNav');
  if (nav && window.scrollY > nav.offsetTop) window.scrollTo({ top: nav.offsetTop, behavior: 'smooth' });
}
