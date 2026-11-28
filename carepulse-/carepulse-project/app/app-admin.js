/* ===== admin sub-screens: Settings, Reports (step 8), Messages (step 6), Privacy + Audit (step 9), Feedback (step 10) ===== */

let ADMPANE = 'team';
const PANES = {
  team: ['Team', () => renderTeam()],
  reports: ['Reports', () => renderReports()],
  messages: ['Messages', () => renderMessages()],
  privacy: ['Privacy', () => renderPrivacy()],
  audit: ['Audit log', () => renderAudit()],
  feedback: ['Feedback', () => renderFeedback()],
  settings: ['Settings', () => renderSettings()]};
function renderAdm() {
  $('#admtabs').replaceChildren(...Object.entries(PANES).map(([k, [l]]) => h('button', {class: k === ADMPANE ? 'on' : '', onclick: () => { ADMPANE = k; renderAdm(); }}, l)));
  $('#adm-team').hidden = ADMPANE !== 'team'; $('#adm-other').hidden = ADMPANE === 'team';
  PANES[ADMPANE][1]();
}
const show = nodes => $('#adm-other').replaceChildren(...nodes);
const num = x => x == null ? '—' : x;
const tile = (l, v, sub) => h('div', {class: 'tile'}, h('small', null, l), h('strong', null, v), sub ? h('span', {class: 'muted', style: 'font-size:12px'}, sub) : null);

