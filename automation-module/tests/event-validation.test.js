import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent } from '../src/core/event-validator.js';
import { normalizeEvent } from '../src/core/event-normalizer.js';
import { deterministicEventId, isUuid } from '../src/core/event-id.js';
import { makeEngine, validEvent } from './helpers.js';

test('valid appointment.requested event passes validation', () => {
  const r = validateEvent(validEvent());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.knownEventType, true);
});

test('event is processed end-to-end when valid', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent());
  assert.equal(res.ok, true);
  assert.equal(res.status, 'succeeded');
  assert.equal(res.per_recipient.length, 4);
});

test('invalid event (bad schema_version, bad uuid, bad occurred_at, extra recipients) rejected', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  for (const bad of [
    validEvent({ schema_version: 2 }),
    validEvent({ event_id: 'not-a-uuid' }),
    validEvent({ occurred_at: 'not-a-date' }),
    validEvent({ source: 'other.table' }),
    validEvent({ recipients: ['x'] }),
    validEvent({ payload: { appointment_id: '100001', recipients: ['x'] } }),
    null,
    {},
  ]) {
    const v = validateEvent(bad);
    assert.equal(v.valid, false, JSON.stringify(bad));
    const res = await ctx.engine.ingest(bad);
    assert.equal(res.ok, false);
    assert.equal(res.status, 'rejected');
  }
});

test('unknown event type rejected, not routed', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent({ event_type: 'appointment.cancelled' }));
  assert.equal(res.ok, false);
  assert.equal(res.status, 'rejected');
  assert.equal(res.reason, 'unknown_event_type');
  assert.equal(res.knownEventType, false);
  const notes = await ctx.engine.notifications.list({});
  assert.equal(notes.length, 0);
});

test('missing appointment identifier rejected', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const cases = [
    validEvent({ payload: {} }),
    validEvent({ payload: { appointment_id: '' } }),
    validEvent({ payload: { appointment_id: '   ' } }),
    validEvent({ payload: { appointment_id: null } }),
    validEvent({ source_id: '', payload: { appointment_id: '100001' } }),
    { ...validEvent(), payload: {}, source_id: '100001' },
  ];
  // remove appointment_id key entirely
  const noKey = validEvent(); delete noKey.payload.appointment_id; cases.push(noKey);
  for (const c of cases) {
    const v = validateEvent(c);
    assert.equal(v.valid, false, JSON.stringify(c));
    const res = await ctx.engine.ingest(c);
    assert.equal(res.ok, false);
  }
  assert.equal((await ctx.engine.notifications.list({})).length, 0);
});

test('appointment_id accepts string or safe integer, normalized to string', () => {
  assert.equal(validateEvent(validEvent({ payload: { appointment_id: 100001 }, source_id: 100001 })).valid, true);
  const n = normalizeEvent(validEvent({ payload: { appointment_id: 100001 }, source_id: 100001 }));
  assert.equal(n.payload.appointment_id, '100001');
  assert.equal(n.source_id, '100001');
});

test('normalization strips unknown + patient fields (name/phone/reason/access code)', () => {
  const raw = validEvent({
    name: 'Synthetic Patient', phone: '+1-555-010-0000', reason: 'checkup',
    payload: { appointment_id: '100001', name: 'X', phone: 'Y', preferred_date: '2024-06-05' },
    extra: 'junk',
  });
  const n = normalizeEvent(raw);
  const s = JSON.stringify(n);
  assert.ok(!s.includes('Synthetic Patient'));
  assert.ok(!s.includes('555'));
  assert.ok(!s.includes('checkup'));
  assert.ok(!s.includes('preferred_date'));
  assert.ok(!s.includes('extra'));
  assert.deepEqual(n.payload, { appointment_id: '100001' });
});

test('deterministic event ids: same inputs → same UUID; different → different', () => {
  const a = deterministicEventId({ eventType: 'appointment.requested', source: 'public.appointments', sourceId: '100001' });
  const b = deterministicEventId({ eventType: 'appointment.requested', source: 'public.appointments', sourceId: '100001' });
  const c = deterministicEventId({ eventType: 'appointment.requested', source: 'public.appointments', sourceId: '100002' });
  assert.ok(isUuid(a));
  assert.equal(a, b);
  assert.notEqual(a, c);
});
