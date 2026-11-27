import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, scheduleRetry, DEFAULT_RETRY_POLICY } from '../src/reliability/retry-policy.js';
import { classifyError, errorSummary } from '../src/reliability/error-classification.js';
import { TransientError, PermanentError } from '../src/core/errors.js';
import { makeEngine, validEvent, ELIGIBLE_RECIPIENTS } from './helpers.js';

test('bounded exponential backoff', () => {
  assert.equal(backoffMs(1, DEFAULT_RETRY_POLICY), 1000);
  assert.equal(backoffMs(2, DEFAULT_RETRY_POLICY), 2000);
  assert.equal(backoffMs(3, DEFAULT_RETRY_POLICY), 4000);
  assert.equal(backoffMs(4, DEFAULT_RETRY_POLICY), 8000);
  assert.equal(backoffMs(100, DEFAULT_RETRY_POLICY), 60000); // capped
  assert.equal(backoffMs(100, { baseMs: 10, maxMs: 50, maxAttempts: 5 }), 50);
});

test('scheduleRetry stops at max attempts; retry timestamps from injected clock', () => {
  const from = '2024-06-01T12:00:00.000Z';
  const s1 = scheduleRetry(1, DEFAULT_RETRY_POLICY, from);
  assert.equal(s1.shouldRetry, true);
  assert.equal(s1.nextRetryAt, '2024-06-01T12:00:01.000Z');
  assert.equal(scheduleRetry(DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY, from).shouldRetry, false);
  assert.equal(scheduleRetry(DEFAULT_RETRY_POLICY.maxAttempts, DEFAULT_RETRY_POLICY, from).nextRetryAt, null);
});

test('transient vs permanent classification', () => {
  assert.equal(classifyError(new TransientError('x')), 'transient');
  assert.equal(classifyError(new PermanentError('x')), 'permanent');
  assert.equal(classifyError(new Error('ETIMEDOUT: timed out')), 'transient');
  assert.equal(classifyError(Object.assign(new Error('boom'), { status: 503 })), 'transient');
  assert.equal(classifyError(Object.assign(new Error('rate'), { status: 429 })), 'transient');
  assert.equal(classifyError(Object.assign(new Error('no'), { status: 400 })), 'permanent');
  assert.equal(classifyError(new Error('permanent rejection')), 'permanent');
});

test('sanitized error summaries (no secrets/PII, bounded, single-line)', () => {
  const e = new Error('failure token=abc123secret password=hunter2 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c\nnext');
  const s = errorSummary(e);
  assert.ok(!s.includes('abc123secret'));
  assert.ok(!s.includes('hunter2'));
  assert.ok(!s.includes('eyJhbGci'));
  assert.ok(!s.includes('\n'));
  assert.ok(s.length <= 200);
});

test('retry: transient failure schedules bounded retry; due processing succeeds; no duplicate', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const victim = ELIGIBLE_RECIPIENTS[3];
  ctx.sink.failFor(victim, { kind: 'transient', times: 2 }); // fail twice, succeed third
  await ctx.engine.ingest(validEvent());

  let state = await ctx.store.read();
  let d = Object.values(state.deliveries).find((x) => x.recipient_id === victim);
  assert.equal(d.status, 'retry_scheduled');
  assert.equal(d.attempts, 1);
  assert.ok(d.next_retry_at);
  const nextRetry = new Date(d.next_retry_at).getTime();
  assert.equal(nextRetry, ctx.clock.now().getTime() + 1000); // attempt1 backoff 1s

  // not yet due
  await ctx.engine.processRetries();
  state = await ctx.store.read();
  assert.equal(state.deliveries[d.delivery_id].attempts, 1);

  // due → second attempt (fails again, transient) → retry scheduled with 2s
  ctx.clock.advance(1000);
  await ctx.engine.processRetries();
  state = await ctx.store.read();
  d = state.deliveries[d.delivery_id];
  assert.equal(d.attempts, 2);
  assert.equal(d.status, 'retry_scheduled');
  assert.equal(new Date(d.next_retry_at).getTime(), ctx.clock.now().getTime() + 2000);

  // due → third attempt succeeds
  ctx.clock.advance(2000);
  await ctx.engine.processRetries();
  state = await ctx.store.read();
  d = state.deliveries[d.delivery_id];
  assert.equal(d.status, 'succeeded');
  assert.equal(d.attempts, 3);
  assert.equal((await ctx.engine.notifications.list({})).length, 4); // no dup
  assert.ok(d.history.length >= 3);
});

test('maximum retries → failed → dead-letter transition', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const victim = ELIGIBLE_RECIPIENTS[0];
  ctx.sink.failAll('transient', 'always temporary');
  await ctx.engine.ingest(validEvent());

  // drive retries past max for all (use audit on victim)
  for (let i = 0; i < 10; i++) {
    ctx.clock.advance(120_000);
    await ctx.engine.processRetries();
  }
  const state = await ctx.store.read();
  const d = Object.values(state.deliveries).find((x) => x.recipient_id === victim);
  assert.equal(d.status, 'dead_letter');
  assert.ok(d.attempts >= d.max_attempts);
  // automatic retry stops at max attempts
  const attemptsAtDead = d.attempts;
  ctx.clock.advance(120_000);
  await ctx.engine.processRetries();
  const state2 = await ctx.store.read();
  assert.equal(state2.deliveries[d.delivery_id].attempts, attemptsAtDead);
  // dead-letter transition audited
  const audit = await ctx.engine.audit.list({ type: 'dead_letter' });
  assert.ok(audit.some((a) => a.delivery_id === d.delivery_id));
  // event reflects non-success
  const ev = state2.events[validEvent().event_id];
  assert.ok(['failed', 'partial'].includes(ev.status));
});

test('permanent error → no automatic retry → failed → dead-letter', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  ctx.sink.failFor(ELIGIBLE_RECIPIENTS[0], { kind: 'permanent', times: 99 });
  await ctx.engine.ingest(validEvent());
  const state = await ctx.store.read();
  const d = Object.values(state.deliveries).find((x) => x.recipient_id === ELIGIBLE_RECIPIENTS[0]);
  assert.equal(d.status, 'dead_letter');
  assert.equal(d.attempts, 1); // permanent: no retries
  ctx.clock.advance(120_000);
  await ctx.engine.processRetries();
  const state2 = await ctx.store.read();
  assert.equal(state2.deliveries[d.delivery_id].attempts, 1); // never auto-retried
});

test('attempt history append-only; retry timestamps recorded', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  ctx.sink.failFor(ELIGIBLE_RECIPIENTS[0], { kind: 'transient', times: 1 });
  await ctx.engine.ingest(validEvent());
  ctx.clock.advance(1000);
  await ctx.engine.processRetries();
  const state = await ctx.store.read();
  const d = Object.values(state.deliveries).find((x) => x.recipient_id === ELIGIBLE_RECIPIENTS[0]);
  assert.equal(d.history[0].outcome, 'failed');
  assert.equal(d.history[1].outcome, 'succeeded');
  assert.equal(d.history[0].failure_class, 'transient');
});

test('injectable clock controls all timestamps deterministically', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  ctx.sink.failFor(ELIGIBLE_RECIPIENTS[0], { kind: 'transient', times: 1 });
  const res = await ctx.engine.ingest(validEvent({ occurred_at: '2024-06-01T11:59:00.000Z' }));
  assert.ok(res);
  const notes = await ctx.engine.notifications.list({});
  assert.ok(notes.every((n) => n.created_at === '2024-06-01T12:00:00.000Z'));
});
