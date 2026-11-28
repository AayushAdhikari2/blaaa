/* ===== step 5: clinical notes, vitals, follow-up, printable prescription =====
   Loads after app-queue.js (and app-patients.js), before app-start.js. Needs schema_v15_clinical.sql.
   The doctor sees a "Consultation" panel for the patient in the room: vitals, diagnosis, notes, advice, follow-up date, and a Print prescription button.
   Notes are saved to the database (not kept in the browser). Unsaved typing survives screen refreshes, and "Complete visit" saves first. */

const CN = {unit: 'C', saved: {}, reg: {}};
try { CN.unit = localStorage.getItem('cn.unit') || 'C'; } catch (_) {}
const CN_K = ['bp_sys', 'bp_dia', 'pulse', 'temp_c', 'spo2', 'weight_kg', 'complaint', 'diagnosis', 'notes', 'advice', 'follow_up_date'];
const cnC2F = c => Math.round((c * 9 / 5 + 32) * 10) / 10, cnF2C = f => Math.round((f - 32) * 5 / 9 * 10) / 10;
const cnSnap = o => JSON.stringify(CN_K.map(k => String(o[k] ?? '').trim()));
const cnPlusDays = n => { const [y, m, d] = today().split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

document.head.append(h('style', null, `
.cnp .cnv{display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:8px}
.cnp .cnv label{margin-top:0;font-size:12px}
.cnp textarea{width:100%}
.cnp .cnst{font-size:12px;color:var(--mut)} .cnp .cnst.bad{color:#b45309;font-weight:600}
.cnp .btn{min-height:44px}
.cnp .chips .chip{min-height:36px}
@media print{.rx{max-width:180mm;margin:0 auto;font-size:13px;color:#000;line-height:1.45}.rx h2{font-size:20px;margin:0}
 .rx .rxh{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px}
 .rx .rxr{display:flex;justify-content:space-between;gap:12px;margin:3px 0}
 .rx table{width:100%;border-collapse:collapse;margin:6px 0}.rx th,.rx td{border-bottom:1px solid #999;padding:5px 4px;text-align:left}
 .rx .sym{font-size:26px;font-weight:700;margin-top:10px}.rx .sig{margin-top:56px;text-align:right}.rx .alg{font-weight:700}}
`));

function cnPanel(v) {
  const k = f => 'cn:' + v.id + ':' + f, F = {};
  const stat = h('span', {class: 'cnst', role: 'status'}, 'Loading…');
  const collect = () => {
    const o = {}; CN_K.forEach(f => { o[f] = f === 'temp_c' ? '' : (F[f].value || '').trim(); });
    const t = (F.temp.value || '').trim(); o.temp_c = t ? String(CN.unit === 'F' ? cnF2C(+t) : +t) : '';
    return o;
  };
  const dirty = () => CN.saved[v.id] !== undefined && cnSnap(collect()) !== CN.saved[v.id];
  const mark = () => { if (CN.saved[v.id] === undefined) return; const d = dirty(); stat.className = 'cnst' + (d ? ' bad' : ''); if (d) stat.textContent = 'Unsaved changes'; };
  const field = (f, label, attrs, tag) => {
    const el = h(tag || 'input', {id: 'cn-' + f + '-' + v.id, ...attrs}); el.value = dr(k(f), '');
    el.oninput = () => { DRAFT[k(f)] = el.value; mark(); }; F[f] = el;
    return h('div', null, h('label', {for: el.id}, label), el);
  };
  const num = (f, label, min, max, step) => field(f, label, {type: 'number', inputmode: 'decimal', min, max, step: step || '1'});
  const unitSel = h('select', {id: 'cn-unit-' + v.id, 'aria-label': 'Temperature unit'}, h('option', {value: 'C'}, '°C'), h('option', {value: 'F'}, '°F')); unitSel.value = CN.unit;
  const tempBox = field('temp', 'Temp', {type: 'number', inputmode: 'decimal', step: '0.1'});
  tempBox.append(unitSel);
  unitSel.onchange = () => {                                // keep the same temperature, shown in the other unit
    const old = CN.unit, nu = unitSel.value, t = parseFloat(F.temp.value);
    CN.unit = nu; try { localStorage.setItem('cn.unit', nu); } catch (_) {}
    if (!isNaN(t)) { F.temp.value = String(nu === 'F' ? cnC2F(t) : cnF2C(t)); DRAFT[k('temp')] = F.temp.value; }
    mark();
  };
  const fu = field('follow_up_date', 'Follow-up date', {type: 'date', min: today()});
  const chips = h('div', {class: 'chips'}, ...[[3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month']].map(([n, l]) =>
    h('button', {type: 'button', class: 'chip', onclick: () => { F.follow_up_date.value = cnPlusDays(n); DRAFT[k('follow_up_date')] = F.follow_up_date.value; mark(); }}, l)),
    h('button', {type: 'button', class: 'chip', onclick: () => { F.follow_up_date.value = ''; DRAFT[k('follow_up_date')] = ''; mark(); }}, 'No follow-up'));

  const save = async () => {
    const {error} = await sb.rpc('save_consult', {p_visit: v.id, p: collect()});
    if (error) { stat.className = 'cnst bad'; stat.textContent = errText(error); toast(errText(error), true); return false; }
    CN.saved[v.id] = cnSnap(collect()); stat.className = 'cnst'; stat.textContent = 'Saved ' + hm(Date.now()); return true;
  };
  const saveBtn = h('button', {class: 'btn', onclick: e => busy(e.target, 'Saving…', async () => { if (await save()) toast('Notes saved for ' + v.name + '.'); })}, 'Save notes');
  const printBtn = h('button', {class: 'btn ghost', onclick: e => busy(e.target, 'Preparing…', async () => {
    if (dirty() && !(await save())) return;
    const {data, error} = await sb.rpc('rx_print_data', {p_visit: v.id});
    if (error) { toast(errText(error), true); return; }
    printNode(cnRxNode(data), 'rx');
  })}, 'Print prescription');

  const reg = h('input', {id: 'cn-reg-' + v.id, placeholder: 'e.g. NMC 12345', maxlength: '30', 'aria-label': 'Registration number', style: 'max-width:200px'});
  reg.value = CN.reg[v.doctor_id] || '';
  const regBtn = h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', async () => {
    const {error} = await sb.rpc('set_reg_no', {p_doctor: v.doctor_id, p_reg: reg.value});
    if (!error) CN.reg[v.doctor_id] = reg.value.trim(); toast(error ? errText(error) : 'Registration number saved.', !!error);
  })}, 'Save');
  if (CN.reg[v.doctor_id] === undefined) sb.from('doctors').select('reg_no').eq('id', v.doctor_id).maybeSingle().then(r => { CN.reg[v.doctor_id] = (r.data && r.data.reg_no) || ''; if (!reg.value) reg.value = CN.reg[v.doctor_id]; });

  const panel = h('div', {class: 'panel cnp'}, h('h3', null, 'Consultation'),
    h('div', {class: 'cnv'}, num('bp_sys', 'BP top', '50', '300'), num('bp_dia', 'BP bottom', '30', '200'), num('pulse', 'Pulse /min', '20', '250'), tempBox, num('spo2', 'SpO₂ %', '50', '100'), num('weight_kg', 'Weight kg', '0.5', '400', '0.1')),
    field('complaint', 'Complaint', {maxlength: '300'}), field('diagnosis', 'Diagnosis', {maxlength: '300'}),
    field('notes', 'Notes', {rows: '3', maxlength: '4000'}, 'textarea'), field('advice', 'Advice to patient', {rows: '2', maxlength: '1500'}, 'textarea'),
    fu, chips,
    h('div', {class: 'inl'}, saveBtn, printBtn, stat),
    h('div', {class: 'inl', style: 'margin-top:4px'}, h('label', {for: reg.id, style: 'margin:0;font-size:12px'}, 'My registration no. (printed on prescriptions)'), reg, regBtn));

  // load what is already saved; typed-but-unsaved text (kept in DRAFT) wins over the saved value
  sb.rpc('get_consult', {p_visit: v.id}).then(({data, error}) => {
    if (error) { stat.className = 'cnst bad'; stat.textContent = 'Notes unavailable: ' + errText(error); return; }
    const base = {}; CN_K.forEach(f => base[f] = data ? data[f] : (f === 'complaint' ? v.reason : ''));
    const shown = f => f === 'temp_c' ? 'temp' : f;
    CN_K.forEach(f => {
      const el = F[shown(f)]; if (DRAFT[k(shown(f))] !== undefined || !el) return;
      let x = base[f] ?? ''; if (f === 'temp_c' && x !== '') x = String(CN.unit === 'F' ? cnC2F(+x) : +x);
      el.value = x; DRAFT[k(shown(f))] = x;
    });
    CN.saved[v.id] = cnSnap(base); stat.className = 'cnst'; stat.textContent = data ? 'Saved ' + hm(data.saved_at) : 'Not saved yet'; mark();
  });
  panel.cnDirty = dirty; panel.cnSave = save;
  return panel;
}