function downloadCsv(name, rows) {
  const esc = v => { v = v == null ? '' : String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };   // leading ' stops spreadsheet formulas
  const cols = Object.keys(rows[0] || {});
  const text = [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  const a = h('a', {href: URL.createObjectURL(new Blob(['\ufeff' + text], {type: 'text/csv'})), download: name});
  document.body.append(a); a.click(); a.remove();
}

/* ---------- reports ---------- */
const RANGE = {from: null, to: null};
async function renderReports() {
  const t = today(), d7 = new Date(Date.now() - 6 * 864e5).toLocaleDateString('en-CA', {timeZone: TZ});
  RANGE.from = RANGE.from || d7; RANGE.to = RANGE.to || t;
  const from = h('input', {type: 'date', value: RANGE.from}), to = h('input', {type: 'date', value: RANGE.to});
  const body = h('div');
  const load = async () => {
    RANGE.from = from.value; RANGE.to = to.value;
    const {data, error} = await sb.rpc('report_summary', {p_from: RANGE.from, p_to: RANGE.to});
    if (error) { body.replaceChildren(h('div', {class: 'err'}, error.message)); return; }
    const T = data.totals, max = Math.max(1, ...data.per_day.map(d => d.visits));
    body.replaceChildren(
      h('div', {class: 'tiles'}, tile('Visits', T.visits, T.completed + ' completed'), tile('Avg wait to first call', T.avg_wait_min == null ? '—' : T.avg_wait_min + ' min'),
        tile('Avg consultation', T.avg_consult_min == null ? '—' : T.avg_consult_min + ' min'), tile('Avg report turnaround', T.avg_report_min == null ? '—' : T.avg_report_min + ' min'),
        tile('Collected', rs(T.collected)), tile('Unpaid', rs(T.unpaid), T.unpaid_count + ' bills'), tile('Billed', rs(T.billed))),
      h('h3', {style: 'margin:16px 0 8px'}, 'Visits per day'),
      h('div', {class: 'bars'}, ...data.per_day.map(d => h('div', {class: 'bar', title: d.day + ': ' + d.visits + ' visits, ' + rs(d.collected)},
        h('i', {style: 'height:' + Math.round(d.visits / max * 100) + '%'}), h('span', null, d.day.slice(5))))),
      h('h3', {style: 'margin:16px 0 8px'}, 'By doctor'),
      ...data.per_doctor.map(d => h('div', {class: 'row'}, h('div', null, h('b', null, d.doctor), h('div', {class: 'muted'}, d.dept)),
        h('div', {class: 'muted'}, d.visits + ' visits · wait ' + (d.avg_wait_min == null ? '—' : d.avg_wait_min + ' min') + ' · collected ' + rs(d.collected)))),
      h('h3', {style: 'margin:16px 0 8px'}, 'Unpaid bills' + (data.unpaid.length === 100 ? ' (first 100)' : '')),
      ...(data.unpaid.length ? data.unpaid.map(u => h('div', {class: 'row'}, h('div', null, h('b', null, u.name), h('div', {class: 'muted'}, u.bill + ' · ' + u.phone + ' · ' + u.visit_date)), h('span', {class: 'due'}, rs(u.billed)))) : empty('Nothing unpaid in this range.')),
      h('div', {class: 'inl'},
        h('button', {class: 'btn ghost sm', onclick: e => exportRows(e.target, false)}, 'Export visits (CSV, no names)'),
        h('button', {class: 'btn ghost sm', onclick: e => exportRows(e.target, true)}, 'Export with names and phones'),
        h('button', {class: 'btn ghost sm', onclick: () => downloadCsv('unpaid-' + RANGE.from + '_' + RANGE.to + '.csv', data.unpaid)}, 'Export unpaid (CSV)')));
  };
  const exportRows = (btn, pii) => busy(btn, 'Preparing…', async () => {
    if (pii && !confirm('This file will contain patient names and phone numbers. Keep it safe and delete it when done. The export is recorded in the audit log.')) return;
    const {data, error} = await sb.rpc('report_rows', {p_from: RANGE.from, p_to: RANGE.to, p_pii: pii});
    if (error) { toast(error.message, true); return; }
    if (!data.length) { toast('No visits in this range.', true); return; }
    downloadCsv('visits-' + RANGE.from + '_' + RANGE.to + (pii ? '-with-names' : '') + '.csv', data);
  });
  show([h('div', {class: 'card'}, h('h2', null, 'Dashboard'),
    h('div', {class: 'inl'}, h('label', {style: 'margin:0'}, 'From'), from, h('label', {style: 'margin:0'}, 'To'), to, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Loading…', load)}, 'Show')), body)]);
  load();
}

/* ---------- messages (SMS / WhatsApp outbox) ---------- */
async function renderMessages() {
  const {data, error} = await sb.from('outbox').select('*').order('id', {ascending: false}).limit(60);
  if (error) { show([h('div', {class: 'card'}, ...empty('Could not load messages: ' + error.message + ' (did you run schema_v6.sql?)'))]); return; }
  const n = s => data.filter(m => m.status === s).length;
  show([h('div', {class: 'card'}, h('h2', null, 'Patient messages'),
    h('p', {class: 'muted', style: 'font-size:13px'}, 'Messages are queued when a patient who agreed to SMS is registered, called in, nearly next, or has a report ready. Codes and test names are never sent.'),
    h('div', {class: 'tiles'}, tile('Queued', n('queued')), tile('Sent', n('sent')), tile('Failed', n('failed')), tile('Skipped', n('skipped'))),
    h('div', {class: 'inl'},
      h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Sending…', async () => {
        const {data: r, error: er} = await sb.functions.invoke('send-messages', {body: {}});
        if (er) { toast('The send-messages function is not deployed yet (see NEXT-STEPS.md, step 6).', true); return; }
        toast('Sent ' + r.sent + ', failed ' + r.failed + (r.test_mode ? ' (test mode: no gateway set, nothing left the server)' : '')); renderMessages();
      })}, 'Send now'),
      h('button', {class: 'btn ghost sm', onclick: async e => { await busy(e.target, 'Working…', async () => { await sb.from('outbox').update({status: 'queued', attempts: 0, error: null}).eq('status', 'failed'); renderMessages(); }); }}, 'Retry failed')),
    ...(data.length ? data.map(m => h('div', {class: 'row'}, h('div', null, h('b', null, m.kind.replace(/_/g, ' ')), h('div', {class: 'muted'}, m.phone + ' · ' + m.body), m.error && h('div', {class: 'due', style: 'font-size:12px'}, m.error)),
      h('div', {class: 'muted', style: 'text-align:right'}, h('span', {class: 'st ' + (m.status === 'sent' ? '' : m.status === 'failed' ? 'report_pending' : 'done')}, m.status + (m.provider_id === 'test-mode' ? ' (test mode)' : '')), h('div', {style: 'font-size:12px'}, new Date(m.created_at).toLocaleString())))) : empty('No messages yet.')))]);
}

/* ---------- privacy requests ---------- */
const PRK = {access: 'Copy of data', correction: 'Correction', erasure: 'Deletion', withdraw_consent: 'Withdraw consent', question: 'Question'};
async function renderPrivacy() {
  const {data, error} = await sb.from('privacy_requests').select('*').order('status').order('due_at').limit(100);
  if (error) { show([h('div', {class: 'card'}, ...empty('Could not load requests: ' + error.message))]); return; }
  const setS = (r, status) => async e => {
    const resp = status === 'in_progress' ? null : prompt(status === 'done' ? 'What was done? (shown only to staff)' : 'Why is it rejected? (for example: medical records must be kept by law)');
    if (status !== 'in_progress' && resp === null) return;
    await busy(e.target, 'Saving…', async () => {
      const p = {status}; if (resp) p.response = resp; if (status !== 'in_progress') p.closed_at = new Date().toISOString(); p.handled_by = session.user.id;
      const {error: er} = await sb.from('privacy_requests').update(p).eq('id', r.id); if (er) toast(er.message, true); renderPrivacy();
    });
  };
  show([h('div', {class: 'card'}, h('h2', null, 'Privacy requests'),
    h('p', {class: 'muted', style: 'font-size:13px'}, 'Check the person’s identity (bill number, phone, ID) before sharing or deleting anything. Medical records may have to be kept for a legal period: if so, reject deletion and explain.'),
    ...(data.length ? data.map(r => { const late = r.status !== 'done' && r.status !== 'rejected' && new Date(r.due_at) < Date.now();
      return h('div', {class: 'room'}, h('div', {class: 'row', style: 'border:0;padding:0'},
        h('div', null, h('b', null, PRK[r.kind] + ' — ' + r.name), h('div', {class: 'muted'}, r.phone + (r.bill ? ' · ' + r.bill : '') + ' · asked ' + new Date(r.created_at).toLocaleDateString()), r.details && h('div', null, r.details), r.response && h('div', {class: 'muted'}, 'Answer: ' + r.response)),
        h('div', {class: 'inl', style: 'margin:0'}, h('span', {class: 'st ' + (r.status === 'done' ? 'done' : '')}, r.status.replace('_', ' ')), (r.status === 'open' || r.status === 'in_progress') && h('span', {class: late ? 'due' : 'muted'}, (late ? 'Overdue · ' : 'Due ') + new Date(r.due_at).toLocaleDateString()),
          r.status === 'open' && h('button', {class: 'btn ghost sm', onclick: setS(r, 'in_progress')}, 'Start'),
          (r.status === 'open' || r.status === 'in_progress') && h('button', {class: 'btn sm', onclick: setS(r, 'done')}, 'Done'),
          (r.status === 'open' || r.status === 'in_progress') && h('button', {class: 'btn ghost sm', onclick: setS(r, 'rejected')}, 'Reject')))); }) : empty('No requests.')))]);
}

/* ---------- audit log ---------- */
async function renderAudit() {
  const filter = h('input', {placeholder: 'Filter (action, table, name…)', style: 'max-width:260px'});
  const status = h('span', {class: 'muted'}), list = h('div');
  const {data: staff} = await sb.from('profiles').select('id,full_name');
  const who = id => (staff || []).find(p => p.id === id)?.full_name || 'system';
  const {data, error} = await sb.from('audit_log').select('*').order('seq', {ascending: false}).limit(200);
  if (error) { show([h('div', {class: 'card'}, ...empty('Could not load the audit log: ' + error.message))]); return; }
  const draw = () => {
    const q = filter.value.toLowerCase();
    const rows = data.filter(r => !q || (r.action + ' ' + r.table_name + ' ' + who(r.actor) + ' ' + JSON.stringify(r.detail)).toLowerCase().includes(q));
    list.replaceChildren(...(rows.length ? rows.slice(0, 100).map(r => h('div', {class: 'row', style: 'padding:8px 0'},
      h('div', null, h('b', null, r.action), ' ', h('span', {class: 'muted'}, (r.table_name || '') + (r.row_id ? ' #' + r.row_id : '')),
        h('div', {class: 'muted', style: 'font-size:12px;word-break:break-all'}, Object.keys(r.detail || {}).slice(0, 8).join(', '))),
      h('div', {class: 'muted', style: 'text-align:right;font-size:12px'}, who(r.actor) + (r.actor_role ? ' · ' + r.actor_role : ''), h('div', null, new Date(r.at).toLocaleString())))) : empty('Nothing matches.')));
  };
  filter.oninput = draw;
  show([h('div', {class: 'card'}, h('h2', null, 'Audit log'),
    h('p', {class: 'muted', style: 'font-size:13px'}, 'Every change to patients, bills, staff, settings, prescriptions, stock, beds and claims. It cannot be edited or deleted. Personal details are never stored here, only which field changed. Each line is chained to the one before.'),
    h('div', {class: 'inl'}, filter, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Checking…', async () => {
      const {data: v, error: er} = await sb.rpc('audit_verify');
      if (er) { toast(er.message, true); return; }
      status.className = v.ok ? 'paid' : 'due';
      status.textContent = v.ok ? '✓ Chain intact (' + v.checked + ' lines). Newest fingerprint: ' + (v.head || '').slice(0, 16) + '… Write it down now and then. If it ever changes backwards, history was edited.' : '✗ History was changed near line ' + v.bad_seq + '. Call your IT person.';
    })}, 'Verify chain')), h('div', {style: 'margin:8px 0'}, status), list)]);
  draw();
}

