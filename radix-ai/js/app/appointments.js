/* ===== step 6: real appointments =====
   Loads after app-notify.js, before app-start.js. Needs schema_v16_appointments.sql.
   - Admin > Schedules: weekly hours per doctor (slot length) and days off.
   - Patient booking page: optional free-time picker.
   - Reception: "Appointments" card with requests, booked visits by day, Confirm / Reschedule / Cancel / No-show / Arrived → Register,
     and "Book by phone". Confirm, reschedule and cancel send the patient an SMS (if they agreed). */

const apTZ = 'Asia/Kathmandu', AP_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const apTime = t => new Date(t).toLocaleTimeString('en-US', {timeZone: apTZ, hour: '2-digit', minute: '2-digit'});
const apDate = t => new Date(t).toLocaleDateString('en-CA', {timeZone: apTZ});
const apDayLabel = d => { const t = today(), tm = new Date(new Date(t + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
  return (d === t ? 'Today · ' : d === tm ? 'Tomorrow · ' : '') + new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', {timeZone: 'UTC', weekday: 'short', day: '2-digit', month: 'short'}); };
const AP_ST = {requested: 'Requested', confirmed: 'Confirmed', converted: 'Arrived', cancelled: 'Cancelled', no_show: 'No-show'};

document.head.append(h('style', null, `
.chip.apsel{background:var(--g);border-color:var(--g);color:#fff} .chips .chip{min-height:36px}
.apst{display:inline-block;border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700;background:#eef2f6;color:#344054}
.apst.confirmed{background:#e3f6ec;color:#0f6b43}.apst.requested{background:#fef3c7;color:#92400e}.apst.no_show,.apst.cancelled{background:#fdecea;color:#b42318}
.apgrp{font-weight:700;font-size:13px;margin:14px 0 2px;color:var(--mut)}
.apnos{display:inline-block;background:#fdecea;color:#b42318;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;margin-left:6px}
.apx .row{align-items:flex-start} .apx .btn.sm{min-height:44px}
`));

const apDialog = (title, ...nodes) => UI.modal(title, h('div', {class: 'in'}, h('h2', null, title), ...nodes));
const apCall = async (fn, args, ok) => { const {error} = await sb.rpc(fn, args); if (error) { toast(errText(error), true); return false; } if (ok) toast(ok); AP.sig = ''; kick(); render(); return true; };

/* ---------- slot picker (free times for one doctor on one day) ---------- */
function apSlotPicker(getDoc, getDate, state) {
  const box = h('div', {'aria-live': 'polite'});
  async function load() {
    const d = getDoc(), day = getDate();
    if (!d || !day) { box.replaceChildren(h('p', {class: 'muted'}, 'Pick a doctor and a date to see free times.')); return; }
    const {data, error} = await sb.rpc('available_slots', {p_doctor: d, p_day: day});
    if (error) { box.replaceChildren(h('div', {class: 'err'}, errText(error))); return; }
    if (state.slot && !(data || []).some(s => s.at === state.slot)) state.slot = null;
    box.replaceChildren(!data || !data.length ? h('p', {class: 'muted'}, 'No free times on this day. Try another date.')
      : h('div', {class: 'chips'}, ...data.map(s => { const b = h('button', {type: 'button', class: 'chip' + (state.slot === s.at ? ' apsel' : ''), 'aria-pressed': String(state.slot === s.at)}, s.label);
          b.onclick = () => { state.slot = s.at; load(); state.onPick && state.onPick(s); }; return b; })));
  }
  return {node: box, load};
}
const apDocSel = (id, val) => { const s = h('select', {id}, ...DOCS.map(d => h('option', {value: d.id}, d.name))); if (val) s.value = val; return s; };

/* ---------- reception dialogs ---------- */
function apConfirm(a, resched) {
  const st8 = {slot: a.slot_at || null}, dateIn = h('input', {type: 'date', id: 'apd', min: today()});
  dateIn.value = a.slot_at ? apDate(a.slot_at) : (a.preferred_date && a.preferred_date >= today() ? a.preferred_date : today());
  const pick = apSlotPicker(() => a.doctor_id, () => dateIn.value, st8); dateIn.onchange = () => { st8.slot = null; pick.load(); };
  const err = h('div', {class: 'err'}); let dlg;
  const go = h('button', {class: 'btn'}, resched ? 'Move appointment' : 'Confirm appointment');
  go.onclick = () => busy(go, 'Saving…', async () => {
    if (!st8.slot) { err.textContent = 'Pick a time first.'; return; }
    const {error} = await sb.rpc(resched ? 'reschedule_appointment' : 'confirm_appointment', {p_id: a.id, p_slot: st8.slot});
    if (error) { err.textContent = errText(error); pick.load(); return; }
    toast((resched ? 'Moved' : 'Confirmed') + ': ' + a.name + (a.consent_sms ? ' (SMS sent)' : '') + '.'); dlg.close(); AP.sig = ''; kick(); render();
  });
  dlg = apDialog((resched ? 'Reschedule ' : 'Confirm ') + a.name, h('p', {class: 'muted'}, doc(a.doctor_id).name + (a.reason ? ' · ' + a.reason : '')),
    h('label', {for: 'apd'}, 'Date'), dateIn, h('label', null, 'Free times'), pick.node, err, h('div', null, go, h('button', {class: 'btn ghost', onclick: () => dlg.close()}, 'Close')));
  pick.load();
}
function apCancel(a) {
  const why = h('input', {placeholder: 'Reason (optional)', maxlength: '200', 'aria-label': 'Reason'}); let dlg;
  const go = h('button', {class: 'btn'}, a.status === 'requested' ? 'Dismiss request' : 'Cancel appointment');
  go.onclick = () => busy(go, 'Saving…', async () => { if (await apCall('cancel_appointment', {p_id: a.id, p_reason: why.value}, 'Cancelled: ' + a.name + (a.status === 'confirmed' && a.consent_sms ? ' (SMS sent)' : '') + '.')) dlg.close(); });
  dlg = apDialog((a.status === 'requested' ? 'Dismiss ' : 'Cancel appointment for ') + a.name + '?', h('label', null, 'Reason'), why, h('div', null, go, h('button', {class: 'btn ghost', onclick: () => dlg.close()}, 'Keep it')));
}
function apBook() {
  const st8 = {slot: null}, name = h('input', {id: 'apbn', maxlength: '80'}), phone = h('input', {id: 'apbp', inputmode: 'tel', maxlength: '20'}), reason = h('input', {id: 'apbr', maxlength: '200'});
  const dsel = apDocSel('apbd'), dateIn = h('input', {type: 'date', id: 'apbt', min: today()}), sms = h('input', {type: 'checkbox', id: 'apbs'}), err = h('div', {class: 'err'});
  dateIn.value = today();
  const pick = apSlotPicker(() => dsel.value, () => dateIn.value, st8); dsel.onchange = dateIn.onchange = () => { st8.slot = null; pick.load(); };
  let dlg; const go = h('button', {class: 'btn'}, 'Book appointment');
  go.onclick = () => busy(go, 'Saving…', async () => {
    if (!st8.slot) { err.textContent = 'Pick a time first.'; return; }
    const {error} = await sb.rpc('book_appointment', {p_name: name.value, p_phone: phone.value, p_doctor: dsel.value, p_slot: st8.slot, p_reason: reason.value, p_sms: sms.checked});
    if (error) { err.textContent = /name and phone/.test(error.message) ? 'Enter the patient’s name and phone.' : errText(error); pick.load(); return; }
    toast('Booked: ' + name.value + ' at ' + apTime(st8.slot) + (sms.checked ? ' (SMS sent)' : '') + '.'); dlg.close(); AP.sig = ''; kick(); render();
  });
  dlg = apDialog('Book by phone', h('label', {for: 'apbn'}, 'Patient name'), name, h('label', {for: 'apbp'}, 'Phone'), phone, h('label', {for: 'apbd'}, 'Doctor'), dsel,
    h('label', {for: 'apbt'}, 'Date'), dateIn, h('label', null, 'Free times'), pick.node, h('label', {for: 'apbr'}, 'Reason'), reason,
    h('label', {class: 'chk', for: 'apbs', style: 'margin-top:10px'}, sms, ' The patient agreed to SMS updates about this appointment'), err,
    h('div', null, go, h('button', {class: 'btn ghost', onclick: () => dlg.close()}, 'Close')));
  pick.load(); name.focus();
}

/* ---------- reception board ---------- */
const AP = {sig: '', rows: []};
$('#reqs').hidden = true;
$('#reqs').previousElementSibling.textContent = 'Appointments';
const apBox = h('div', {id: 'appts', class: 'apx'});
$('#reqs').before(h('div', {class: 'inl', style: 'margin:0 0 6px'}, h('button', {class: 'btn sm', onclick: apBook}, '+ Book by phone')), apBox);
function apArrive(a) {
  apptId = a.id; $('#rn').value = a.name; $('#rp').value = a.phone; $('#rd').value = a.doctor_id; $('#rr').value = a.reason || ''; $('#rsms').checked = !!a.consent_sms;
  if (window.checkDup) checkDup(); window.scrollTo({top: 0, behavior: 'smooth'});
}
function apRow(a) {
  const past = a.slot_at && new Date(a.slot_at) < Date.now();
  const btns = [];
  if (a.status === 'requested') btns.push(h('button', {class: 'btn sm', onclick: () => apConfirm(a, false)}, 'Confirm'), h('button', {class: 'btn ghost sm', onclick: () => apCancel(a)}, 'Dismiss'));
  if (a.status === 'confirmed') btns.push(h('button', {class: 'btn sm', onclick: () => apArrive(a)}, 'Arrived → Register'), h('button', {class: 'btn ghost sm', onclick: () => apConfirm(a, true)}, 'Reschedule'),
    h('button', {class: 'btn ghost sm', onclick: () => apCancel(a)}, 'Cancel'),
    past && h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => apCall('mark_no_show', {p_id: a.id}, a.name + ' marked no-show.'))}, 'No-show'));
  const smsT = {sent: 'SMS sent', queued: 'SMS queued', failed: 'SMS failed', skipped: 'SMS skipped'}[a.sms] || (a.consent_sms ? '' : 'No SMS');
  return h('div', {class: 'row'},
    h('div', null, h('b', null, (a.slot_at ? apTime(a.slot_at) + ' · ' : '') + a.name), h('span', {class: 'apst ' + a.status, style: 'margin-left:6px'}, AP_ST[a.status]),
      a.prior_no_shows > 0 && h('span', {class: 'apnos', title: 'Earlier appointments this phone number missed (last 6 months)'}, a.prior_no_shows + ' earlier no-show' + (a.prior_no_shows > 1 ? 's' : '')),
      h('div', {class: 'muted'}, a.phone + ' · ' + a.doctor + (a.status === 'requested' ? ' · wants ' + (a.slot_at ? apDate(a.slot_at) + ' ' + apTime(a.slot_at) : a.preferred_date || 'any day') : '') + (a.reason ? ' · ' + a.reason : '') + (a.cancel_reason ? ' · ' + a.cancel_reason : '') + (smsT ? ' · ' + smsT : ''))),
    h('div', {class: 'inl', style: 'margin:0'}, btns));
}
function apDraw() {
  const rows = AP.rows, sig = JSON.stringify(rows.map(a => [a.id, a.status, a.slot_at, a.sms, a.prior_no_shows])) + Math.floor(Date.now() / 60000);
  if (sig === AP.sig) return; AP.sig = sig;
  const req = rows.filter(a => a.status === 'requested'), rest = rows.filter(a => a.status !== 'requested' && a.status !== 'cancelled' || (a.status === 'cancelled' && a.slot_at));
  const groups = {}; rest.forEach(a => { const d = a.slot_at ? apDate(a.slot_at) : a.preferred_date; (groups[d] = groups[d] || []).push(a); });
  const y = window.scrollY;
  apBox.replaceChildren(
    h('div', {class: 'apgrp'}, 'Requests (' + req.length + ')'), ...(req.length ? req.map(apRow) : empty('No pending requests.')),
    ...Object.keys(groups).sort().flatMap(d => [h('div', {class: 'apgrp'}, apDayLabel(d)), ...groups[d].map(apRow)]),
    !Object.keys(groups).length && h('div', {class: 'apgrp'}, 'Booked'), !Object.keys(groups).length && empty('No booked appointments in the next 2 weeks.'));
  window.scrollTo(window.scrollX, y);
}
const _renderRecAp = window.renderRec;
window.renderRec = async function () {
  await _renderRecAp();
  const {data, error} = await sb.rpc('appointments_board');
  if (error) { apBox.replaceChildren(h('div', {class: 'err'}, 'Appointments unavailable: ' + errText(error))); return; }
  AP.rows = data || []; apDraw();
};

