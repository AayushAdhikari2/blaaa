/* Carepulse Automation Engine dashboard — vanilla JS, no frameworks, no secrets. */
const $ = (sel) => document.querySelector(sel);
const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v === null || v === undefined || v === '' ? '—' : esc(v));
const badge = (status) => {
  const s = String(status ?? '').toLowerCase();
  const cls = ['succeeded', 'ok', 'valid', 'processed'].includes(s) ? 'ok'
    : ['retry_scheduled', 'pending', 'processing', 'retry', 'partial', 'retry scheduled'].includes(s) ? 'warn'
    : ['failed', 'dead_letter', 'dead-letter', 'rejected', 'error', 'invalid', 'unknown_event_type'].includes(s) ? 'err' : 'neutral';
  return `<span class="badge ${cls}">${fmt(status)}</span>`;
};

let currentEvent = null;

/* ---------- tabs ---------- */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    tab.classList.add('active');
    $(`#${tab.dataset.section}`).classList.add('active');
    refreshSection(tab.dataset.section);
  });
});

function table(rows, cols, empty = 'No records.') {
  if (!rows.length) return `<div class="tablewrap"><div class="empty">${empty}</div></div>`;
  return `<div class="tablewrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${
    rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.mono ? 'mono' : ''}">${c.render ? c.render(r) : fmt(r[c.key])}</td>`).join('')}</tr>`).join('')
  }</tbody></table></div>`;
}

/* ---------- overview ---------- */
async function refreshOverview() {
  const m = await api('/api/metrics');
  const cards = [
    ['Total events', m.total_events], ['Processed', m.processed_events], ['Failed events', m.failed_events],
    ['Notifications', m.notification_count], ['Pending deliveries', m.pending_deliveries],
    ['Retries', m.retry_count], ['Dead-letter', m.dead_letter_count],
    ['Success rate', m.success_rate === null ? '—' : `${Math.round(m.success_rate * 100)}%`],
    ['Avg duration', m.processing_duration_ms_avg === null ? '—' : `${Math.round(m.processing_duration_ms_avg)} ms`],
  ];
  $('#metric-cards').innerHTML = cards.map(([label, value]) => `<div class="card"><div class="label">${esc(label)}</div><div class="value">${fmt(value)}</div></div>`).join('');
}

/* ---------- simulator ---------- */
$('#btn-generate').addEventListener('click', async () => {
  const appointmentId = $('#sim-appointment-id').value.trim() || undefined;
  const r = await api('/api/simulate/generate', { method: 'POST', body: appointmentId ? { appointmentId } : {} });
  currentEvent = r.event;
  $('#sim-event').textContent = JSON.stringify(r.event, null, 2);
  $('#sim-result').textContent = 'event generated (synthetic). Press "Process event".';
  $('#sim-per-recipient').innerHTML = '';
});

function requireEvent() {
  if (!currentEvent) throw new Error('Generate a synthetic appointment request first.');
  return currentEvent;
}

async function processAndShow(path, body = {}) {
  const event = requireEvent();
  const result = await api(path, { method: 'POST', body: { event, ...body } });
  $('#sim-result').textContent = JSON.stringify(result, null, 2);
  renderPerRecipient(result.per_recipient ?? result.result?.per_recipient ?? []);
  await refreshOverview();
  return result;
}

function renderPerRecipient(rows) {
  $('#sim-per-recipient').innerHTML = table(rows ?? [], [
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Status', render: (r) => badge(r.status ?? r.delivery_status) },
    { label: 'Attempts', key: 'attempts' },
    { label: 'Next retry', key: 'next_retry_at', mono: true },
    { label: 'Last error', key: 'last_error' },
    { label: 'Inspect', render: (r) => (r.delivery_id ? `<button data-inspect="${esc(r.delivery_id)}">Inspect per-recipient results</button>` : '—') },
  ], 'No per-recipient results.');
  document.querySelectorAll('[data-inspect]').forEach((b) =>
    b.addEventListener('click', () => inspectDelivery(b.dataset.inspect)));
}

