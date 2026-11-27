import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { LOCAL_STATE_DIR } from '../src/paths.js';

const MODULE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const stateDir = path.join(LOCAL_STATE_DIR, 'dashboard-test');

async function api(path, options = {}) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...options, body: options.body ? JSON.stringify(options.body) : undefined });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('dashboard simulation (real local engine, no Supabase)', async (t) => {
  await rm(stateDir, { recursive: true, force: true });
  const child = spawn(process.execPath, [path.join(MODULE_ROOT, 'dashboard', 'server.js')], {
    env: { ...process.env, AUTOMATION_DASHBOARD_PORT: String(PORT), AUTOMATION_DASHBOARD_HOST: '127.0.0.1', AUTOMATION_STATE_DIR: stateDir },
    stdio: 'ignore',
  });
  t.after(() => { child.kill(); });

  // wait for server
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await api('/api/health'); if (r.status === 200) { up = true; break; } } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(up, 'dashboard server did not start');

  // static dashboard served
  const page = await fetch(BASE + '/');
  const html = await page.text();
  assert.ok(html.includes('DEMO MODE — NOT CONNECTED TO SUPABASE'));
  assert.ok(html.includes('Event Simulator'));
  assert.ok(html.includes('Dead Letter Queue'));
  assert.ok(!html.includes('service_role'));

  // health
  const health = await api('/api/health');
  assert.equal(health.body.status, 'ok');
  assert.ok(health.body.mode.includes('NOT CONNECTED TO SUPABASE'));

  // generate synthetic
  const gen = await api('/api/simulate/generate', { method: 'POST', body: {} });
  assert.equal(gen.body.synthetic, true);
  const event = gen.body.event;
  assert.equal(event.event_type, 'appointment.requested');
  assert.equal(event.payload.appointment_id, event.source_id);
  assert.ok(!JSON.stringify(event).includes('name'));

  // recipients synthetic; no doctor/lab eligible
  const rec = await api('/api/recipients');
  assert.ok(rec.body.eligible_reception_admin.every((r) => r.role === 'reception' || r.role === 'admin'));
  assert.equal(rec.body.eligible_reception_admin.length, 4);

  // dry-run first
  const dry = await api('/api/dry-run', { method: 'POST', body: { event } });
  assert.equal(dry.body.ok, true);
  assert.equal(dry.body.dryRun, true);

  // process
  const proc = await api('/api/process', { method: 'POST', body: { event } });
  assert.equal(proc.body.ok, true);
  assert.equal(proc.body.per_recipient.length, 4);

  // per-recipient inspect
  const inspect = await api(`/api/events/${encodeURIComponent(event.event_id)}`);
  assert.equal(inspect.body.per_recipient.length, 4);

  // metrics reflect real demo execution
  const metrics = await api('/api/metrics');
  assert.equal(metrics.body.total_events, 1);
  assert.equal(metrics.body.notification_count, 4);

  // notifications
  const notes = await api('/api/notifications');
  assert.equal(notes.body.notifications.length, 4);

  // audit + executions
  const audit = await api('/api/audit');
  assert.ok(audit.body.audit.length > 0);
  const exec = await api('/api/executions');
  assert.ok(exec.body.executions.length > 0);

  // no sensitive material anywhere in API output
  const blob = JSON.stringify([proc.body, notes.body, audit.body, exec.body]);
  assert.ok(!blob.includes('service_role'));
  assert.ok(!blob.includes('Synthetic Patient'));

  // replay eligible event → idempotent
  const replay = await api(`/api/replay/event/${encodeURIComponent(event.event_id)}`, { method: 'POST', body: {} });
  assert.equal(replay.body.ok, true);
  const metricsAfter = await api('/api/metrics');
  assert.equal(metricsAfter.body.notification_count, 4); // no duplicates
});