/* ---------- patient booking page: pick a free time (optional) ---------- */
const BK = {slot: null};
(function () {
  const dt = $('#bdt'); if (!dt) return;
  dt.min = today();
  const box = h('div', {id: 'bslots'}); const pick = apSlotPicker(() => $('#bdoc').value, () => dt.value, BK);
  box.append(h('label', null, 'Pick a time (optional)'), pick.node);
  dt.after(box);
  const reload = () => { BK.slot = null; pick.load(); };
  dt.addEventListener('change', reload); $('#bdoc').addEventListener('change', reload);
  BK.onPick = s => { /* the date stays what the patient chose */ };
  BK.reset = () => { BK.slot = null; pick.node.replaceChildren(); };
  const _rpcB = sb.rpc.bind(sb);
  sb.rpc = (fn, args, opts) => {
    if (fn !== 'request_appointment') return _rpcB(fn, args, opts);
    return (async () => { const r = await _rpcB(fn, BK.slot ? {...args, p_slot: BK.slot} : args, opts); if (!r.error) BK.reset(); else if (/slot not available/i.test(r.error.message || '')) { $('#berr').textContent = 'That time was just taken. Please pick another time.'; pick.load(); r.error = {...r.error, handled: true}; } return r; })();
  };
})();

/* ---------- admin: doctor schedules and days off ---------- */
async function renderSchedules() {
  const did = (ADMSCH.doc && DOCS.some(d => d.id === ADMSCH.doc)) ? ADMSCH.doc : (DOCS[0] && DOCS[0].id);
  ADMSCH.doc = did;
  const [s, o] = await Promise.all([sb.from('doctor_schedules').select('*').eq('doctor_id', did).order('weekday').order('start_time'), sb.from('doctor_days_off').select('*').eq('doctor_id', did).order('day')]);
  if (s.error) { show([h('div', {class: 'card'}, h('div', {class: 'err'}, errText(s.error)))]); return; }
  const dsel = apDocSel('schdoc', did); dsel.onchange = () => { ADMSCH.doc = dsel.value; renderSchedules(); };
  const wd = h('select', {id: 'schwd'}, ...AP_DAYS.map((n, i) => h('option', {value: i}, n))), a = h('input', {type: 'time', id: 'scha', value: '09:00'}), b = h('input', {type: 'time', id: 'schb', value: '13:00'});
  const len = h('select', {id: 'schl'}, ...[5, 10, 15, 20, 30, 45, 60].map(n => h('option', {value: n}, n + ' min'))); len.value = '15';
  const err = h('div', {class: 'err'});
  const add = async days => {
    if (!a.value || !b.value || b.value <= a.value) { err.textContent = 'End time must be after start time.'; return; }
    const rows = days.map(d => ({doctor_id: did, weekday: d, start_time: a.value, end_time: b.value, slot_min: +len.value}));
    const r = await sb.from('doctor_schedules').insert(rows); if (r.error) { err.textContent = errText(r.error); return; } toast('Schedule added.'); renderSchedules();
  };
  const offD = h('input', {type: 'date', id: 'schoff', min: today()}), offN = h('input', {id: 'schnote', placeholder: 'Note (optional)', maxlength: '80'});
  show([
    h('div', {class: 'card'}, h('h2', null, 'Doctor schedules'), h('label', {for: 'schdoc'}, 'Doctor'), dsel,
      h('p', {class: 'muted', style: 'font-size:13px'}, 'Patients and reception can only book times inside these hours. A doctor with no schedule has no bookable times. Add a morning and an evening block if the doctor sits twice a day.'),
      ...(s.data.length ? s.data.map(r => h('div', {class: 'row'}, h('div', null, h('b', null, AP_DAYS[r.weekday]), h('div', {class: 'muted'}, r.start_time.slice(0, 5) + ' – ' + r.end_time.slice(0, 5) + ' · ' + r.slot_min + ' min slots')),
        h('button', {class: 'btn ghost sm', style: 'min-height:44px', onclick: async e => { if (!await ask({title: 'Remove these opening hours?', message: AP_DAYS[r.weekday] + ' ' + String(r.start_time).slice(0, 5) + ' to ' + String(r.end_time).slice(0, 5) + '. Patients can no longer book those times.', confirm: 'Remove', danger: true})) return; await busy(e.target, 'Removing…', async () => { const {error} = await sb.from('doctor_schedules').delete().eq('id', r.id); if (error) toast(errText(error), true); else { toast('Opening hours removed.'); renderSchedules(); } }); }}, 'Remove'))) : empty('No hours set yet.')),
      h('h3', {style: 'margin-top:14px'}, 'Add hours'),
      h('label', {for: 'schwd'}, 'Day'), wd, h('label', {for: 'scha'}, 'From'), a, h('label', {for: 'schb'}, 'To'), b, h('label', {for: 'schl'}, 'Slot length'), len, err,
      h('div', {class: 'inl'}, h('button', {class: 'btn', onclick: e => busy(e.target, 'Saving…', () => add([+wd.value]))}, 'Add this day'),
        h('button', {class: 'btn ghost', onclick: e => busy(e.target, 'Saving…', () => add([0, 1, 2, 3, 4, 5]))}, 'Add Sunday to Friday'))),
    h('div', {class: 'card'}, h('h2', null, 'Days off'), h('p', {class: 'muted', style: 'font-size:13px'}, 'No times are offered on these days. Appointments already booked are not cancelled automatically: check the Appointments list.'),
      ...(o.data.length ? o.data.map(r => h('div', {class: 'row'}, h('div', null, h('b', null, apDayLabel(r.day)), r.note && h('div', {class: 'muted'}, r.note)),
        h('button', {class: 'btn ghost sm', style: 'min-height:44px', onclick: async e => { if (!await ask({title: 'Remove this day off?', message: r.day + ' will be open for booking again.', confirm: 'Remove', danger: true})) return; await busy(e.target, 'Removing…', async () => { const {error} = await sb.from('doctor_days_off').delete().eq('doctor_id', did).eq('day', r.day); if (error) toast(errText(error), true); else { toast('Day off removed.'); renderSchedules(); } }); }}, 'Remove'))) : empty('No days off set.')),
      h('label', {for: 'schoff'}, 'Add a day off'), offD, offN,
      h('button', {class: 'btn', style: 'margin-top:8px', onclick: e => busy(e.target, 'Saving…', async () => {
        if (!offD.value) { toast('Pick a date.', true); return; }
        const r = await sb.from('doctor_days_off').upsert({doctor_id: did, day: offD.value, note: offN.value.trim() || null}); toast(r.error ? errText(r.error) : 'Day off added.', !!r.error); if (!r.error) renderSchedules();
      })}, 'Add day off'))]);
}
const ADMSCH = {doc: null};
if (typeof PANES !== 'undefined') PANES.schedules = ['Schedules', () => renderSchedules()];
