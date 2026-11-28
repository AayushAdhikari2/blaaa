/* Landing page behaviour. No data is sent anywhere from this page except to the app (status lookup). */
document.documentElement.classList.add('js');

// Mobile menu
const links = document.getElementById('links'), burger = document.getElementById('burger');
const setMenu = open => { links.classList.toggle('open', open); burger.setAttribute('aria-expanded', String(open)); };
burger.addEventListener('click', () => setMenu(!links.classList.contains('open')));
links.addEventListener('click', e => { if (e.target.closest('a')) setMenu(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setMenu(false); });

// Reveal sections as they scroll into view (content stays visible if IntersectionObserver is missing)
const targets = document.querySelectorAll('.flow4 li,.fcard,.role,.card.big,.qa,details');
targets.forEach(el => el.classList.add('rv'));
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), {threshold: .12});
  targets.forEach(el => io.observe(el));
} else targets.forEach(el => el.classList.add('in'));

// Patient status: send the bill number + code to the app's patient page
document.getElementById('statusform').addEventListener('submit', e => {
  e.preventDefault();
  const b = encodeURIComponent(document.getElementById('sb').value.trim());
  const c = encodeURIComponent(document.getElementById('sc').value.trim());
  location.href = 'app/?b=' + b + '&c=' + c + '#pat';
});

// Contact: open the visitor's own email app (nothing is stored or sent by this page)
document.getElementById('form').addEventListener('submit', e => {
  e.preventDefault();
  const f = new FormData(e.target), to = document.getElementById('mailto').textContent.trim();
  const body = (f.get('msg') || '') + '\n\n' + (f.get('name') || '') + (f.get('org') ? ' · ' + f.get('org') : '');
  location.href = 'mailto:' + to + '?subject=' + encodeURIComponent('RADIX AI enquiry') + '&body=' + encodeURIComponent(body);
});
