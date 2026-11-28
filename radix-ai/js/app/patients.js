/* ===== step 1: patient master record =====
   Loads after app-modules.js and before app-start.js. Needs schema_v11.sql.
   - Reception: search bar (phone / name / PT number), autofill, live phone check, patient history + edit
   - Doctor: "Patient history" button on the patient in the room
   Everything is added from here, so app.js and index.html need no other edits. */

const PT = {id: null, no: null};      // the patient picked for the registration form (null = new / typed by hand)

/* ---------- styles for this file only ---------- */
document.head.append(h('style', null, `
.ptbar{position:sticky;top:0;z-index:5}
.ptres .row{align-items:flex-start}
.ptres .row>div:first-child{min-width:0}
.ptpick{display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--mint);border-radius:8px;padding:8px 10px;font-size:13px;margin-top:10px}
.phint{font-size:12px;margin-top:4px;min-height:16px}
.phint.ok{color:var(--g)} .phint.warn{color:#9a6700}
.dlg.modal .row .btn.sm{min-height:36px}
.al{display:inline-block;background:#fdecea;color:#b42318;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
`));

/* ---------- Nepal phone check (advice only, never blocks) ---------- */
const normPhone = p => { const d = (p || '').replace(/\D/g, ''); return /^977\d{10}$/.test(d) ? d.slice(3) : d; };
function phoneHint(p) {
  const d = normPhone(p);
  if (!d) return ['', ''];
  if (/^9[78]\d{8}$/.test(d)) return ['ok', '✓ Valid Nepali mobile number'];
  if (/^0\d{7,9}$/.test(d) || /^[1-9]\d{6,7}$/.test(d)) return ['ok', '✓ Looks like a landline'];
  if (d.length < 7) return ['warn', 'Too short: Nepali mobile numbers have 10 digits (98XXXXXXXX)'];
  if (d.length === 10) return ['warn', 'Nepali mobile numbers start with 97 or 98. Check the number.'];
  return ['warn', 'Check the number: mobile numbers have 10 digits'];
}

/* ---------- dialog helper (replaces ad-hoc popups for this feature) ---------- */
function openDialog(...content) {
  return UI.modal('Patient', h('div', {class: 'in'}, ...content), {cls: 'wide'});
}

/* ---------- patient history dialog (reception, admin, doctor) ---------- */
async function showPatient(id, opts = {}) {
  const {data, error} = await sb.rpc('patient_history', {p_patient: id});
  if (error) { toast(errText(error), true); return; }
  const p = data.patient, v = data.visits, isDoc = me && me.role === 'doctor';
  const dlg = openDialog();
  const body = dlg.firstChild;
  const draw = () => body.replaceChildren(
    h('div', {class: 'inl', style: 'justify-content:space-between;margin:0'}, h('h2', null, p.name), h('button', {class: 'btn ghost sm', onclick: () => dlg.close()}, 'Close')),
    h('div', {class: 'muted'}, p.patient_no + ' · ' + (p.age ? p.age + ' yrs · ' : '') + (p.sex ? {F: 'Female', M: 'Male', O: 'Other'}[p.sex] + ' · ' : '') + p.phone),
    p.allergies ? h('div', {style: 'margin-top:8px'}, h('span', {class: 'al'}, 'Allergies: ' + p.allergies)) : h('div', {class: 'muted', style: 'margin-top:8px'}, 'No allergies recorded.'),
    h('div', {class: 'inl'},
      !isDoc && h('button', {class: 'btn sm', onclick: () => { fillForm(p); dlg.close(); }}, 'Use for new visit'),
      !isDoc && h('button', {class: 'btn ghost sm', onclick: () => editForm()}, 'Edit details')),
    h('h3', {style: 'margin-top:16px'}, 'Past visits (' + v.length + ')'),
    ...(v.length ? v.map(x => h('div', {class: 'row'},
      h('div', null, h('b', null, x.date + ' · ' + x.doctor), h('div', {class: 'muted'}, (x.reason || 'No reason noted') + (x.test_name ? ' · test: ' + x.test_name : '') + (x.bill ? ' · ' + x.bill : ''))),
      h('div', null, st(x.status), ' ',
        x.total != null && h('span', {class: x.paid ? 'paid' : 'due'}, rs(x.total) + (x.paid ? ' · Paid' : ' · Unpaid')), ' ',
        x.report_path && h('button', {class: 'btn ghost sm', onclick: e => openReport(staffReportUrl(x.report_path, x.id), e.target)}, 'Report'),
        !x.report_path && x.has_report && h('span', {class: 'muted'}, 'Report on file')))) : empty('No visits yet.')));
  const editForm = () => {
    const f = {n: h('input', {id: 'pe-n', value: p.name, maxlength: '80'}), ph: h('input', {id: 'pe-p', value: p.phone, inputmode: 'tel', maxlength: '20'}),
      a: h('input', {id: 'pe-a', type: 'number', min: '0', max: '120', value: p.age ?? ''}),
      s: h('select', {id: 'pe-s'}, ...[['', 'Not set'], ['F', 'Female'], ['M', 'Male'], ['O', 'Other']].map(([k, l]) => h('option', {value: k}, l))),
      al: h('input', {id: 'pe-al', value: p.allergies || '', maxlength: '300', placeholder: 'e.g. penicillin, dust'})};
    f.s.value = p.sex || '';
    const err = h('div', {class: 'err'}), hint = h('div', {class: 'phint'});
    const upd = () => { const [c, t] = phoneHint(f.ph.value); hint.className = 'phint ' + c; hint.textContent = t; }; f.ph.oninput = upd; upd();
    body.replaceChildren(h('h2', null, 'Edit ' + p.patient_no),
      h('label', {for: 'pe-n'}, 'Name'), f.n, h('label', {for: 'pe-p'}, 'Phone'), f.ph, hint,
      h('label', {for: 'pe-a'}, 'Age'), f.a, h('label', {for: 'pe-s'}, 'Sex'), f.s, h('label', {for: 'pe-al'}, 'Allergies'), f.al, err,
      h('div', {class: 'inl'},
        h('button', {class: 'btn', onclick: e => busy(e.target, 'Saving…', async () => {
          const r = await sb.rpc('patient_update', {p_id: p.id, p_name: f.n.value, p_phone: f.ph.value, p_age: f.a.value ? +f.a.value : null, p_sex: f.s.value, p_allergies: f.al.value});
          if (r.error) { err.textContent = errText(r.error); return; }
          Object.assign(p, {name: f.n.value.trim(), phone: f.ph.value.trim(), age: f.a.value ? +f.a.value : null, sex: f.s.value || null, allergies: f.al.value.trim() || null});
          toast('Patient details saved.'); draw(); runSearch();
        })}, 'Save'),
        h('button', {class: 'btn ghost', onclick: draw}, 'Cancel')));
    f.n.focus();
  };
  draw();
}

