import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';

test('dry-run: validate + resolve + plan; nothing persisted', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const before = await ctx.store.read();
  const res = await ctx.engine.ingest(validEvent(), { dryRun: true });

  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.result.plannedNotifications.length, ELIGIBLE_RECIPIENTS.length);
  assert.equal(res.result.created, 0);
  assert.ok(res.audit_trail.some((a) => a.type === 'event.received'));
  assert.ok(res.audit_trail.some((a) => a.type === 'event.validation'));
  assert.ok(res.audit_trail.some((a) => a.type === 'recipients.resolved'));

  const after = await ctx.store.read();
  // nothing mutated
  assert.equal(Object.keys(after.events).length, Object.keys(before.events).length);
  assert.equal(Object.keys(after.notifications).length, 0);
  assert.equal(Object.keys(after.deliveries).length, 0);
  assert.equal(after.audit.length, before.audit.length); // no persisted audit in dry-run
  assert.equal(ctx.sink.inbox.length, 0);
});

test('dry-run then real process: dry-run did not consume idempotency', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  await ctx.engine.ingest(event, { dryRun: true });
  const res = await ctx.engine.ingest(event); // still processes for real
  assert.equal(res.duplicate, false);
  assert.equal(res.per_recipient.length, ELIGIBLE_RECIPIENTS.length);
});

test('dry-run on invalid event returns errors, mutates nothing', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent({ payload: {} }), { dryRun: true });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);
  assert.equal((await ctx.store.read()).audit.length, 0);
});
