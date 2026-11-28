/* ===== step 2: queue board for doctor and reception, with realtime updates =====
   Loads after app-modules.js (and app-patients.js if you have it), before app-start.js. Needs schema_v12_queue.sql.
   - Doctor: Now seeing / Next up / Waiting / Back from lab / At lab, one-tap "Call next" (key N), patient summary on each card,
             a sound + highlight when a report comes back.
   - Reception: live queue beside registration, filters by doctor and status.
   - Both: updates the moment something changes (Supabase Realtime). The old 5-second refresh stays as a fallback, but a screen
           is only redrawn when its data really changed, so nothing jumps or loses typed text. */

const QB = {sig: '', seen: null, did: null, last: Date.now(), live: false, chan: null, pending: false, mute: false, ac: null, fresh: {}};
try { QB.mute = localStorage.getItem('qb.mute') === '1'; } catch (_) {}
LBL.review = 'Back from lab';
const qbWait = t => Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
const qbByQ = (a, b) => new Date(a.q_at) - new Date(b.q_at) || a.id - b.id;     // same order as the patient's own "you are Nth"

document.head.append(h('style', null, `
.qbbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
.qbbar select{width:auto;min-height:44px}
.qbbar .btn,.qbx .btn{min-height:44px}
.qbstamp{font-size:12px;color:var(--mut)} .qbstamp.live{color:var(--g);font-weight:600}
.qbgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;align-items:start}
.qbcol h2{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.qbcount{font-size:12px;background:var(--mint);color:var(--ink);border-radius:99px;padding:2px 10px}
.qc{display:flex;gap:10px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-top:8px;background:#fff}
.qc.next{border-color:var(--g);box-shadow:0 0 0 2px rgba(43,166,122,.18)}
.qc.fresh{border-color:#e0a100;background:#fff8e1}
.qc .tk{font-weight:700;font-size:18px;min-width:44px}
.qc .bd{flex:1;min-width:0}
.qc .bd .muted{font-size:12px}
.qc .al{display:inline-block;background:#fdecea;color:#b42318;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:600;margin-top:2px}
.qkeys{font-size:12px;color:var(--mut)} kbd{border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:inherit;font-size:11px;background:#fff}
.qbx .row{align-items:center}
.qbtn{font-size:16px;padding:12px 20px}
@media (max-width:760px){.qc{flex-wrap:wrap}.qc .btn{width:100%}}
`));

