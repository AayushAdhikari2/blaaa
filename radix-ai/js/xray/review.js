const STATES = { pending_review: 'To review', released: 'Released', rejected: 'Rejected' };
let state = 'pending_review', previewUrl = null;

function dropPreview() { if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = null; }
addEventListener('pagehide', dropPreview);

async function start() {
  let me = null;
  try { me = await api.me(); } catch (e) { $('#aerr').textContent = e.message; }
  $('#login').hidden = !!me; $('#list').hidden = !me; $('#detail').hidden = true; $('#out').hidden = !me;
  $('#who').textContent = me ? `${me.full_name} · ${me.registration_no}` : '';
  if (me) await showList();
  return me;
}
$('#login').onsubmit = async (ev) => {
  ev.preventDefault(); $('#aerr').textContent = '';
  try {
    await api.signIn($('#email').value.trim(), $('#pass').value); $('#pass').value = '';
    if (!(await start())) { await api.signOut(); $('#aerr').textContent = 'This account is not registered as an X-ray reviewer.'; }
  } catch (e) { $('#aerr').textContent = e.message; }
};
$('#out').onclick = async () => { dropPreview(); $('#detail').replaceChildren(); $('#queue').replaceChildren(); await api.signOut(); await start(); };

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
  try { r = await api.get(id); } catch (e) { alert(e.message); return; }
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
start();
