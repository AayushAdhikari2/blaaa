/* ===== AI X-ray, merged into the main app =====
   Screens: "AI X-ray" (patients: upload + open my report, also when logged out) and "X-ray review" (doctors registered as reviewers).
   Uses the app's own Supabase client (sb), login (session, me), toasts (UI) and notification bell. Element ids are prefixed x- in app/index.html;
   the local $ below adds that prefix, so this file can keep short ids. Everything lives inside this function: no new globals except renderXray / renderXrv. */
(function () {
'use strict';
const $ = (s) => document.querySelector(s.replace(/#([\w-]+)/g, '#x-$1'));
const TZ = 'Asia/Kathmandu';
function printReport(card) {   // the app prints only #printarea
  const pa = document.getElementById('printarea'); pa.replaceChildren(card.cloneNode(true)); pa.classList.add('xs');
  const done = () => { pa.replaceChildren(); pa.classList.remove('xs'); removeEventListener('afterprint', done); }; addEventListener('afterprint', done); print();
}
const DEMO = SUPABASE_URL.includes('YOUR-PROJECT');
const CONSENT_VERSION = 'xray-consent-2026-11-v1';   // must match core.js
const PARTS = { chest: 'Chest', hand_wrist: 'Hand / wrist', arm_elbow: 'Arm / elbow', shoulder: 'Shoulder', leg_knee: 'Leg / knee', ankle_foot: 'Ankle / foot', hip_pelvis: 'Hip / pelvis', spine: 'Spine', abdomen: 'Abdomen', skull_face: 'Skull / face', dental: 'Dental', other: 'Other' };
const SIDE = { left: 'left', right: 'right', both: 'both sides', na: '' };
const URG = { routine: 'Routine', soon: 'Follow up soon', urgent: 'Urgent' };
const partName = (r) => PARTS[r.body_part] + (SIDE[r.side] ? ' (' + SIDE[r.side] + ')' : '');
const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

// Builds elements with text nodes only, so patient or AI text can never run as HTML.
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((c) => c != null && c !== false));
  return e;
}

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- real backend ---------- */
function liveApi() {
  const rpc = async (name, args) => { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; };
  return {
    async analyze(body) {
      const { data, error } = await sb.functions.invoke('xray-analyze', { body });
      if (error) {
        let m = 'The scan could not be completed. Check your connection and try again.';
        try { m = (await error.context.json()).error || m; } catch (_) { /* no JSON body */ }
        throw new Error(m);
      }
      return data;
    },
    lookup: (ref, code) => rpc('xray_lookup', { p_ref: ref, p_code: code }),
    async me() { return session ? rpc('xray_me') : null; },
    queue: (s) => rpc('xray_queue', { p_status: s }),
    get: (id) => rpc('xray_get', { p_id: id }),
    release: (id, report, examined) => rpc('xray_release', { p_id: id, p_final: report, p_examined_original: examined }),
    reject: (id, reason) => rpc('xray_reject', { p_id: id, p_reason: reason }),
  };
}

/* ---------- demo backend: fixed sample text, kept in this browser only, never any image ---------- */
function demoApi() {
  const KEY = 'xray_demo_v1';
  let mem = [];
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || mem; } catch (_) { return mem; } };
  const save = (a) => { mem = a; try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (_) { /* private window */ } };
  const change = (id, patch) => { const a = load(); const r = a.find((x) => x.id === id && x.status === 'pending_review'); if (!r) throw new Error('This report was already reviewed.'); Object.assign(r, patch, { reviewed_at: new Date().toISOString() }); save(a); };
  const sample = () => ({ is_xray: true, rejection_reason: '', detected_body_part: 'sample', matches_selected_body_part: true, view: 'Sample view',
    image_quality: { rating: 'limited', issues: ['DEMO: the image was not examined.'] },
    findings: [{ region: 'Sample region', observation: 'DEMO SAMPLE TEXT. No image was analysed.', significance: 'uncertain', confidence: 'low' }],
    impression: 'DEMO SAMPLE. This is not a result.', urgency: 'routine', urgency_reason: 'Demo value.',
    recommendations: ['DEMO: sample next step.'], limitations: ['DEMO: this text is the same for every upload.'],
    patient_summary: 'DEMO SAMPLE. Your image was not analysed and this says nothing about your health.' });
  return {
    async analyze(body) {
      await new Promise((r) => setTimeout(r, 3500));
      const a = load(), n = new Uint32Array(2); crypto.getRandomValues(n);
      const ref = 'XR-' + n[0].toString(16).toUpperCase().padStart(8, '0'), code = String(n[1] % 1e8).padStart(8, '0');
      const p = body.patient;
      a.push({ id: Date.now(), ref, code, patient_name: p.name, phone: p.phone, age: Number(p.age), sex: p.sex, body_part: p.body_part, side: p.side, symptoms: p.symptoms,
        file_sha256: body.file_sha256, ai_result: sample(), ai_model: 'demo (no AI)', ai_urgency: 'routine', status: 'pending_review', created_at: new Date().toISOString() });
      save(a);
      return { ref, code, status: 'pending_review' };
    },
    async lookup(ref, code) {
      const r = load().find((x) => x.ref === ref.trim().toUpperCase() && x.code === code.trim());
      if (!r) return null;
      const base = { ref: r.ref, status: r.status, created_at: r.created_at, body_part: r.body_part, side: r.side };
      return r.status === 'released' ? { ...base, patient_name: r.patient_name, age: r.age, sex: r.sex, report: r.final_report, reviewer_name: r.reviewer_name, reviewer_reg_no: r.reviewer_reg_no, reviewed_at: r.reviewed_at } : base;
    },
    async me() { return session ? { full_name: 'Demo Doctor', registration_no: 'DEMO-000' } : null; },
    async queue(s) { return load().filter((r) => r.status === s); },
    async get(id) { return load().find((r) => r.id === id); },
    async release(id, report, examined) { if (!examined) throw new Error('Confirm that you examined the original X-ray.'); change(id, { status: 'released', final_report: report, reviewer_name: 'Demo Doctor', reviewer_reg_no: 'DEMO-000' }); },
    async reject(id, reason) { change(id, { status: 'rejected', reject_reason: reason }); },
  };
}

