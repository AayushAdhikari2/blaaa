/* ===== step 4: notifications =====
   Loads after app-queue.js, before app-start.js. Needs schema_v14_notify.sql.
   - Reception: each patient in the live queue shows "SMS sent / queued / failed / No SMS", so reception knows who was told.
   - Admin > Messages: "Queue tomorrow's reminders" button and editable message wording with a live preview. */

/* ---------- reception: message status per visit ---------- */
window.MSGST = {};
window.msgLoad = async function () {
  if (!me || !['reception', 'admin'].includes(me.role) || !Array.isArray(VT) || !VT.length) return;
  const {data, error} = await sb.rpc('msg_status', {p_visit_ids: VT.map(v => v.id).slice(0, 200)});
  if (!error && data) window.MSGST = data;
};

/* ---------- admin: reminders + wording ---------- */
const NT_SAMPLE = {clinic: 'Your Clinic', name: 'Sita', doctor: 'Dr. Sharma', token: 'T-07', bill: 'BL-20261128-0001', n: '2', s: 's', date: 'Sun 29 Nov', time: '10:30 AM', link: ''};
const ntPreview = b => Object.entries(NT_SAMPLE).reduce((t, [k, v]) => t.split('{' + k + '}').join(v), b);

function ntReminders() {
  return h('div', {class: 'card'}, h('h2', null, 'Day-before reminders'),
    h('p', {class: 'muted', style: 'font-size:13px'}, 'Patients with a confirmed appointment tomorrow, or a follow-up date tomorrow, get one reminder (only if they agreed to SMS). The same patient never gets the same reminder twice. To send them automatically every afternoon, see the cron line at the end of schema_v14_notify.sql.'),
    h('button', {class: 'btn', onclick: e => busy(e.target, 'Queuing…', async () => {
      const {data, error} = await sb.rpc('queue_all_reminders');
      if (error) { toast(errText(error), true); return; }
      const a = data.queue_appt_reminders ?? 0, f = data.queue_followup_reminders ?? 0;
      toast('Queued ' + a + ' appointment and ' + f + ' follow-up reminder' + (a + f === 1 ? '' : 's') + '.'); kick();
    })}, 'Queue tomorrow’s reminders now'));
}

async function ntWording() {
  const {data, error} = await sb.from('msg_templates').select('*').order('kind');
  const card = h('div', {class: 'card'}, h('h2', null, 'Message wording'),
    h('p', {class: 'muted', style: 'font-size:13px'}, 'Placeholders: {clinic} {name} {doctor} {token} {bill} {n} {s} {date} {time} {link}. A text message is one SMS up to 160 characters; longer messages cost more, and Nepali (Unicode) letters fit only 70 per SMS. Never put the access code or test names in a message.'));
  if (error) { card.append(h('div', {class: 'err'}, errText(error))); return card; }
  (data || []).forEach(t => {
    const ta = h('textarea', {rows: '2', maxlength: '320', 'aria-label': t.label, style: 'width:100%'}); ta.value = t.body;
    const info = h('div', {class: 'muted', style: 'font-size:12px;margin-top:2px'});
    const upd = () => { const n = ntPreview(ta.value).length; info.textContent = 'Preview: ' + ntPreview(ta.value) + '  (' + n + ' characters' + (n > 160 ? ', more than one SMS' : '') + ')'; };
    ta.oninput = upd; upd();
    card.append(h('div', {style: 'margin-top:12px'}, h('b', null, t.label), ta, info,
      h('button', {class: 'btn ghost sm', style: 'margin-top:6px', onclick: e => busy(e.target, 'Saving…', async () => {
        if (ta.value.trim().length < 5) { toast('The message is too short.', true); return; }
        const r = await sb.from('msg_templates').update({body: ta.value.trim(), updated_at: new Date().toISOString()}).eq('kind', t.kind);
        toast(r.error ? errText(r.error) : 'Saved: ' + t.label, !!r.error);
      })}, 'Save')));
  });
  return card;
}

if (typeof PANES !== 'undefined' && PANES.messages) {
  const _msgPane = PANES.messages[1];
  PANES.messages[1] = async () => { await _msgPane(); $('#adm-other').append(ntReminders(), await ntWording()); };
}
