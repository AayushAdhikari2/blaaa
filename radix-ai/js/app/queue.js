/* ===== app-queue.js v2 (REPLACES the step 2 version) =====
   Step 2 board + step 7 triage and queue control. Loads after app-modules.js (and app-patients.js), before app-start.js.
   Needs schema_v12 + schema_v17 (works with v12 only, but the triage buttons need v17).
   - Order everywhere: priority first, then arrival time. "Not present" patients wait outside the line.
   - Doctor board: Now seeing / Next up / Waiting / Back from lab / Not present / At lab, Call next (N), Skip, Not here, Priority, Recall, Pause.
   - Reception: live queue with filters, priority, not-present, pause strip, SMS status per patient.
   - Patient page and waiting-room TV board show "paused" and "please come to reception" states. */

const QB = {sig: '', seen: null, did: null, last: Date.now(), live: false, chan: null, pending: false, mute: false, ac: null, fresh: {}, docs: {}};
try { QB.mute = localStorage.getItem('qb.mute') === '1'; } catch (_) {}
LBL.review = 'Back from lab';
const qbWait = t => Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
const qbByQ = (a, b) => (b.priority || 0) - (a.priority || 0) || new Date(a.q_at) - new Date(b.q_at) || a.id - b.id;   // same order as the database
const qbInLine = v => (v.status === 'waiting' || v.status === 'review') && !v.away;
const QB_PRI = {1: 'Urgent', 2: 'Emergency'};
const qbBadge = v => QB_PRI[v.priority] ? h('span', {class: 'pri p' + v.priority}, QB_PRI[v.priority] + (v.triage_note ? ': ' + v.triage_note : '')) : null;

document.head.append(h('style', null, `
.qbbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.qbbar select{width:auto;min-height:44px}
.qbbar .btn,.qbx .btn,.qc .btn{min-height:44px}
.qbstamp{font-size:12px;color:var(--mut)} .qbstamp.live{color:var(--g);font-weight:600}
.qbgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;align-items:start}
.qbcol h2{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.qbcount{font-size:12px;background:var(--mint);color:var(--ink);border-radius:99px;padding:2px 10px}
.qc{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-top:8px;background:#fff}
.qc .top{display:flex;gap:10px;align-items:flex-start}
.qc.next{border-color:var(--g);box-shadow:0 0 0 2px rgba(43,166,122,.18)}
.qc.fresh{border-color:#e0a100;background:#fff8e1}
.qc.p2{border-left:5px solid #b42318} .qc.p1{border-left:5px solid #b45309}
.qc .tk{font-weight:700;font-size:18px;min-width:44px}
.qc .bd{flex:1;min-width:0} .qc .bd .muted{font-size:12px}
.qc .acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.qc .al{display:inline-block;background:#fdecea;color:#b42318;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;margin-top:2px}
.pri{display:inline-block;border-radius:6px;padding:1px 8px;font-size:11px;font-weight:700;margin-left:6px}
.pri.p1{background:#fef3c7;color:#92400e} .pri.p2{background:#fdecea;color:#b42318}
.away{display:inline-block;background:#eef2f6;color:#475467;border-radius:6px;padding:1px 8px;font-size:11px;font-weight:600;margin-left:6px}
.sms{font-size:11px;color:var(--mut);margin-left:6px} .sms.bad{color:#b42318;font-weight:700}
.qkeys{font-size:12px;color:var(--mut)} kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:inherit;font-size:11px;background:#fff}
.qbx .row{align-items:center}
.qbtn{font-size:16px;padding:12px 20px}
.qpause{background:#fff8e1;border:1px solid #e0a100;border-radius:10px;padding:10px 14px;margin:0 0 10px;display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.qchips{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px}
.qchip{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--line);border-radius:99px;padding:2px 4px 2px 10px;font-size:12px;background:#fff}
.qchip.paused{border-color:#e0a100;background:#fff8e1}
.qchip .btn{min-height:32px;padding:2px 10px}
dialog.qdlg{border:0;border-radius:14px;padding:0;width:min(420px,94vw);box-shadow:0 20px 60px rgba(0,0,0,.25)}
dialog.qdlg::backdrop{background:rgba(0,0,0,.4)} .qdlg .in{padding:18px 20px} .qdlg .btn{min-height:44px;margin:4px 6px 4px 0}
@media (max-width:760px){.qc .btn{flex:1}}
`));