/* ---------- feedback ---------- */
async function renderFeedback() {
  const {data, error} = await sb.from('feedback').select('*').order('id', {ascending: false}).limit(100);
  if (error) { show([h('div', {class: 'card'}, ...empty('Could not load feedback: ' + error.message))]); return; }
  const {data: staff} = await sb.from('profiles').select('id,full_name'); const who = id => (staff || []).find(p => p.id === id)?.full_name || '—';
  const set = (f, status) => async e => { await busy(e.target, '…', async () => { await sb.from('feedback').update({status}).eq('id', f.id); renderFeedback(); }); };
  show([h('div', {class: 'card'}, h('h2', null, 'Staff feedback (' + data.filter(f => f.status === 'new').length + ' new)'),
    ...(data.length ? data.map(f => h('div', {class: 'row'},
      h('div', null, h('div', null, h('b', null, f.kind), ' ', h('span', {class: 'muted'}, who(f.user_id) + ' · ' + (f.role || '') + ' · screen: ' + (f.screen || '') + ' · ' + new Date(f.at).toLocaleString())), h('div', null, f.message)),
      h('div', {class: 'inl', style: 'margin:0'}, h('span', {class: 'st ' + (f.status === 'fixed' ? 'done' : '')}, f.status),
        f.status === 'new' && h('button', {class: 'btn ghost sm', onclick: set(f, 'seen')}, 'Seen'),
        f.status !== 'fixed' && h('button', {class: 'btn sm', onclick: set(f, 'fixed')}, 'Fixed')))) : empty('No feedback yet.')))]);
}

