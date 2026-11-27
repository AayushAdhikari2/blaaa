import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeErrorSummary, REDACTED } from '../src/core/sanitize.js';

test('scrubs sensitive keys recursively', () => {
  const out = sanitize({
    appointment_id: '100001', event_id: 'e', recipient_id: 'r',
    name: 'Synthetic Patient', full_name: 'X', phone: '+1-555-0100', email: 'a@b.c',
    access_code: '123456', code: '123456', password: 'x', token: 'y', secret: 'z',
    service_role_key: 'k', authorization: 'Bearer abc',
    nested: { patient_name: 'P', ok: 1 },
  });
  const s = JSON.stringify(out);
  assert.equal(out.appointment_id, '100001');
  assert.equal(out.event_id, 'e');
  assert.equal(out.recipient_id, 'r');
  assert.ok(!s.includes('Synthetic Patient'));
  assert.ok(!s.includes('555-0100'));
  assert.ok(!s.includes('123456'));
  assert.ok(!s.includes('a@b.c'));
  assert.ok(out.name === REDACTED && out.password === REDACTED && out.token === REDACTED);
});

test('scrubs token shapes + phone shapes in strings', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c';
  assert.ok(!sanitize(`token=${jwt}`).includes(jwt));
  assert.ok(!sanitize('call +1-555-123-4567 now').includes('555-123-4567'));
  assert.ok(!sanitize('password=hunter2').includes('hunter2'));
});

test('sanitized error summary: bounded, single-line, no secrets', () => {
  const s = sanitizeErrorSummary(new Error('x'.repeat(500) + '\nsecond'));
  assert.ok(s.length <= 200);
  assert.ok(!s.includes('\n'));
  assert.ok(!sanitizeErrorSummary(new Error('fail secret=topsecret token=abc123')).includes('topsecret'));
});
