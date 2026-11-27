// Mobile menu
const links = document.getElementById('links');
document.getElementById('burger').addEventListener('click', () => links.classList.toggle('open'));
links.addEventListener('click', () => links.classList.remove('open'));

// Live clock in dashboard
const clock = document.getElementById('clock');
const tick = () => { clock.textContent = new Date().toLocaleTimeString('en-GB'); };
tick(); setInterval(tick, 1000);

// Pricing toggle (monthly / annually)
document.querySelectorAll('.toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    document.querySelectorAll('.amt b').forEach(el => { el.textContent = el.dataset[btn.dataset.m]; });
  });
});

// Heatmap cells
const heat = document.getElementById('heat');
const shades = ['#d4efe3', '#a9e0c7', '#6fcaa4', '#2ba67a'];
for (let i = 0; i < 54; i++) {
  const c = document.createElement('i');
  c.style.background = shades[Math.floor(Math.random() * shades.length)];
  heat.appendChild(c);
}

// Contact form (demo only: connect to Formspree, Netlify Forms, etc.)
document.getElementById('form').addEventListener('submit', e => {
  e.preventDefault();
  document.getElementById('done').hidden = false;
  e.target.reset();
});
