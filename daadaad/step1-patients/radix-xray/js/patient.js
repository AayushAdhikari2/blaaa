// The chosen image is drawn on a canvas, shown only while it is scanned, then wiped.
// It is never written to localStorage, IndexedDB, a cookie or a storage bucket.
const MAX_FILE = 20 * 1024 * 1024, MAX_EDGE = 2576, MIN_EDGE = 300;
const form = $('#form'), canvas = $('#canvas');
let busy = false, timers = [];

$('#part').append(h('option', { value: '' }, 'Choose…'), ...Object.entries(PARTS).map(([v, l]) => h('option', { value: v }, l)));

function tab(name) {
  for (const t of ['scan', 'report']) { $('#p-' + t).hidden = t !== name; $('#t-' + t).classList.toggle('on', t === name); }
}
$('#t-scan').onclick = () => tab('scan');
$('#t-report').onclick = () => tab('report');

function wipeImage() {
  canvas.width = 0; canvas.height = 0;     // releases the pixels
  $('#file').value = '';                   // drops the file reference
  timers.forEach(clearTimeout); timers = [];
}
addEventListener('pagehide', () => { wipeImage(); $('#dcode').textContent = ''; $('#result').replaceChildren(); });

// Draws the file at a limited size. Re-encoding the canvas also removes hidden photo data such as GPS location.
async function drawFile(file) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Choose a JPG, PNG or WebP image.');
  if (file.size > MAX_FILE) throw new Error('The file is larger than 20 MB.');
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { throw new Error('This image could not be opened.'); }
  try {
    if (Math.min(bmp.width, bmp.height) < MIN_EDGE) throw new Error('The image is too small to read. Use the original file or a sharper photo.');
    const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
    const g = canvas.getContext('2d');
    g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  } finally { bmp.close(); }
}

function check() {
  const v = (id) => $('#' + id).value.trim();
  if (v('name').length < 2) return 'Enter the patient name.';
  if (!/^[+0-9 ()-]{6,20}$/.test(v('phone'))) return 'Enter a valid phone number.';
  if (v('age') === '' || !Number.isInteger(+v('age')) || +v('age') < 0 || +v('age') > 120) return 'Enter the age (0 to 120).';
  if (!v('sex') || !v('part') || !v('side')) return 'Choose the sex, body part and side.';
  if (!$('#file').files[0]) return 'Choose your X-ray image.';
  if (!$('#consent').checked) return 'Please tick the consent box.';
  return '';
}

form.onsubmit = async (ev) => {
  ev.preventDefault();
  if (busy) return;
  $('#ferr').textContent = check();
  if ($('#ferr').textContent) return;
  busy = true; $('#go').disabled = true;
  try {
    const file = $('#file').files[0];
    await drawFile(file);
    const val = (id) => $('#' + id).value;
    const body = {
      consent: true, consent_version: CONSENT_VERSION,
      patient: { name: val('name').trim(), phone: val('phone').trim(), age: val('age'), sex: val('sex'), body_part: val('part'), side: val('side'), symptoms: val('symptoms').trim() },
      file_sha256: await sha256Hex(file),
      image: canvas.toDataURL('image/jpeg', 0.92).split(',')[1],
    };
    form.hidden = true; $('#scan').hidden = false; $('#done').hidden = true;
    $('#scan').scrollIntoView({ block: 'start' });
    const say = (t) => { $('#sstat').textContent = t; };
    say('Sending the image securely…');
    timers = [setTimeout(() => say('The AI is checking the image quality and reading the X-ray…'), 2000),
              setTimeout(() => say('Still working. This can take a minute or two.'), 30000)];
    const request = api.analyze(body);
    body.image = null;
    const out = await request;
    $('#dref').textContent = out.ref; $('#dcode').textContent = out.code;
    $('#done').hidden = false; form.reset();
  } catch (e) {
    form.hidden = false;
    $('#ferr').textContent = e.message + ' Choose the image again to retry.';
  } finally {
    wipeImage();                              // success or failure, the image leaves the page
    $('#scan').hidden = true; busy = false; $('#go').disabled = false;
  }
};
addEventListener('beforeunload', (e) => { if (busy) e.preventDefault(); });
$('#again').onclick = () => { $('#done').hidden = true; form.hidden = false; $('#dref').textContent = $('#dcode').textContent = ''; };

/* ---------- my report ---------- */
function reportView(r) {
  const f = r.report;
  const bullets = (title, items) => items?.length ? [h('h3', null, title), h('ul', null, items.map((t) => h('li', null, t)))] : [];
  return h('article', { class: 'card report' },
    DEMO && h('div', { class: 'warn' }, 'DEMO SAMPLE: not a medical report.'),
    h('h2', null, 'X-ray report ' + r.ref),
    h('p', { class: 'muted' }, `${r.patient_name} · ${r.age} years · ${r.sex} · ${partName(r)} · uploaded ${when(r.created_at)}`),
    h('p', null, h('span', { class: 'badge ' + f.urgency }, URG[f.urgency])),
    f.urgency === 'urgent' && h('div', { class: 'warn' }, h('b', null, 'Please see a doctor today.')),
    h('h3', null, 'In simple words'), h('p', null, f.patient_summary),
    h('h3', null, 'Findings'), f.findings.length ? h('ul', null, f.findings.map((x) => h('li', null, h('b', null, x.region + ': '), x.observation))) : h('p', null, 'None listed.'),
    h('h3', null, 'Impression'), h('p', null, f.impression),
    bullets('Next steps', f.recommendations), bullets('Limits of this report', f.limitations),
    h('div', { class: 'sign' }, h('b', null, `Reviewed and approved by ${r.reviewer_name} (Reg. no. ${r.reviewer_reg_no})`), h('br'), when(r.reviewed_at), h('br'),
      'AI was used to produce the first draft of this report. Discuss it with your doctor.'),
    h('button', { class: 'btn noprint', type: 'button', onclick: () => print() }, 'Print / save as PDF'));
}

$('#lform').onsubmit = async (ev) => {
  ev.preventDefault();
  const out = $('#result'); out.replaceChildren(); $('#lerr').textContent = '';
  const ref = $('#lref').value.trim(), code = $('#lcode').value.trim();
  if (!ref || !code) { $('#lerr').textContent = 'Enter the report number and access code.'; return; }
  try {
    const r = await api.lookup(ref, code);
    if (!r) $('#lerr').textContent = 'The report number or code is not correct.';
    else if (r.locked) $('#lerr').textContent = 'Too many wrong tries. Wait 15 minutes.';
    else if (r.status === 'released') out.append(reportView(r));
    else if (r.status === 'rejected') out.append(h('div', { class: 'card' }, h('h2', null, 'No report was approved'), h('p', null, 'The doctor could not approve a report from this upload. This does not mean your X-ray is normal. Please contact the clinic or see a doctor.')));
    else out.append(h('div', { class: 'card' }, h('h2', null, 'Waiting for doctor review'), h('p', null, `${partName(r)}, uploaded ${when(r.created_at)}. The report appears here after a doctor approves it. If you feel worse, do not wait: see a doctor.`)));
  } catch (_) { $('#lerr').textContent = 'Could not check the report. Try again.'; }
};