/* ---------- reception: pick a patient -> autofill the registration form ---------- */
function fillForm(p) {
  PT.id = p.id; PT.no = p.patient_no;
  $('#rn').value = p.name; $('#rp').value = p.phone; $('#ra').value = p.age ?? ''; $('#ral').value = p.allergies || '';
  showPicked(); updRecHint(); window.checkDup && checkDup();
  $('#rd').focus(); $('#rec').scrollIntoView({behavior: 'smooth', block: 'start'});
}
function clearPicked() { PT.id = null; PT.no = null; showPicked(); }
function showPicked() {
  let b = $('#ptpick');
  if (!PT.id) { b && b.remove(); return; }
  if (!b) { b = h('div', {class: 'ptpick', id: 'ptpick'}); $('#rdup').before(b); }
  b.replaceChildren(h('span', null, 'Existing patient ', h('b', null, PT.no), ' · details filled in. Edit the fields if they changed.'),
    h('button', {class: 'btn ghost sm', onclick: () => { clearPicked(); ['#rn', '#rp', '#ra', '#ral'].forEach(s => $(s).value = ''); updRecHint(); }}, 'New patient instead'));
}
function updRecHint() { const [c, t] = phoneHint($('#rp').value), e = $('#rphint'); e.className = 'phint ' + c; e.textContent = t; }

/* ---------- reception: search bar (injected above the registration form) ---------- */
let searchT, searchSeq = 0;
const sq = h('input', {id: 'ptq', type: 'search', placeholder: 'Find returning patient: phone, name or PT number', autocomplete: 'off', 'aria-label': 'Find patient by phone, name or patient number', style: 'min-height:44px'});
const sres = h('div', {class: 'ptres', 'aria-live': 'polite'});
async function runSearch() {
  const q = sq.value.trim(), my = ++searchSeq;
  if (q.length < 2) { sres.replaceChildren(); return; }
  const {data, error} = await sb.rpc('patient_search', {p_q: q});
  if (my !== searchSeq) return;                       // a newer search is already running
  if (error) { sres.replaceChildren(h('div', {class: 'err'}, errText(error))); return; }
  sres.replaceChildren(...(data.length ? data.map(p => h('div', {class: 'row'},
    h('div', null, h('b', null, p.name), ' ', h('span', {class: 'muted'}, p.patient_no),
      h('div', {class: 'muted'}, p.phone + (p.age ? ' · ' + p.age + ' yrs' : '') + ' · ' + p.visits + ' visit' + (p.visits == 1 ? '' : 's') + (p.last_visit ? ', last ' + p.last_visit : '')),
      p.allergies && h('span', {class: 'al'}, 'Allergies: ' + p.allergies)),
    h('div', {class: 'inl', style: 'margin:0'},
      h('button', {class: 'btn sm', onclick: () => fillForm(p)}, 'New visit'),
      h('button', {class: 'btn ghost sm', onclick: () => showPatient(p.id)}, 'History')))) :
    [h('p', {class: 'muted'}, 'No patient found. Fill in the form below to register a new patient.')]));
}
sq.oninput = () => { clearTimeout(searchT); searchT = setTimeout(runSearch, 250); };
$('#rec').prepend(h('div', {class: 'card'}, h('h2', null, 'Find a patient'), sq, sres));

// live phone hint under the registration phone field
$('#rp').after(h('div', {id: 'rphint', class: 'phint', 'aria-live': 'polite'}));
$('#rp').addEventListener('input', () => { updRecHint(); if (PT.id) { /* phone edited: still the same patient record, server updates it */ } });

/* ---------- send the chosen patient id with the registration (app.js stays untouched) ---------- */
const _rpc = sb.rpc.bind(sb);
sb.rpc = (fn, args, opts) => {
  if (fn !== 'register_visit') return _rpc(fn, args, opts);
  return (async () => {
    const r = await _rpc(fn, PT.id ? {...args, p_patient_id: PT.id} : args, opts);   // one request only
    if (!r.error) { clearPicked(); updRecHint(); }
    return r;
  })();
};

/* ---------- doctor: "Patient history" button on the patient in the room ---------- */
const _roomRow = window.roomRow;
window.roomRow = v => {
  const el = _roomRow(v);
  if (v.patient_id) {
    const first = el.querySelector('.row');
    if (first) first.after(h('div', {class: 'inl', style: 'margin:6px 0 0'},
      h('button', {class: 'btn ghost sm', onclick: () => showPatient(v.patient_id)}, 'Patient history'),
      v.allergies && h('span', {class: 'al'}, 'Allergies: ' + v.allergies)));
  }
  return el;
};