/* ---------- the printed prescription ---------- */
function cnRxNode(d) {
  const c = d.consult || {}, p = d.patient, vt = [];
  if (c.bp_sys && c.bp_dia) vt.push('BP ' + c.bp_sys + '/' + c.bp_dia + ' mmHg');
  if (c.pulse) vt.push('Pulse ' + c.pulse + '/min');
  if (c.temp_c != null) vt.push('Temp ' + c.temp_c + ' °C (' + cnC2F(+c.temp_c) + ' °F)');
  if (c.spo2) vt.push('SpO₂ ' + c.spo2 + '%');
  if (c.weight_kg) vt.push('Weight ' + c.weight_kg + ' kg');
  return h('div', {class: 'rx'},
    h('div', {class: 'rxh'}, h('div', null, h('h2', null, d.clinic.name), d.clinic.address && h('div', null, d.clinic.address), d.clinic.phone && h('div', null, 'Phone: ' + d.clinic.phone)),
      h('div', {style: 'text-align:right'}, h('b', null, d.doctor.name), d.doctor.dept && h('div', null, d.doctor.dept), d.doctor.reg_no && h('div', null, 'Reg. no. ' + d.doctor.reg_no))),
    h('div', {class: 'rxr'}, h('span', null, h('b', null, p.name), (p.age ? ' · ' + p.age + ' yrs' : '') + (p.sex ? ' · ' + {F: 'Female', M: 'Male', O: 'Other'}[p.sex] : '')), h('span', null, 'Date: ' + dstr(d.visit.date))),
    h('div', {class: 'rxr'}, h('span', null, p.patient_no ? 'Patient no. ' + p.patient_no : ''), h('span', null, 'Bill ' + d.visit.bill)),
    p.allergies && h('div', {class: 'alg'}, 'Allergies: ' + p.allergies),
    vt.length ? h('div', null, vt.join(' · ')) : null,
    c.complaint && h('div', null, h('b', null, 'Complaint: '), c.complaint),
    c.diagnosis && h('div', null, h('b', null, 'Diagnosis: '), c.diagnosis),
    c.notes && h('div', {style: 'white-space:pre-wrap'}, h('b', null, 'Notes: '), c.notes),
    h('div', {class: 'sym'}, '℞'),
    d.items.length ? h('table', null, h('thead', null, h('tr', null, ...['#', 'Medicine', 'Dose', 'Days', 'Qty'].map(x => h('th', null, x)))),
      h('tbody', null, ...d.items.map((i, n) => h('tr', null, h('td', null, String(n + 1)), h('td', null, i.drug + (i.strength ? ' ' + i.strength : '') + (i.form ? ' (' + i.form + ')' : '')), h('td', null, i.dose), h('td', null, i.days == null ? '' : String(i.days)), h('td', null, String(i.qty)))))) : h('p', null, 'No medicines prescribed.'),
    c.advice && h('div', {style: 'white-space:pre-wrap'}, h('b', null, 'Advice: '), c.advice),
    c.follow_up_date && h('div', {style: 'margin-top:6px'}, h('b', null, 'Follow-up: '), dstr(c.follow_up_date)),
    h('div', {class: 'sig'}, '______________________', h('div', null, d.doctor.name + (d.doctor.reg_no ? ' · Reg. ' + d.doctor.reg_no : ''))));
}

/* ---------- put the panel into the doctor's patient card ---------- */
const _roomRowN = window.roomRow;
window.roomRow = v => {
  const el = _roomRowN(v), panel = cnPanel(v);
  const lab = el.querySelector('.panel');
  lab ? lab.before(panel) : el.append(panel);
  const done = [...el.querySelectorAll('button')].find(b => b.textContent === 'Complete visit');
  if (done) { const orig = done.onclick; done.onclick = async e => { if (panel.cnDirty() && !(await panel.cnSave())) return; return orig.call(done, e); }; }   // never lose typed notes
  return el;
};

/* ---------- patient history (step 1 window) also shows diagnosis and follow-up ---------- */
const _rpcN = sb.rpc.bind(sb);
sb.rpc = (fn, args, opts) => {
  if (fn !== 'patient_history') return _rpcN(fn, args, opts);
  return (async () => {
    const r = await _rpcN(fn, args, opts);
    if (r.data && r.data.visits) r.data.visits.forEach(x => { x.reason = (x.reason || 'No reason noted') + (x.diagnosis ? ' · Dx: ' + x.diagnosis : '') + (x.follow_up ? ' · follow-up ' + x.follow_up : ''); });
    return r;
  })();
};