/* ---------- small dialog (used for priority and pause) ---------- */
function qbAsk(title, ...nodes) {
  const dlg = h('dialog', {class: 'qdlg', 'aria-label': title}, h('div', {class: 'in'}, h('h2', null, title), ...nodes,
    h('div', null, h('button', {class: 'btn ghost', onclick: () => dlg.close()}, 'Cancel'))));
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg); dlg.showModal(); return dlg;
}
async function qbCall(fn, args, ok) {                     // run a database action, show a message, redraw
  const {error} = await sb.rpc(fn, args);
  if (error) { toast(errText(error), true); return false; }
  if (ok) toast(ok);
  QB.sig = ''; RQ.sig = ''; render(); return true;
}
function qbPriority(v) {
  const note = h('input', {placeholder: 'Reason (optional), e.g. chest pain', maxlength: '120', value: v.triage_note || '', 'aria-label': 'Reason'});
  let dlg;
  const mk = (lvl, label) => h('button', {class: 'btn' + ((v.priority || 0) === lvl ? '' : ' ghost'), onclick: async () => { if (await qbCall('set_priority', {p_visit: v.id, p_level: lvl, p_reason: note.value}, v.name + ': ' + label.toLowerCase())) dlg.close(); }}, label);
  dlg = qbAsk('Priority for ' + v.name, h('div', null, mk(0, 'Normal'), mk(1, 'Urgent'), mk(2, 'Emergency')), h('label', null, 'Reason'), note,
    h('p', {class: 'muted', style: 'font-size:12px'}, 'Urgent and emergency patients are called before normal ones. Every change is logged.'));
}
function qbPause(did) {
  const note = h('input', {placeholder: 'Other reason', maxlength: '60', 'aria-label': 'Reason'});
  let dlg;
  const go = async r => { if (await qbCall('set_doctor_pause', {p_doctor: did, p_paused: true, p_reason: r}, 'Queue paused.')) dlg.close(); };
  dlg = qbAsk('Pause this queue', h('p', {class: 'muted', style: 'font-size:13px'}, 'Nobody new is called and patients see that the doctor is on a short break. Their places are kept.'),
    h('div', null, ...['Lunch break', 'Emergency', 'Short break'].map(r => h('button', {class: 'btn', onclick: () => go(r)}, r))), note,
    h('div', null, h('button', {class: 'btn ghost', onclick: () => go(note.value || 'Break')}, 'Pause with this reason')));
}
const qbResume = did => qbCall('set_doctor_pause', {p_doctor: did, p_paused: false}, 'Queue resumed.');
async function qbDocStates() {
  const r = await sb.from('doctors').select('id,name,paused,pause_reason');
  QB.docs = Object.fromEntries((r.data || []).map(d => [d.id, d]));
}

