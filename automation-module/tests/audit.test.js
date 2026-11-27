import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';
import { AUDIT_TYPES } from '../src/audit/audit-log.js';
import { assertNoSensitiveMaterial } from '../src/core/sanitize.js';
import { getMetrics } from '../src/monitoring/metrics.js';
import { checkHealth } from '../src/monitoring/health.js';

test('audit history records required events', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  const victim = ELIGIBLE_RECIPIENTS[0];
  ctx.sink.failFor(victim, { kind: 'transient', times: 1 });
  await ctx.engine.ingest(event);
  ctx.clock.advance(1000);
  await ctx.engine.processRetries();
  await ctx.engine.replayEvent(event.event_id);

  const types = new Set((await ctx.engine.audit.list({})).map((a) => a.type));
  for (const required of [
    AUDIT_TYPES.EVENT_RECEIVED, AUDIT_TYPES.EVENT_VALIDATION, AUDIT_TYPES.RECIPIENTS_RESOLVED,
    AUDIT_TYPES.NOTIFICATION_CREATED, AUDIT_TYPES.DELIVERY_ATTEMPT, AUDIT_TYPES.DELIVERY_RESULT,
    AUDIT_TYPES.RETRY_SCHEDULED, AUDIT_TYPES.RETRY_ATTEMPT, AUDIT_TYPES.MANUAL_REPLAY,
  ]) assert.ok(types.has(required), `missing audit type ${required}`);
});

test('append-only: entries ordered, no update/delete API', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  await ctx.engine.ingest(validEvent());
  const entries = await ctx.engine.audit.list({});
  assert.ok(entries.length > 0);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].seq > entries[i - 1].seq);
  assert.equal(typeof ctx.engine.audit.append, 'function');
  assert.equal(typeof ctx.engine.audit.update, 'undefined');
  assert.equal(typeof ctx.engine.audit.remove, 'undefined');
});

test('duplicate skipped audited', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  await ctx.engine.ingest(event);
  // duplicate notification create
  await ctx.engine.notifications.createNotification({ event, appointment_id: '100001', recipient_id: ELIGIBLE_RECIPIENTS[0], now: '2024-06-01T12:00:00.000Z', channel: 'in_app', notification_type: 'appointment.requested' });
  await ctx.engine.ingest(event); // duplicate event
  const types = (await ctx.engine.audit.list({})).map((a) => a.type);
  assert.ok(types.includes(AUDIT_TYPES.NOTIFICATION_DUPLICATE_SKIPPED));
  assert.ok(types.includes(AUDIT_TYPES.EVENT_DUPLICATE));
});

test('metrics dashboard fields', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  await ctx.engine.ingest(validEvent());
  const m = await getMetrics(ctx.store);
  for (const k of ['total_events', 'processed_events', 'failed_events', 'notification_count', 'pending_deliveries',
    'retry_count', 'dead_letter_count', 'success_rate', 'processing_duration_ms_total']) {
    assert.ok(k in m, `missing metric ${k}`);
  }
  assert.equal(m.total_events, 1);
  assert.equal(m.processed_events, 1);
  assert.equal(m.notification_count, 4);
});

test('health checks', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const h = await checkHealth(ctx.store, {});
  assert.equal(h.status, 'ok');
  assert.ok(h.checks.some((c) => c.name === 'store_writable' && c.status === 'ok'));
  assert.ok(h.mode.includes('DEMO MODE'));
  assert.ok(!JSON.stringify(h).toLowerCase().includes('service_role'));
});

test('no sensitive information in logs/audit/sink', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const secrets = ['Synthetic Sensitive Name', '+1-555-0199-1234', '123456', 'hunter2password',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signaturehere', 'sb-service-role-secret-key-123456'];
  // patient-ish + secret fields injected into a raw event
  const raw = validEvent({
    name: secrets[0], phone: secrets[1],
    payload: { appointment_id: '100001', name: secrets[0], phone: secrets[1], access_code: secrets[2] },
    access_code: secrets[2], password: secrets[3], token: secrets[4], secret: secrets[5],
  });
  await ctx.engine.ingest(raw);

  // inject a secret-bearing transient error
  ctx.sink.failFor(ELIGIBLE_RECIPIENTS[0], { kind: 'transient', times: 1, message: `boom password=${secrets[3]} token=${secrets[4]} phone=${secrets[1]}` });
  // can't easily attach message via sink API on second run; emit a fresh event with a failing sink:
  const ctx2 = await makeEngine(); t.after(ctx2.cleanup);
  ctx2.sink.failNext('transient', `failed token=${secrets[4]} secret=${secrets[5]} for ${secrets[1]} code ${secrets[2]}`);
  await ctx2.engine.ingest(validEvent({ event_id: '00000000-0000-4000-8000-0000000000aa' }));

  for (const ctxX of [ctx, ctx2]) {
    const auditSerialized = JSON.stringify(await ctxX.engine.audit.list({}));
    const notesSerialized = JSON.stringify(await ctxX.engine.notifications.list({}));
    const sinkSerialized = JSON.stringify(ctxX.sink.inbox) + JSON.stringify(ctxX.sink.calls);
    const storeSerialized = JSON.stringify(await ctxX.store.read());
    for (const secret of secrets) {
      assert.ok(!auditSerialized.includes(secret), `audit leaked ${secret}`);
      assert.ok(!notesSerialized.includes(secret), `notification leaked ${secret}`);
      assert.ok(!sinkSerialized.includes(secret), `sink leaked ${secret}`);
      assert.ok(!storeSerialized.includes(secret), `store leaked ${secret}`);
    }
    assert.deepEqual(assertNoSensitiveMaterial(auditSerialized, { forbidden: secrets }), []);
  }
});