async function inspectDelivery(deliveryId) {
  // pull event per-recipient + show raw delivery in result pane
  const ev = currentEvent?.event_id;
  if (ev) {
    const data = await api(`/api/events/${encodeURIComponent(ev)}`);
    const mine = (data.per_recipient ?? []).filter((p) => p.delivery_id === deliveryId);
    $('#sim-result').textContent = JSON.stringify(mine.length ? mine : data.per_recipient, null, 2);
  }
}

$('#btn-process').addEventListener('click', () => processAndShow('/api/process').catch(showErr));
$('#btn-dryrun').addEventListener('click', async () => {
  try {
    const event = requireEvent();
    const result = await api('/api/dry-run', { method: 'POST', body: { event } });
    $('#sim-result').textContent = JSON.stringify(result, null, 2);
    renderPerRecipient(result.result?.plannedNotifications?.map((p) => ({ recipient_id: p.recipient_id, status: 'planned' })) ?? []);
  } catch (e) { showErr(e); }
});
$('#btn-tempfail').addEventListener('click', () => processAndShow('/api/simulate/temporary-failure').catch(showErr));
$('#btn-permfail').addEventListener('click', () => processAndShow('/api/simulate/permanent-failure').catch(showErr));
$('#btn-replay-event').addEventListener('click', async () => {
  try {
    const event = requireEvent();
    const result = await api(`/api/replay/event/${encodeURIComponent(event.event_id)}`, { method: 'POST', body: {} });
    $('#sim-result').textContent = JSON.stringify(result, null, 2);
    renderPerRecipient(result.per_recipient ?? []);
    await refreshOverview();
  } catch (e) { showErr(e); }
});

function showErr(e) { $('#sim-result').textContent = `ERROR: ${e.message}`; }

/* ---------- event monitor ---------- */
async function refreshEvents() {
  const { events } = await api('/api/events');
  $('#events-table').innerHTML = table(events, [
    { label: 'Event', key: 'event_id', mono: true },
    { label: 'Type', key: 'event_type' },
    { label: 'Appointment', render: (e) => fmt(e.payload?.appointment_id) },
    { label: 'Status', render: (e) => badge(e.status) },
    { label: 'Received', key: 'received_at', mono: true },
    { label: 'Duration', render: (e) => (e.processing_duration_ms == null ? '—' : `${e.processing_duration_ms} ms`) },
    { label: 'Replays', key: 'replay_count' },
  ], 'No events yet. Generate a synthetic appointment request.');
}

/* ---------- notifications ---------- */
async function refreshNotifications() {
  const { notifications } = await api('/api/notifications');
  $('#notifications-table').innerHTML = table(notifications, [
    { label: 'Title', key: 'title' },
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Appointment', key: 'appointment_id', mono: true },
    { label: 'Type', key: 'notification_type' },
    { label: 'Channel', key: 'channel' },
    { label: 'Delivery', render: (n) => badge(n.delivery_status) },
    { label: 'Created', key: 'created_at', mono: true },
    { label: 'Body', key: 'body' },
  ], 'No notifications yet.');
}

/* ---------- execution history ---------- */
async function refreshExecutions() {
  const { executions } = await api('/api/executions');
  $('#executions-table').innerHTML = table(executions, [
    { label: 'Seq', key: 'seq' },
    { label: 'At', key: 'at', mono: true },
    { label: 'Type', key: 'type', mono: true },
    { label: 'Event', key: 'event_id', mono: true },
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Detail', render: (e) => `<code>${esc(JSON.stringify(stripMeta(e)))}</code>` },
  ], 'No execution history yet.');
}
function stripMeta(e) { const { seq, at, type, event_id, recipient_id, audit_id, ...rest } = e; return rest; }