/* ---------- sound / vibration ---------- */
document.addEventListener('pointerdown', () => { try { QB.ac = QB.ac || new (window.AudioContext || window.webkitAudioContext)(); QB.ac.resume && QB.ac.resume(); } catch (_) {} }, {passive: true});
function qbBeep() {
  if (QB.mute) return;
  try {
    const a = QB.ac; if (!a) return;
    const o = a.createOscillator(), g = a.createGain(); o.connect(g); g.connect(a.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(.18, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .5);
    o.start(); o.stop(a.currentTime + .5); navigator.vibrate && navigator.vibrate(120);
  } catch (_) {}
}

/* ---------- realtime ---------- */
let qbT;
const qbTyping = () => { const e = document.activeElement; return !!e && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && !!e.closest('#dview,#rec'); };
function qbChanged() {
  clearTimeout(qbT);
  qbT = setTimeout(() => { if (!['doc', 'rec'].includes(view)) return; if (qbTyping()) QB.pending = true; else render(); }, 300);
}
document.addEventListener('focusout', () => setTimeout(() => { if (QB.pending && !qbTyping()) { QB.pending = false; render(); } }, 200));
function qbLive() {
  if (!session) { if (QB.chan) { try { sb.removeChannel(QB.chan); } catch (_) {} QB.chan = null; QB.live = false; } return; }
  if (QB.chan || !sb.channel) return;
  try {
    QB.chan = sb.channel('visits-live').on('postgres_changes', {event: '*', schema: 'public', table: 'visits'}, qbChanged)
      .on('postgres_changes', {event: 'UPDATE', schema: 'public', table: 'doctors'}, qbChanged)
      .subscribe(s => { QB.live = s === 'SUBSCRIBED'; qbStamp(); });
  } catch (_) { QB.chan = null; }
}
function qbStamp() {
  const s = Math.max(0, Math.round((Date.now() - QB.last) / 1000));
  document.querySelectorAll('.qbstamp').forEach(e => {
    e.className = 'qbstamp' + (QB.live ? ' live' : '');
    e.textContent = (QB.live ? '● Live' : '○ Refreshing every 5 s') + ' · updated ' + (s < 5 ? 'just now' : s + ' s ago');
  });
}
setInterval(qbStamp, 1000);
const qbRefresh = () => { QB.sig = ''; RQ.sig = ''; render(); };

/* ---------- doctor: queue board ---------- */
async function qbLastVisits(vs) {
  const ids = [...new Set(vs.map(v => v.patient_id).filter(Boolean))], m = {};
  if (!ids.length) return m;
  const r = await sb.from('visits').select('patient_id,visit_date').in('patient_id', ids).lt('visit_date', today()).order('visit_date', {ascending: false});
  (r.data || []).forEach(x => { if (!(x.patient_id in m)) m[x.patient_id] = x.visit_date; });
  return m;
}
function qbCard(v, cls, last, paused) {
  const w = qbWait(v.q_at), lv = v.patient_id && last[v.patient_id];
  const callIn = h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Calling…', () => act(v.id, {status: 'in_room'}))}, 'Call in');
  if (paused) { callIn.disabled = true; callIn.title = 'The queue is paused'; }
  return h('div', {class: 'qc ' + cls + ' p' + (v.priority || 0) + (QB.fresh[v.id] > Date.now() ? ' fresh' : '')},
    h('div', {class: 'top'}, h('div', {class: 'tk'}, tk(v.token)),
      h('div', {class: 'bd'}, h('b', null, v.name), qbBadge(v), v.away && h('span', {class: 'away'}, 'Not present'), v.status === 'review' && h('span', {class: 'muted'}, ' · report is back'),
        h('div', {class: 'muted'}, [v.age ? v.age + ' yrs' : null, v.reason || 'No reason noted'].filter(Boolean).join(' · ')),
        v.allergies && h('span', {class: 'al'}, 'Allergies: ' + v.allergies),
        h('div', {class: 'muted'}, (lv ? 'Last visit ' + lv : 'First visit with you') + ' · ' + (v.away ? 'away since ' + hm(v.away_at) : 'waiting ' + w + ' min') + (v.skip_count ? ' · skipped ' + v.skip_count + '×' : '')))),
    h('div', {class: 'acts'},
      v.away ? h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('mark_back', {p_visit: v.id}, v.name + ' is back in the line.'))}, 'Back in line')
             : [callIn,
                h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('skip_visit', {p_visit: v.id}, v.name + ' moved to the back.'))}, 'Skip'),
                h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('mark_away', {p_visit: v.id}, v.name + ' marked not present.'))}, 'Not here')],
      h('button', {class: 'btn ghost sm', onclick: () => qbPriority(v)}, 'Priority')));
}
async function qbCallNext(btn) {
  const did = $('#dsel').value;
  return busy(btn, 'Calling…', async () => {
    const {data, error} = await sb.rpc('call_next', {p_doctor: did});
    if (error) { toast(errText(error), true); return; }
    if (!data) { toast('Nobody is waiting.'); return; }
    toast('Called ' + data.name + ' (' + tk(data.token) + ').'); kick(); QB.sig = ''; await window.renderDoc();
  });
}
function qbRoom(v) {                                      // consultation panel + recall / not-here buttons
  const el = window.roomRow(v);                           // looked up each time, so panels added by later files are included
  const bar = h('div', {class: 'acts qbx', style: 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0'},
    qbBadge(v),
    h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Calling…', () => qbCall('recall_visit', {p_visit: v.id}, 'Called ' + v.name + ' again' + (v.consent_sms ? ' (SMS sent).' : '.')))}, 'Call again' + (v.recall_count ? ' (' + v.recall_count + ')' : '')),
    h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('mark_away', {p_visit: v.id}, v.name + ' marked not present.'))}, 'Not here'),
    h('button', {class: 'btn ghost sm', onclick: () => qbPriority(v)}, 'Priority'));
  const first = el.querySelector('.row');
  first ? first.after(bar) : el.prepend(bar);
  return el;
}
window.renderDoc = async function () {
  qbLive();
  const did = $('#dsel').value;
  await window.loadDrugs?.(); await qbDocStates();
  const mine = (await todays()).filter(v => v.doctor_id === did);
  QB.last = Date.now();
  const ds = QB.docs[did] || {}, paused = !!ds.paused;
  const inRoom = mine.filter(v => v.status === 'in_room').sort(qbByQ);
  const q = mine.filter(qbInLine).sort(qbByQ);
  const away = mine.filter(v => (v.status === 'waiting' || v.status === 'review') && v.away).sort(qbByQ);
  const lab = mine.filter(v => v.status === 'report_pending').sort((a, b) => new Date(a.test_due) - new Date(b.test_due));
  const rev = new Set(mine.filter(v => v.status === 'review').map(v => v.id));
  if (QB.seen && QB.did === did) {
    const fresh = mine.filter(v => v.status === 'review' && !QB.seen.has(v.id));
    if (fresh.length) {
      fresh.forEach(v => QB.fresh[v.id] = Date.now() + 90000);
      qbBeep(); toast('Report back: ' + fresh.map(v => v.name).join(', '));
      const t0 = document.title; document.title = '● Report back'; setTimeout(() => document.title = t0, 6000);
    }
  }
  QB.seen = rev; QB.did = did;
  const sig = did + '|' + (paused ? ds.pause_reason || 'p' : '') + '|' + mine.map(v => [v.id, v.status, v.q_at, v.test_name, v.test_due, v.report_path ? 1 : 0, v.allergies, v.priority, v.away ? 1 : 0, v.skip_count, v.recall_count, v.triage_note, QB.fresh[v.id] > Date.now() ? 1 : 0].join(',')).join(';');
  if (sig === QB.sig && $('#dview').firstChild) { qbStamp(); return; }
  QB.sig = sig;
  const last = await qbLastVisits(mine);
  const next = q.slice(0, 3), rest = q.slice(3);
  const waiting = rest.filter(v => v.status === 'waiting'), back = rest.filter(v => v.status === 'review');
  const col = (title, list, build, emptyMsg) => h('div', {class: 'card qbcol'},
    h('h2', null, title, h('span', {class: 'qbcount'}, String(list.length))), ...(list.length ? list.map(build) : empty(emptyMsg)));
  const nextBtn = h('button', {class: 'btn qbtn', id: 'qbnext', onclick: e => qbCallNext(e.target)}, q.length ? 'Call next (' + q.length + ')' : 'Call next');
  nextBtn.disabled = !q.length || paused;
  const y = window.scrollY;
  $('#dview').replaceChildren(
    paused && h('div', {class: 'qpause', role: 'status'}, h('span', null, h('b', null, 'Queue paused'), ds.pause_reason ? ': ' + ds.pause_reason : '', '. Patients can see this.'),
      h('button', {class: 'btn', onclick: e => busy(e.target, 'Resuming…', () => qbResume(did))}, 'Resume')),
    h('div', {class: 'qbbar qbx'}, nextBtn,
      !paused && h('button', {class: 'btn ghost sm', onclick: () => qbPause(did)}, 'Pause queue'),
      h('button', {class: 'btn ghost sm', onclick: qbRefresh}, 'Refresh'),
      h('button', {class: 'btn ghost sm', 'aria-pressed': String(!QB.mute), onclick: e => { QB.mute = !QB.mute; try { localStorage.setItem('qb.mute', QB.mute ? '1' : '0'); } catch (_) {} e.target.textContent = QB.mute ? 'Sound off' : 'Sound on'; e.target.setAttribute('aria-pressed', String(!QB.mute)); }}, QB.mute ? 'Sound off' : 'Sound on'),
      h('span', {class: 'qbstamp'}), h('span', {class: 'qkeys'}, h('kbd', null, 'N'), ' call next · ', h('kbd', null, 'R'), ' refresh')),
    h('div', {class: 'card'}, h('h2', null, 'Now seeing', h('span', {class: 'qbcount'}, String(inRoom.length))),
      ...(inRoom.length ? inRoom.map(qbRoom) : empty('Nobody in the room. Press N or “Call next”.'))),
    h('div', {class: 'qbgrid'},
      col('Next up', next, v => qbCard(v, 'next', last, paused), 'No patients waiting.'),
      col('Waiting', waiting, v => qbCard(v, '', last, paused), 'Nobody else is waiting.'),
      col('Back from lab', back, v => qbCard(v, '', last, paused), 'No reports back yet.'),
      col('Not present', away, v => qbCard(v, '', last, paused), 'Everyone called is here.'),
      col('At lab', lab, v => h('div', {class: 'qc'}, h('div', {class: 'top'}, h('div', {class: 'tk'}, tk(v.token)),
        h('div', {class: 'bd'}, h('b', null, v.name), h('div', {class: 'muted'}, v.test_name + ' · expected ' + hm(v.test_due) + (new Date(v.test_due) < Date.now() ? ' (late)' : ''))), st('report_pending'))), 'No reports pending.')));
  window.scrollTo(window.scrollX, y);
  qbStamp();
};
$('#dsel').onchange = () => { QB.sig = ''; QB.seen = null; window.renderDoc(); };

