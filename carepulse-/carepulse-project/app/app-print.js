/* ===== step 7: printing (slip + bill with QR code), queue board, duplicate-patient hint ===== */

// Address patients open when they scan the QR code. Set "Public address" in Admin > Settings once the site is online.
const baseUrl = () => (SET.site_url || new URL('./', location.href).href).replace(/\/?$/, '/');
const statusLink = (b, c) => baseUrl() + '?b=' + encodeURIComponent(b) + '&c=' + encodeURIComponent(c) + '#pat';

function qrImg(text, cell = 3) {
  const q = qrcode(0, 'M'); q.addData(text); q.make();
  const i = new Image(); i.src = q.createDataURL(cell, 0); i.alt = 'QR code'; i.className = 'qr'; return i;
}

// The page is printed from a hidden area (everything else is hidden by theme.css @media print).
function printNode(node, kind) {
  const a = $('#printarea');
  a.className = 'p-' + kind; a.replaceChildren(node);
  const done = () => { a.replaceChildren(); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  setTimeout(() => window.print(), 50);   // let the QR image paint first
}
const clinicName = () => SET.clinic_name || 'Carepulse Clinic';
const dstr = d => new Date(d).toLocaleDateString('en-GB', {timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric'});

function printSlip(v) {
  printNode(h('div', {class: 'slip80'},
    h('h3', null, clinicName()), h('div', {class: 'p-muted'}, 'Visit slip · ' + dstr(v.created_at || Date.now())),
    h('div', {class: 'p-token'}, tk(v.token)),
    h('div', null, h('b', null, v.name)), h('div', null, doc(v.doctor_id).name + ' · ' + (doc(v.doctor_id).dept || '')),
    h('hr'), h('div', null, 'Bill no: ', h('b', null, v.bill)), h('div', null, 'Access code: ', h('b', null, v.code)),
    qrImg(statusLink(v.bill, v.code)),
    h('div', {class: 'p-muted'}, 'Scan to see your waiting number, report and bill. Or open the clinic website and type the bill no. and code.'),
    h('div', {class: 'p-muted'}, 'Keep this slip private: the code opens your status.')), 'slip');
}

async function printBill(v) {
  const items = (await sb.from('bill_items').select('*').eq('visit_id', v.id).order('id')).data || [];
  const tot = items.reduce((s, i) => s + Number(i.amount), 0);
  printNode(h('div', {class: 'bill'},
    h('h2', null, clinicName()), h('div', {class: 'p-muted'}, 'Bill / receipt'),
    h('div', {class: 'p-row'}, h('span', null, 'Bill no: ', h('b', null, v.bill)), h('span', null, dstr(v.visit_date + 'T12:00:00'))),
    h('div', null, 'Patient: ', h('b', null, v.name), v.age ? ' · ' + v.age + ' yrs' : ''), h('div', null, 'Doctor: ' + doc(v.doctor_id).name),
    h('table', null, h('thead', null, h('tr', null, h('th', null, 'Description'), h('th', {class: 'r'}, 'Amount'))),
      h('tbody', null, ...(items.length ? items.map(i => h('tr', null, h('td', null, i.description), h('td', {class: 'r'}, rs(i.amount)))) : [h('tr', null, h('td', {colspan: '2'}, 'No charges'))])),
      h('tfoot', null, h('tr', null, h('td', null, h('b', null, 'Total')), h('td', {class: 'r'}, h('b', null, rs(tot)))))),
    h('div', {class: 'p-stamp ' + (v.paid_at ? 'paid' : 'due')}, v.paid_at ? 'PAID' : 'UNPAID'),
    h('div', {class: 'p-sign'}, 'Received by: ____________________')), 'bill');
}
$('#bprint').onclick = () => {
  const v = VT.find(x => String(x.id) === $('#bsel').value);
  if (!v) { toast('Pick a visit first.', true); return; }
  printBill(v);
};

/* ---------- queue board (public, token numbers only) ---------- */
async function renderBoard() {
  const {data, error} = await sb.rpc('queue_board');
  const box = $('#bview');
  if (error || !data) { box.replaceChildren(...empty('Queue board is not available. Run setup.sql (v7).')); return; }
  $('#bstamp').textContent = data.clinic + ' · updated ' + hm(Date.now()) + ' · refreshes every 5 seconds';
  box.replaceChildren(...data.doctors.map(d => h('div', {class: 'bcard'},
    h('div', {class: 'bname'}, d.name), h('div', {class: 'muted'}, d.dept),
    h('div', {class: 'blabel'}, 'Now serving'),
    h('div', {class: 'bnow'}, d.serving.length ? d.serving.map(tk).join('  ') : '—'),
    h('div', {class: 'blabel'}, 'Next (' + d.waiting + ' waiting)'),
    h('div', {class: 'bnext'}, ...(d.next.length ? d.next.map(t => h('span', {class: 'chip'}, tk(t))) : [h('span', {class: 'muted'}, 'No one waiting')])))));
}
$('#bfull').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());

/* ---------- reception: "have we seen this phone number before?" ---------- */
let dupT;
async function checkDup() {
  clearTimeout(dupT);
  dupT = setTimeout(async () => {
    const box = $('#rdup'), ph = $('#rp').value.trim();
    if (ph.length < 6 || !(me && can('reception'))) { box.hidden = true; return; }
    const {data} = await sb.from('visits').select('name,age,allergies,visit_date').eq('phone', ph).neq('name', '[removed]').order('created_at', {ascending: false}).limit(20);
    if (!data || !data.length) { box.hidden = true; return; }
    const last = data[0];
    box.hidden = false;
    box.replaceChildren('This number was seen before: ', h('b', null, last.name), ' (' + data.length + ' visit' + (data.length > 1 ? 's' : '') + ', last ' + last.visit_date + '). ',
      h('a', {href: '#', style: 'color:var(--g);font-weight:600', onclick: e => {
        e.preventDefault(); $('#rn').value = last.name; if (last.age) $('#ra').value = last.age; if (last.allergies) $('#ral').value = last.allergies; box.hidden = true;
      }}, 'Use these details'));
  }, 350);
}
$('#rp').addEventListener('input', checkDup);
