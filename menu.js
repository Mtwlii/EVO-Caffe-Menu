function showSection(id, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  btn.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}