document.addEventListener('keydown', e => {
  if (view !== 'doc' || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); const b = $('#qbnext'); if (b && !b.disabled) qbCallNext(b); }
  else if (k === 'r') { e.preventDefault(); qbRefresh(); }
});

/* ---------- reception: live queue beside the registration form ---------- */
const RQ = {doc: '', st: 'active', sig: ''};
const RQ_ST = [['active', 'Active (not completed)'], ['waiting', 'Waiting'], ['in_room', 'With doctor'], ['report_pending', 'At lab'], ['review', 'Back from lab'], ['away', 'Not present'], ['done', 'Completed'], ['all', 'All']];
const rqd = h('select', {id: 'rqd', 'aria-label': 'Filter by doctor'});
const rqs = h('select', {id: 'rqs', 'aria-label': 'Filter by status'}, ...RQ_ST.map(([k, l]) => h('option', {value: k}, l)));
rqd.onchange = () => { RQ.doc = rqd.value; RQ.sig = ''; recDraw(); };
rqs.onchange = () => { RQ.st = rqs.value; RQ.sig = ''; recDraw(); };
const rq = h('div', {id: 'rq', 'aria-live': 'polite'}), rqsum = h('div', {class: 'muted', style: 'margin:0 0 4px;font-size:13px'}), rqpause = h('div', {class: 'qchips'});
$('#rlist').hidden = true;
$('#rlist').before(h('div', {class: 'qbbar qbx'}, rqd, rqs, h('button', {class: 'btn ghost sm', onclick: qbRefresh}, 'Refresh'), h('span', {class: 'qbstamp'})), rqpause, rqsum, rq);
const RQ_ORDER = {in_room: 0, review: 1, waiting: 2, report_pending: 3, done: 4};
const smsBadge = id => { const m = window.MSGST && window.MSGST[id]; if (!m) return null; const t = {sent: 'SMS sent', queued: 'SMS queued', failed: 'SMS failed', off: 'No SMS', skipped: 'SMS skipped'}[m.sms]; return t ? h('span', {class: 'sms' + (m.sms === 'failed' ? ' bad' : '')}, t) : null; };
function recDraw() {
  if (!Array.isArray(VT)) return;
  if (rqd.options.length !== DOCS.length + 1) { rqd.replaceChildren(h('option', {value: ''}, 'All doctors'), ...DOCS.map(d => h('option', {value: d.id}, d.name))); rqd.value = RQ.doc; }
  const dsig = DOCS.map(d => d.id + ':' + (QB.docs[d.id] && QB.docs[d.id].paused ? QB.docs[d.id].pause_reason || 1 : 0)).join(',');
  const msig = window.MSGST ? Object.values(window.MSGST).map(m => m.sms).join('') : '';
  const sig = RQ.doc + '|' + RQ.st + '|' + dsig + '|' + msig + '|' + Math.floor(Date.now() / 60000) + '|' + VT.map(v => [v.id, v.status, v.q_at, v.paid_at ? 1 : 0, v.name, v.priority, v.away ? 1 : 0].join(',')).join(';');
  if (sig === RQ.sig) { qbStamp(); return; }
  RQ.sig = sig; QB.last = Date.now();
  rqpause.replaceChildren(...DOCS.map(d => { const s = QB.docs[d.id] || {};
    return h('span', {class: 'qchip' + (s.paused ? ' paused' : '')}, d.name + ' · ' + (s.paused ? 'Paused' + (s.pause_reason ? ' (' + s.pause_reason + ')' : '') : 'Active'),
      h('button', {class: 'btn ghost sm', onclick: () => s.paused ? qbResume(d.id) : qbPause(d.id)}, s.paused ? 'Resume' : 'Pause')); }));
  const match = v => (!RQ.doc || v.doctor_id === RQ.doc);
  let l = VT.filter(v => match(v) && (RQ.st === 'all' || (RQ.st === 'active' ? v.status !== 'done' : RQ.st === 'away' ? v.away && v.status !== 'done' : v.status === RQ.st)));
  l = l.sort((a, b) => (RQ_ORDER[a.status] - RQ_ORDER[b.status]) || qbByQ(a, b));
  const n = s => VT.filter(v => match(v) && v.status === s && !v.away).length;
  rqsum.textContent = n('waiting') + ' waiting · ' + n('in_room') + ' with doctor · ' + n('report_pending') + ' at lab · ' + n('review') + ' back from lab' + (VT.filter(v => match(v) && v.away && v.status !== 'done').length ? ' · ' + VT.filter(v => match(v) && v.away && v.status !== 'done').length + ' not present' : '');
  const y = window.scrollY;
  rq.replaceChildren(...(l.length ? l.map(v => h('div', {class: 'row'},
    h('div', null, h('b', null, tk(v.token) + ' · ' + v.name), qbBadge(v), v.away && h('span', {class: 'away'}, 'Not present'),
      h('div', {class: 'muted'}, doc(v.doctor_id).name + ' · ' + v.bill + (qbInLine(v) ? ' · waiting ' + qbWait(v.q_at) + ' min' : ''), smsBadge(v.id))),
    h('div', {class: 'inl', style: 'margin:0'}, st(v.status), h('span', {class: v.paid_at ? 'paid' : 'due'}, v.paid_at ? 'Paid' : 'Unpaid'),
      v.status !== 'done' && h('button', {class: 'btn ghost sm', onclick: () => qbPriority(v)}, 'Priority'),
      v.status !== 'done' && v.status !== 'report_pending' && (v.away
        ? h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('mark_back', {p_visit: v.id}, v.name + ' is back in the line.'))}, 'Back')
        : h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', () => qbCall('mark_away', {p_visit: v.id}, v.name + ' marked not present.'))}, 'Not here')),
      h('button', {class: 'btn ghost sm', onclick: () => printSlip(v)}, 'Slip')))) :
    empty(RQ.st === 'waiting' || RQ.st === 'active' ? 'No patients waiting.' : 'No visits match this filter.')));
  window.scrollTo(window.scrollX, y);
  qbStamp();
}
const _renderRec = window.renderRec;
window.renderRec = async function () { qbLive(); await _renderRec(); await qbDocStates(); if (window.msgLoad) await window.msgLoad(); recDraw(); };