const api = DEMO ? demoApi() : liveApi();
if (DEMO) $('#demo').hidden = false;

/* ===== patient: scan + my report ===== */
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
    h('button', { class: 'btn noprint', type: 'button', onclick: (e) => printReport(e.currentTarget.closest('.report')) }, 'Print / save as PDF'));
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

/* ===== doctor review ===== */
const STATES = { pending_review: 'To review', released: 'Released', rejected: 'Rejected' };
let state = 'pending_review', previewUrl = null;

function dropPreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
addEventListener('pagehide', dropPreview);

async function start() {
  let me = null, err = '';
  try { me = await api.me(); } catch (e) { err = e.message; }
  $('#note').hidden = !!me; $('#list').hidden = !me; $('#detail').hidden = true;
  $('#note').replaceChildren(h('p', { class: err ? 'err' : 'muted' }, err || 'Your account is not registered as an X-ray reviewer. Ask an admin to add you (see docs/XRAY-README.md).'));
  if (me) await showList();
  return me;
}

async function showList() {
  dropPreview(); $('#detail').replaceChildren(); $('#detail').hidden = true; $('#list').hidden = false;
  $('#qtabs').replaceChildren(...Object.entries(STATES).map(([k, l]) => h('button', { type: 'button', class: k === state && 'on', onclick: () => { state = k; showList(); } }, l)),
    h('button', { type: 'button', onclick: showList }, '↻ Refresh'));
  try {
    const rows = await api.queue(state);
    $('#queue').replaceChildren(...(rows.length ? rows.map((r) => h('button', { type: 'button', class: 'row', onclick: () => open(r.id) },
      h('span', null, h('b', null, r.patient_name), ` · ${r.age} y · ${partName(r)}`, h('br'), h('small', { class: 'muted' }, `${r.ref} · ${when(r.created_at)}`)),
      h('span', { class: 'badge ' + r.ai_urgency }, 'AI: ' + URG[r.ai_urgency])))
      : [h('p', { class: 'muted' }, 'Nothing here.')]));
  } catch (e) { $('#queue').replaceChildren(h('p', { class: 'err' }, e.message)); }
}

const select = (options, value, label) => { const s = h('select', { 'aria-label': label }, Object.entries(options).map(([v, l]) => h('option', { value: v }, l))); s.value = value; return s; };
const area = (value, rows, label) => { const t = h('textarea', { rows, 'aria-label': label }); t.value = value; return t; };
const lines = (t) => t.value.split('\n').map((s) => s.trim()).filter(Boolean);

// Lets the doctor confirm a file is the one that was scanned. It stays on this computer.
function originalCheck(hash) {
  const msg = h('p', { role: 'status' }), box = h('div');
  const input = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Original X-ray file', onchange: async () => {
    dropPreview(); box.replaceChildren(); const f = input.files[0]; if (!f) return;
    const same = (await sha256Hex(f)) === hash;
    msg.className = same ? 'ok' : 'err';
    msg.textContent = same ? 'Same file as the one scanned.' : 'NOT the same file. It may be another X-ray, or an edited or re-sent copy. Check carefully.';
    previewUrl = URL.createObjectURL(f);
    box.append(h('img', { src: previewUrl, alt: 'Original X-ray chosen by the reviewer', class: 'preview' }));
  } });
  return h('div', { class: 'card' }, h('h3', null, 'Check the original X-ray'),
    h('p', { class: 'hint' }, 'The system did not save the image. Look at the patient’s film, or ask for the same file they uploaded and open it here to confirm it matches. It is not uploaded.'), input, msg, box);
}

