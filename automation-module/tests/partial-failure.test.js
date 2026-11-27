import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';

test('partial recipient failure: others succeed; failed recipient isolated', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const victim = ELIGIBLE_RECIPIENTS[2];
  ctx.sink.failFor(victim, { kind: 'transient', times: 1 });
  const res = await ctx.engine.ingest(validEvent());

  assert.equal(res.ok, true); // workflow itself didn't throw
  assert.equal(res.status, 'partial');
  const ok = res.per_recipient.filter((p) => p.status === 'succeeded');
  assert.equal(ok.length, 3);
  assert.ok(ok.every((p) => p.recipient_id !== victim));
  // notification for failed recipient still created (idempotent); only delivery retried
  assert.equal((await ctx.engine.notifications.list({})).length, 4);
});

test('one recipient throwing does not block later recipients', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const first = ELIGIBLE_RECIPIENTS[0]; // sorted order → processed first
  ctx.sink.failFor(first, { kind: 'permanent', times: 1 });
  const res = await ctx.engine.ingest(validEvent());
  const succeededIds = res.per_recipient.filter((p) => p.status === 'succeeded').map((p) => p.recipient_id);
  assert.equal(succeededIds.length, 3);
  assert.ok(!succeededIds.includes(first));
});
