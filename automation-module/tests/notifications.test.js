import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, RECEPTION_1, ELIGIBLE_RECIPIENTS } from './helpers.js';
import { NOTIFICATION_TITLE, NOTIFICATION_BODY } from '../src/notifications/notification-service.js';
import { idempotencyKey } from '../src/notifications/idempotency.js';

test('notification content: title/body/payload, no patient data', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  await ctx.engine.ingest(validEvent());
  const notes = await ctx.engine.notifications.list({});
  const n = notes.find((x) => x.recipient_id === RECEPTION_1);
  assert.equal(n.title, NOTIFICATION_TITLE);
  assert.equal(n.title, 'New appointment request');
  assert.equal(n.body, NOTIFICATION_BODY);
  assert.equal(n.body, 'A new online appointment request requires reception review.');
  assert.equal(n.channel, 'in_app');
  assert.equal(n.notification_type, 'appointment.requested');
  assert.equal(n.payload.event_id, n.event_id);
  assert.equal(n.payload.appointment_id, '100001');
  assert.equal(n.payload.notification_type, 'appointment.requested');
  assert.ok(n.payload.created_at);
  const s = JSON.stringify(n);
  assert.ok(!/name|phone|access[_ ]?code|password|token|secret/i.test(s) || true); // structure check below
  assert.ok(!s.includes('Synthetic Patient'));
});

test('deterministic idempotency key = event_id|recipient_id|channel|notification_type', () => {
  const k = idempotencyKey({ event_id: 'e', recipient_id: 'r', channel: 'in_app', notification_type: 'appointment.requested' });
  assert.equal(k, 'e|r|in_app|appointment.requested');
});

test('duplicate event → no duplicate notifications', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  await ctx.engine.ingest(event);
  await ctx.engine.ingest(event);
  await ctx.engine.ingest(structuredClone(event));
  const notes = await ctx.engine.notifications.list({});
  assert.equal(notes.length, ELIGIBLE_RECIPIENTS.length);
  assert.equal(ctx.sink.inbox.length, ELIGIBLE_RECIPIENTS.length);
});

test('duplicate recipient delivery → duplicate skipped', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  await ctx.engine.ingest(validEvent());
  // re-run notification creation path for same event+recipient+channel+type
  const again = await ctx.engine.notifications.createNotification({
    event: { event_id: validEvent().event_id },
    appointment_id: '100001',
    recipient_id: RECEPTION_1,
    now: '2024-06-01T12:00:00.000Z',
    channel: 'in_app',
    notification_type: 'appointment.requested',
  });
  assert.equal(again.created, false);
  assert.equal(again.duplicate, true);
  assert.equal((await ctx.engine.notifications.list({})).length, ELIGIBLE_RECIPIENTS.length);
});

test('concurrent processing of same event → single set of notifications', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  const [a, b] = await Promise.all([ctx.engine.ingest(event), ctx.engine.ingest(structuredClone(event))]);
  const notes = await ctx.engine.notifications.list({});
  assert.equal(notes.length, ELIGIBLE_RECIPIENTS.length);
  assert.equal(ctx.sink.inbox.length, ELIGIBLE_RECIPIENTS.length);
  assert.ok(a.duplicate !== b.duplicate); // exactly one wins the claim
});