/* ---------- settings + retention ---------- */
const SETDEF = [['clinic_name', 'Clinic name', 'Shown on slips, bills, messages and the queue board.'],
  ['site_url', 'Public address of this app', 'Example: https://yourclinic.example/app/ — used in QR codes and SMS. Leave empty while testing.'],
  ['ahead_threshold', 'Tell patients when this many are ahead', 'For example 2 sends “2 patients ahead” once.'],
  ['retention_days', 'Keep patient details for (days)', 'After this, old visits are anonymised. Check the legal rules for medical records in your country before changing. Minimum 90.']];
async function renderSettings() {
  SET = await loadSettings();
  const inputs = SETDEF.map(([k, l, hint]) => [k, h('input', {value: SET[k] ?? '', 'aria-label': l}), l, hint]);
  const mfa = h('input', {type: 'checkbox', id: 'smfa'}); mfa.checked = SET.require_mfa === 'true';
  const prev = h('div'), files = h('div');
  show([h('div', {class: 'grid'}, h('div', null, h('div', {class: 'card'}, h('h2', null, 'Clinic settings'),
    ...inputs.flatMap(([k, el, l, hint]) => [h('label', null, l), el, h('div', {class: 'muted', style: 'font-size:12px;margin-top:3px'}, hint)]),
    h('label', {class: 'chk', style: 'margin-top:16px', for: 'smfa'}, mfa, 'Require two-factor login for all staff'),
    h('div', {class: 'muted', style: 'font-size:12px;margin-top:3px'}, 'Turn this on only after you yourself have set up 2FA (Security tab). Staff without 2FA will be asked to set it up at their next login.'),
    h('button', {class: 'btn full', onclick: e => busy(e.target, 'Saving…', async () => {
      if (mfa.checked && SET.require_mfa !== 'true' && !(await totpFactors()).length) { toast('Set up 2FA for your own account first (Security tab).', true); return; }
      const rows = inputs.map(([k, el]) => ({key: k, value: el.value.trim()})).concat([{key: 'require_mfa', value: mfa.checked ? 'true' : 'false'}]);
      const rd = +rows.find(r => r.key === 'retention_days').value, th = +rows.find(r => r.key === 'ahead_threshold').value;
      if (!(rd >= 90) || !(th >= 0 && th <= 20)) { toast('Retention must be 90 days or more, and “ahead” between 0 and 20.', true); return; }
      const {error} = await sb.from('settings').upsert(rows);
      if (error) toast(error.message, true); else { toast('Settings saved.'); SET = await loadSettings(); }
    })}, 'Save settings'))),
    h('div', null, h('div', {class: 'card'}, h('h2', null, 'Data retention'),
      h('p', {class: 'muted', style: 'font-size:13px'}, 'Removes names, phones, reasons, allergies and report files from old visits. Bill amounts and counts stay for your reports. The audit log is never touched. This cannot be undone.'),
      h('div', {class: 'inl'}, h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Checking…', async () => {
        const {data, error} = await sb.rpc('retention_preview'); if (error) { toast(error.message, true); return; }
        prev.replaceChildren(h('div', {class: 'note'}, 'Older than ' + data.days + ' days (before ' + data.cutoff + '): ' + data.visits + ' visits (' + data.files + ' with report files), ' + data.appointments + ' old appointment requests, ' + data.messages + ' old messages. Files waiting to be deleted: ' + data.pending_files + '.'));
      })}, 'Preview'), h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Running…', async () => {
        if (!confirm('Anonymise old visits now? This cannot be undone.')) return;
        const {data, error} = await sb.rpc('retention_run'); if (error) { toast(error.message, true); return; }
        toast(data.visits + ' visits anonymised.'); await purgeFiles(files);
      })}, 'Run now'), h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Deleting…', () => purgeFiles(files))}, 'Delete queued files')), prev, files)))]);
}
async function loadSettings() {
  const {data} = await sb.from('settings').select('key,value');
  return Object.fromEntries((data || []).map(r => [r.key, r.value]));
}
async function purgeFiles(out) {
  let total = 0;
  for (let i = 0; i < 20; i++) {   // up to 2000 files per click
    const {data: paths, error} = await sb.rpc('retention_pending_files');
    if (error || !paths || !paths.length) break;
    const {error: re} = await sb.storage.from('reports').remove(paths);
    if (re) { toast('Could not delete files: ' + re.message, true); break; }
    await sb.rpc('retention_files_done', {p_paths: paths}); total += paths.length;
  }
  out.replaceChildren(h('div', {class: 'note'}, total + ' report files deleted.'));
}
