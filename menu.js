const SECTIONS = [
  'hotcoffee', 'espresso', 'hotdrinks', 'hotmilk',
  'icecoffee', 'frappe', 'icematcha', 'juice',
  'mixsoda', 'smoothie', 'milkshake', 'waffle',
  'desserts', 'softdrinks'
];

function show(cat, btn) {
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const seps = document.querySelectorAll('.sep');

  if (cat === 'all') {
    SECTIONS.forEach(s => {
      const el = document.getElementById('s-' + s);
      if (el) el.style.display = 'block';
    });
    seps.forEach(d => d.style.display = 'block');
  } else {
    SECTIONS.forEach(s => {
      const el = document.getElementById('s-' + s);
      if (el) el.style.display = (s === cat) ? 'block' : 'none';
    });
    seps.forEach(d => d.style.display = 'none');
  }
}