/* ---------- patient page + waiting-room TV: paused and not-present states ---------- */
let PSTAT = null;
const _rpcQ = sb.rpc.bind(sb);
sb.rpc = (fn, args, opts) => {
  if (fn === 'patient_status') return (async () => { const r = await _rpcQ(fn, args, opts); PSTAT = r.data; return r; })();
  if (fn === 'queue_board') return (async () => { const r = await _rpcQ(fn, args, opts); if (r.data && r.data.doctors) r.data.doctors.forEach(d => { if (d.paused) d.name += ' · PAUSED'; }); return r; })();
  return _rpcQ(fn, args, opts);
};
const _renderPat = window.renderPat;
window.renderPat = async function (first) {
  await _renderPat(first);
  const v = PSTAT, card = $('#pres .card');
  if (!v || v.locked || !card) return;
  let msg = null;
  if (v.away && v.status !== 'done') msg = 'We called you but could not find you. Please come to the reception desk so we can put you back in the line.';
  else if (v.paused && (v.status === 'waiting' || v.status === 'review')) msg = v.doctor + ' has paused the queue' + (v.pause_reason ? ' (' + v.pause_reason + ')' : '') + '. Your place is kept. Please stay nearby.';
  else if (v.status === 'in_room' && v.recalled > 0) msg = v.doctor + ' is waiting for you. Please go to the room now.';
  const old = card.querySelector('.qnote'); if (old) old.remove();
  if (msg) { const n = card.querySelector('.note'); const b = h('div', {class: 'note qnote', role: 'status', style: 'border-color:#e0a100;background:#fff8e1;margin-bottom:8px'}, msg); n ? n.before(b) : card.append(b); }
};