/* ---------- sound / vibration (audio only starts after the first click or tap, a browser rule) ---------- */
document.addEventListener('pointerdown', () => {
  try { QB.ac = QB.ac || new (window.AudioContext || window.webkitAudioContext)(); QB.ac.resume && QB.ac.resume(); } catch (_) {}
}, {passive: true});
function qbBeep() {
  if (QB.mute) return;
  try {
    const a = QB.ac; if (!a) return;
    const o = a.createOscillator(), g = a.createGain(); o.connect(g); g.connect(a.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(.18, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .5);
    o.start(); o.stop(a.currentTime + .5);
    navigator.vibrate && navigator.vibrate(120);
  } catch (_) {}
}

/* ---------- realtime ---------- */
let qbT;
const qbTyping = () => { const e = document.activeElement; return !!e && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.tagName) && !!e.closest('#dview,#rec'); };
function qbChanged() {                      // a visit changed somewhere: redraw soon, but never while someone is typing
  clearTimeout(qbT);
  qbT = setTimeout(() => { if (!['doc', 'rec'].includes(view)) return; if (qbTyping()) QB.pending = true; else render(); }, 300);
}
document.addEventListener('focusout', () => setTimeout(() => { if (QB.pending && !qbTyping()) { QB.pending = false; render(); } }, 200));
function qbLive() {
  if (!session) { if (QB.chan) { try { sb.removeChannel(QB.chan); } catch (_) {} QB.chan = null; QB.live = false; } return; }
  if (QB.chan || !sb.channel) return;
  try {
    QB.chan = sb.channel('visits-live').on('postgres_changes', {event: '*', schema: 'public', table: 'visits'}, qbChanged)
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
async function qbLastVisits(vs) {           // "last visit" for the summary line (visits with this doctor, before today)
  const ids = [...new Set(vs.map(v => v.patient_id).filter(Boolean))], m = {};
  if (!ids.length) return m;
  const r = await sb.from('visits').select('patient_id,visit_date').in('patient_id', ids).lt('visit_date', today()).order('visit_date', {ascending: false});
  (r.data || []).forEach(x => { if (!(x.patient_id in m)) m[x.patient_id] = x.visit_date; });
  return m;
}
function qbCard(v, cls, last) {
  const w = qbWait(v.q_at), lv = v.patient_id && last[v.patient_id];
  return h('div', {class: 'qc ' + cls + (QB.fresh[v.id] > Date.now() ? ' fresh' : '')},
    h('div', {class: 'tk'}, tk(v.token)),
    h('div', {class: 'bd'}, h('b', null, v.name), v.status === 'review' && h('span', {class: 'muted'}, ' · report is back'),
      h('div', {class: 'muted'}, [v.age ? v.age + ' yrs' : null, v.reason || 'No reason noted'].filter(Boolean).join(' · ')),
      v.allergies && h('span', {class: 'al'}, 'Allergies: ' + v.allergies),
      h('div', {class: 'muted'}, (lv ? 'Last visit ' + lv : 'First visit with you') + ' · waiting ' + w + ' min')),
    h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Calling…', () => act(v.id, {status: 'in_room'}))}, 'Call in'));
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
window.renderDoc = async function () {
  qbLive();
  const did = $('#dsel').value;
  await window.loadDrugs?.();
  const mine = (await todays()).filter(v => v.doctor_id === did);
  QB.last = Date.now();
  const inRoom = mine.filter(v => v.status === 'in_room').sort(qbByQ);
  const q = mine.filter(v => v.status === 'waiting' || v.status === 'review').sort(qbByQ);
  const lab = mine.filter(v => v.status === 'report_pending').sort((a, b) => new Date(a.test_due) - new Date(b.test_due));
  // cue when a report comes back
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
  const sig = did + '|' + mine.map(v => [v.id, v.status, v.q_at, v.test_name, v.test_due, v.report_path ? 1 : 0, v.allergies, Object.keys(QB.fresh).length && QB.fresh[v.id] > Date.now() ? 1 : 0].join(',')).join(';');
  if (sig === QB.sig && $('#dview').firstChild) { qbStamp(); return; }       // nothing changed: leave the screen alone
  QB.sig = sig;
  const last = await qbLastVisits(mine);
  const next = q.slice(0, 3), rest = q.slice(3), nid = new Set(next.map(v => v.id));
  const waiting = rest.filter(v => v.status === 'waiting'), back = rest.filter(v => v.status === 'review');
  const col = (title, list, build, emptyMsg) => h('div', {class: 'card qbcol'},
    h('h2', null, title, h('span', {class: 'qbcount'}, String(list.length))), ...(list.length ? list.map(build) : empty(emptyMsg)));
  const nextBtn = h('button', {class: 'btn qbtn', id: 'qbnext', onclick: e => qbCallNext(e.target)}, q.length ? 'Call next (' + q.length + ')' : 'Call next');
  nextBtn.disabled = !q.length;
  const y = window.scrollY;
  $('#dview').replaceChildren(
    h('div', {class: 'qbbar qbx'}, nextBtn,
      h('button', {class: 'btn ghost sm', onclick: qbRefresh}, 'Refresh'),
      h('button', {class: 'btn ghost sm', 'aria-pressed': String(!QB.mute), onclick: e => { QB.mute = !QB.mute; try { localStorage.setItem('qb.mute', QB.mute ? '1' : '0'); } catch (_) {} e.target.textContent = QB.mute ? 'Sound off' : 'Sound on'; e.target.setAttribute('aria-pressed', String(!QB.mute)); }}, QB.mute ? 'Sound off' : 'Sound on'),
      h('span', {class: 'qbstamp'}), h('span', {class: 'qkeys'}, h('kbd', null, 'N'), ' call next · ', h('kbd', null, 'R'), ' refresh')),
    h('div', {class: 'card'}, h('h2', null, 'Now seeing', h('span', {class: 'qbcount'}, String(inRoom.length))),
      ...(inRoom.length ? inRoom.map(roomRow) : empty('Nobody in the room. Press N or “Call next”.'))),
    h('div', {class: 'qbgrid'},
      col('Next up', next, v => qbCard(v, 'next', last), 'No patients waiting.'),
      col('Waiting', waiting, v => qbCard(v, '', last), 'Nobody else is waiting.'),
      col('Back from lab', back, v => qbCard(v, '', last), 'No reports back yet.'),
      col('At lab', lab, v => h('div', {class: 'qc'}, h('div', {class: 'tk'}, tk(v.token)),
        h('div', {class: 'bd'}, h('b', null, v.name), h('div', {class: 'muted'}, v.test_name + ' · expected ' + hm(v.test_due) + (new Date(v.test_due) < Date.now() ? ' (late)' : ''))), st('report_pending')), 'No reports pending.')));
  window.scrollTo(window.scrollX, y);
  qbStamp();
};
$('#dsel').onchange = () => { QB.sig = ''; QB.seen = null; window.renderDoc(); };     // app.js bound the old function; point it at the new board

document.addEventListener('keydown', e => {
  if (view !== 'doc' || e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable) return;   // never steal keys while typing
  const k = e.key.toLowerCase();
  if (k === 'n') { e.preventDefault(); const b = $('#qbnext'); if (b && !b.disabled) qbCallNext(b); }
  else if (k === 'r') { e.preventDefault(); qbRefresh(); }
});

/* ---------- reception: live queue beside the registration form, with filters ---------- */
const RQ = {doc: '', st: 'active', sig: ''};
const RQ_ST = [['active', 'Active (not completed)'], ['waiting', 'Waiting'], ['in_room', 'With doctor'], ['report_pending', 'At lab'], ['review', 'Back from lab'], ['done', 'Completed'], ['all', 'All']];
const rqd = h('select', {id: 'rqd', 'aria-label': 'Filter by doctor'});
const rqs = h('select', {id: 'rqs', 'aria-label': 'Filter by status'}, ...RQ_ST.map(([k, l]) => h('option', {value: k}, l)));
rqd.onchange = () => { RQ.doc = rqd.value; RQ.sig = ''; recDraw(); };      // (h() only supports onclick; other handlers are set as properties)
rqs.onchange = () => { RQ.st = rqs.value; RQ.sig = ''; recDraw(); };
const rq = h('div', {id: 'rq', 'aria-live': 'polite'}), rqsum = h('div', {class: 'muted', style: 'margin:0 0 4px;font-size:13px'});
$('#rlist').hidden = true;                  // the old list is still filled by app.js, we just show our own
$('#rlist').before(h('div', {class: 'qbbar qbx'}, rqd, rqs, h('button', {class: 'btn ghost sm', onclick: qbRefresh}, 'Refresh'), h('span', {class: 'qbstamp'})), rqsum, rq);
const RQ_ORDER = {in_room: 0, review: 1, waiting: 2, report_pending: 3, done: 4};
function recDraw() {
  if (!Array.isArray(VT)) return;
  if (rqd.options.length !== DOCS.length + 1) { rqd.replaceChildren(h('option', {value: ''}, 'All doctors'), ...DOCS.map(d => h('option', {value: d.id}, d.name))); rqd.value = RQ.doc; }
  const sig = RQ.doc + '|' + RQ.st + '|' + Math.floor(Date.now() / 60000) + '|' + VT.map(v => [v.id, v.status, v.q_at, v.paid_at ? 1 : 0, v.name].join(',')).join(';');
  if (sig === RQ.sig) { qbStamp(); return; }
  RQ.sig = sig; QB.last = Date.now();
  let l = VT.filter(v => (!RQ.doc || v.doctor_id === RQ.doc) && (RQ.st === 'all' || (RQ.st === 'active' ? v.status !== 'done' : v.status === RQ.st)));
  l = l.sort((a, b) => (RQ_ORDER[a.status] - RQ_ORDER[b.status]) || qbByQ(a, b));
  const n = s => VT.filter(v => (!RQ.doc || v.doctor_id === RQ.doc) && v.status === s).length;
  rqsum.textContent = n('waiting') + ' waiting · ' + n('in_room') + ' with doctor · ' + n('report_pending') + ' at lab · ' + n('review') + ' back from lab';
  const y = window.scrollY;
  rq.replaceChildren(...(l.length ? l.map(v => h('div', {class: 'row'},
    h('div', null, h('b', null, tk(v.token) + ' · ' + v.name), h('div', {class: 'muted'}, doc(v.doctor_id).name + ' · ' + v.bill + (v.status === 'waiting' || v.status === 'review' ? ' · waiting ' + qbWait(v.q_at) + ' min' : ''))),
    h('div', {class: 'inl', style: 'margin:0'}, st(v.status), h('span', {class: v.paid_at ? 'paid' : 'due'}, v.paid_at ? 'Paid' : 'Unpaid'),
      h('button', {class: 'btn ghost sm', onclick: () => printSlip(v)}, 'Slip')))) :
    empty(RQ.st === 'waiting' || RQ.st === 'active' ? 'No patients waiting.' : 'No visits match this filter.')));
  window.scrollTo(window.scrollX, y);
  qbStamp();
}
const _renderRec = window.renderRec;
window.renderRec = async function () { qbLive(); await _renderRec(); recDraw(); };
