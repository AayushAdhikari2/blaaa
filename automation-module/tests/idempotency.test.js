import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';
import { ManualClock } from '../src/core/clock.js';

test('duplicate event ingestion is safe (repeat delivery)', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  const first = await ctx.engine.ingest(event);
  const sinkAfterFirst = ctx.sink.inbox.length;
  const second = await ctx.engine.ingest(event);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(ctx.sink.inbox.length, sinkAfterFirst); // no repeated successful deliveries
});

test('partial failure then safe retry does not repeat successful recipients', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  // fail exactly one recipient transiently once
  const victim = ELIGIBLE_RECIPIENTS[0];
  ctx.sink.failFor(victim, { kind: 'transient', times: 1 });
  const res = await ctx.engine.ingest(validEvent());
  assert.equal(res.status, 'partial');
  const succeeded = res.per_recipient.filter((p) => p.status === 'succeeded').map((p) => p.recipient_id);
  const retryScheduled = res.per_recipient.filter((p) => p.status === 'retry_scheduled').map((p) => p.recipient_id);
  assert.equal(succeeded.length, 3);
  assert.deepEqual(retryScheduled, [victim]);
  const inboxBefore = ctx.sink.inbox.length;

  // advance clock past backoff; process retries
  ctx.clock.advance(60_000);
  await ctx.engine.processRetries();
  assert.equal(ctx.sink.inbox.length, inboxBefore + 1); // only the failed one delivered
  const notes = await ctx.engine.notifications.list({});
  assert.equal(notes.length, ELIGIBLE_RECIPIENTS.length); // no duplicates
});

test('safe replay: repeated replay is idempotent; successful deliveries not repeated', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  await ctx.engine.ingest(event);
  const inboxAfterFirst = ctx.sink.inbox.length;
  const notesAfterFirst = (await ctx.engine.notifications.list({})).length;

  await ctx.engine.replayEvent(event.event_id);
  await ctx.engine.replayEvent(event.event_id);
  await ctx.engine.ingest(event); // duplicate ingest after replay

  assert.equal(ctx.sink.inbox.length, inboxAfterFirst); // nothing re-sent
  assert.equal((await ctx.engine.notifications.list({})).length, notesAfterFirst); // no duplicates
});

test('manual replay recovers dead-lettered delivery; history preserved; no duplicate', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const event = validEvent();
  // permanent failure for one recipient
  const victim = ELIGIBLE_RECIPIENTS[1];
  ctx.sink.failFor(victim, { kind: 'permanent', times: 1 });
  await ctx.engine.ingest(event);

  const state = await ctx.store.read();
  const dead = Object.values(state.deliveries).find((d) => d.recipient_id === victim && d.status === 'dead_letter');
  assert.ok(dead);
  const historyBefore = dead.history.length;
  const notesBefore = (await ctx.engine.notifications.list({})).length;

  // healthy downstream now; manual replay
  ctx.sink.clearFailures();
  const replayed = await ctx.engine.replayDelivery(dead.delivery_id);
  assert.equal(replayed.status, 'succeeded');
  const after = await ctx.store.read();
  const d = after.deliveries[dead.delivery_id];
  assert.equal(d.status, 'succeeded');
  assert.ok(d.history.length > historyBefore); // appended, not rewritten
  assert.ok(d.history.some((h) => String(h.outcome).startsWith('replay')));
  assert.equal((await ctx.engine.notifications.list({})).length, notesBefore); // no duplicate notification

  // replaying a succeeded delivery is a no-op
  const noop = await ctx.engine.replayDelivery(dead.delivery_id);
  assert.equal(noop.attempted, false);
});