async function open(id) {
  let r;
  try { r = await api.get(id); } catch (e) { UI.toast(e.message || 'Could not open this report.', 'error'); return; }
  const ai = r.ai_result, src = r.final_report || ai, locked = r.status !== 'pending_review';
  $('#list').hidden = true; const d = $('#detail'); d.hidden = false;

  const rows = h('div');
  const findingRow = (f = { region: '', observation: '', significance: 'uncertain', confidence: 'low' }) => {
    const region = h('input', { 'aria-label': 'Region', placeholder: 'Region', maxlength: 100 }); region.value = f.region;
    const obs = area(f.observation, 2, 'Observation');
    const sig = select({ normal: 'Normal', incidental: 'Incidental', abnormal: 'Abnormal', uncertain: 'Uncertain' }, f.significance, 'Significance');
    const el = h('div', { class: 'finding' }, region, obs, h('div', { class: 'inline' }, sig,
      h('small', { class: 'muted' }, 'AI confidence: ' + (f.confidence || 'n/a')),
      !locked && h('button', { type: 'button', class: 'btn ghost', onclick: () => el.remove() }, 'Remove')));
    el.read = () => ({ region: region.value.trim(), observation: obs.value.trim(), significance: sig.value, confidence: f.confidence });
    return el;
  };
  rows.append(...src.findings.map(findingRow));

  const impression = area(src.impression, 3, 'Impression'), summary = area(src.patient_summary, 5, 'Patient summary'),
    recs = area(src.recommendations.join('\n'), 4, 'Recommendations'), limits = area((src.limitations || []).join('\n'), 3, 'Limitations'),
    urgency = select(URG, src.urgency, 'Urgency');
  const examined = h('input', { type: 'checkbox' }), reason = h('input', { placeholder: 'Reason for rejecting', 'aria-label': 'Reason for rejecting', maxlength: 500 });
  const err = h('p', { class: 'err', role: 'alert' });
  const act = (fn) => async (ev) => {
    const b = ev.currentTarget; b.disabled = true; err.textContent = '';
    try { await fn(); await showList(); } catch (e) { err.textContent = e.message; b.disabled = false; }
  };

  d.replaceChildren(
    h('button', { type: 'button', class: 'btn ghost', onclick: showList }, '← Back'),
    h('div', { class: 'card' }, h('h2', null, `${r.patient_name} · ${r.ref}`),
      h('p', null, `${r.age} years · ${r.sex} · ${partName(r)} · phone ${r.phone}`),
      h('p', null, h('b', null, 'Symptoms: '), r.symptoms || 'not given'),
      h('p', null, h('span', { class: 'badge ' + r.ai_urgency }, 'AI: ' + URG[r.ai_urgency]), ' ', ai.urgency_reason),
      h('p', { class: 'muted' }, `Image quality: ${ai.image_quality.rating}. ${ai.image_quality.issues.join('; ')} · View: ${ai.view} · Model: ${r.ai_model} · Uploaded ${when(r.created_at)}`),
      !ai.matches_selected_body_part && h('div', { class: 'warn' }, h('b', null, 'Body part mismatch: '), 'the AI saw ' + ai.detected_body_part + '.'),
      r.status === 'released' && h('p', { class: 'ok' }, `Released by ${r.reviewer_name} on ${when(r.reviewed_at)}.`),
      r.status === 'rejected' && h('p', { class: 'err' }, 'Rejected: ' + r.reject_reason)),
    !locked && originalCheck(r.file_sha256),
    h('fieldset', { class: 'card', disabled: locked },
      h('h3', null, locked ? (r.final_report ? 'Approved report' : 'AI draft') : 'AI draft: correct it before releasing'),
      h('label', null, 'Findings'), rows, !locked && h('button', { type: 'button', class: 'btn ghost', onclick: () => rows.append(findingRow()) }, '+ Add finding'),
      h('label', null, 'Impression'), impression, h('label', null, 'Urgency'), urgency,
      h('label', null, 'Next steps (one per line)'), recs, h('label', null, 'Limitations (one per line)'), limits,
      h('label', null, 'Summary the patient will read'), summary),
    !locked && h('div', { class: 'card' },
      h('label', { class: 'chk' }, examined, h('span', null, 'I examined the original X-ray myself, checked every line above, and approve this report under my name.')),
      h('button', { type: 'button', class: 'btn full', onclick: act(() => {
        if (!examined.checked) throw new Error('Tick the box to confirm you examined the original X-ray.');
        const findings = [...rows.children].map((e) => e.read());
        if (findings.some((f) => !f.region || !f.observation)) throw new Error('Fill in or remove empty findings.');
        if (impression.value.trim().length < 3 || summary.value.trim().length < 3) throw new Error('Impression and patient summary are required.');
        return api.release(r.id, { findings, impression: impression.value.trim(), patient_summary: summary.value.trim(), recommendations: lines(recs), limitations: lines(limits), urgency: urgency.value }, true);
      }) }, 'Approve and release to patient'),
      h('div', { class: 'inline rej' }, reason, h('button', { type: 'button', class: 'btn danger', onclick: act(() => {
        if (reason.value.trim().length < 3) throw new Error('Give a reason for rejecting.');
        return api.reject(r.id, reason.value.trim());
      }) }, 'Reject')),
      err));
  scrollTo(0, 0);
}
window.renderXrv = start;

window.renderXray = () => {};   // the patient screen is static markup; nothing to refresh
})();
