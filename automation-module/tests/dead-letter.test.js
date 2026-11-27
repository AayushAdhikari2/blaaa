import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';
import { DELIVERY_STATES } from '../src/reliability/retry-queue.js';

test('full retry lifecycle states exist', () => {
  assert.deepEqual(Object.values(DELIVERY_STATES).sort(),
    ['dead_letter', 'failed', 'pending', 'processing', 'retry_scheduled', 'succeeded']);
});

test('dead-letter transition + manual replay end-to-end', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const victim = ELIGIBLE_RECIPIENTS[0];
  ctx.sink.failFor(victim, { kind: 'permanent', times: 1 });
  await ctx.engine.ingest(validEvent());

  let state = await ctx.store.read();
  const d = Object.values(state.deliveries).find((x) => x.recipient_id === victim);
  assert.equal(d.status, DELIVERY_STATES.DEAD_LETTER);
  assert.ok(d.last_error);
  assert.ok(!JSON.stringify(d).includes('password'));

  // DLQ audit
  const audit = await ctx.engine.audit.list({});
  assert.ok(audit.some((a) => a.type === 'dead_letter'));
  assert.ok(audit.some((a) => a.type === 'delivery.failed'));

  // manual replay → recovered
  ctx.sink.clearFailures();
  const replayed = await ctx.engine.replayDelivery(d.delivery_id);
  assert.equal(replayed.status, DELIVERY_STATES.SUCCEEDED);
  const replayAudit = await ctx.engine.audit.list({ type: 'manual.replay' });
  assert.ok(replayAudit.length >= 1);

  state = await ctx.store.read();
  assert.equal(state.deliveries[d.delivery_id].status, DELIVERY_STATES.SUCCEEDED);
});