/* ---------- retry queue ---------- */
async function refreshRetries() {
  const { retries } = await api('/api/retries');
  $('#retries-table').innerHTML = table(retries, [
    { label: 'Delivery', key: 'delivery_id', mono: true },
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Status', render: (d) => badge(d.status) },
    { label: 'Attempts', render: (d) => `${d.attempts}/${d.max_attempts}` },
    { label: 'Next retry', key: 'next_retry_at', mono: true },
    { label: 'Last error', key: 'last_error' },
    { label: 'Retry', render: (d) => `<button data-retry="${esc(d.delivery_id)}">Retry failed delivery</button>` },
  ], 'Retry queue is empty.');
  document.querySelectorAll('[data-retry]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/retry/${encodeURIComponent(b.dataset.retry)}`, { method: 'POST', body: {} });
    await refreshRetries(); await refreshOverview();
  }));
}
$('#btn-process-due').addEventListener('click', async () => { await api('/api/retry/process-due', { method: 'POST', body: {} }); await refreshRetries(); await refreshOverview(); });
$('#btn-refresh-retries').addEventListener('click', refreshRetries);

/* ---------- dead letter ---------- */
async function refreshDead() {
  const { dead_letter } = await api('/api/dead-letter');
  $('#dead-table').innerHTML = table(dead_letter, [
    { label: 'Delivery', key: 'delivery_id', mono: true },
    { label: 'Event', key: 'event_id', mono: true },
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Attempts', render: (d) => `${d.attempts}/${d.max_attempts}` },
    { label: 'Failure', render: (d) => badge(d.last_failure_class) },
    { label: 'Last error', key: 'last_error' },
    { label: 'Replay', render: (d) => `<button data-replay="${esc(d.delivery_id)}">Replay eligible event</button>` },
  ], 'Dead letter queue is empty.');
  document.querySelectorAll('[data-replay]').forEach((b) => b.addEventListener('click', async () => {
    await api(`/api/replay/delivery/${encodeURIComponent(b.dataset.replay)}`, { method: 'POST', body: {} });
    await refreshDead(); await refreshOverview();
  }));
}
$('#btn-refresh-dead').addEventListener('click', refreshDead);

/* ---------- audit ---------- */
async function refreshAudit() {
  const { audit } = await api('/api/audit');
  $('#audit-table').innerHTML = table(audit, [
    { label: 'Seq', key: 'seq' },
    { label: 'At', key: 'at', mono: true },
    { label: 'Type', key: 'type', mono: true },
    { label: 'Event', key: 'event_id', mono: true },
    { label: 'Recipient', key: 'recipient_id', mono: true },
    { label: 'Detail', render: (e) => `<code>${esc(JSON.stringify(stripMeta(e)))}</code>` },
  ], 'No audit entries yet.');
}
$('#btn-refresh-audit').addEventListener('click', refreshAudit);

/* ---------- health ---------- */
async function refreshHealth() {
  const health = await api('/api/health');
  $('#health-json').textContent = JSON.stringify(health, null, 2);
  const recipients = await api('/api/recipients');
  $('#recipients').innerHTML = table(recipients.directory, [
    { label: 'ID', key: 'id', mono: true },
    { label: 'Role', render: (r) => `<span class="badge role">${esc(r.role)}</span>` },
    { label: 'Active', render: (r) => (r.active ? badge('ok') : badge('neutral')) },
  ]);
}
$('#btn-refresh-health').addEventListener('click', refreshHealth);

/* ---------- misc ---------- */
$('#btn-refresh-events').addEventListener('click', refreshEvents);
$('#btn-refresh-notifications').addEventListener('click', refreshNotifications);
$('#btn-refresh-executions').addEventListener('click', refreshExecutions);

function refreshSection(section) {
  ({ overview: refreshOverview, monitor: refreshEvents, notifications: refreshNotifications,
     executions: refreshExecutions, retries: refreshRetries, deadletter: refreshDead,
     audit: refreshAudit, health: refreshHealth }[section] ?? (() => {}))();
}

refreshOverview();
