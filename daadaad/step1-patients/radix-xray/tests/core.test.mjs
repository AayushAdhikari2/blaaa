// node --test tests/core.test.mjs   (no network: the AI service and database are faked)
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, validateInput, SCHEMA, CONSENT_VERSION } from '../supabase/functions/xray-analyze/core.js';
const IMAGE = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(3000, 7)]).toString('base64');
const body = (over = {}) => ({ consent: true, consent_version: CONSENT_VERSION, file_sha256: 'a'.repeat(64), image: IMAGE,
  patient: { name: 'Sita Example', phone: '9800000000', age: '30', sex: 'female', body_part: 'chest', side: 'na', symptoms: 'cough' }, ...over });
const good = { is_xray: true, rejection_reason: '', detected_body_part: 'chest', matches_selected_body_part: true, view: 'PA',
  image_quality: { rating: 'Good', issues: [] }, findings: [{ region: 'Lungs', observation: 'SECRET', significance: 'normal', confidence: 'moderate' }],
  impression: 'SECRET', urgency: 'routine', urgency_reason: '', recommendations: [], limitations: [], patient_summary: 'SECRET' };
function fake({ result = good, quota = 'ok', status = 200, stop = 'end_turn', saveError = null, key = 'k' } = {}) {
  const log = { rpc: [], sent: null, headers: null };
  return { log, deps: { ipHash: 'h', env: (n) => ({ ANTHROPIC_API_KEY: key }[n]),
    rpc: async (name, args) => { log.rpc.push([name, structuredClone(args)]); return name === 'xray_reserve_scan' ? { data: quota } : saveError ? { error: { message: saveError } } : { data: { ref: 'XR-0000ABCD', code: '12345678' } }; },
    fetch: async (url, o) => { log.sent = JSON.parse(o.body); log.headers = o.headers;
      return new Response(JSON.stringify({ stop_reason: stop, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(result) }] }), { status }); } } };
}
test('success: saves the draft, returns only reference and code', async () => {
  const f = fake(), out = await analyze(body(), f.deps);
  assert.deepEqual(out.body, { ref: 'XR-0000ABCD', code: '12345678', status: 'pending_review' });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
  assert.equal(f.log.rpc[1][1].p.ai_result.image_quality.rating, 'good');
});
test('the image is never sent to the database', async () => {
  const f = fake(); await analyze(body(), f.deps);
  assert.ok(!JSON.stringify(f.log.rpc).includes(IMAGE.slice(0, 40)));
});
test('name and phone are never sent to the AI', async () => {
  const f = fake(); await analyze(body(), f.deps);
  const sent = JSON.stringify(f.log.sent);
  assert.ok(!sent.includes('Sita') && !sent.includes('9800000000'));
  assert.equal(f.log.sent.model, 'claude-opus-5-5');
  assert.equal(f.log.headers['anthropic-version'], '2026-10-21');
  for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) assert.ok(!(k in f.log.sent));
});
test('schema: every object is closed and requires all its fields', () => {
  const walk = (s) => { if (s.type === 'object') { assert.equal(s.additionalProperties, false); assert.deepEqual(s.required, Object.keys(s.properties)); Object.values(s.properties).forEach(walk); } if (s.items) walk(s.items); };
  walk(SCHEMA);
});
for (const [name, result] of [['not an X-ray', { ...good, is_xray: false }], ['unreadable', { ...good, image_quality: { rating: 'unusable', issues: [] } }]])
  test(`${name}: nothing saved`, async () => { const f = fake({ result }), out = await analyze(body(), f.deps); assert.equal(out.status, 422); assert.equal(f.log.rpc.length, 1); });
for (const [name, opt] of [['API error', { status: 500 }], ['refusal', { stop: 'refusal' }], ['cut off', { stop: 'max_tokens' }], ['bad urgency', { result: { ...good, urgency: 'maybe' } }], ['missing field', { result: { ...good, impression: undefined } }]])
  test(`${name}: fails closed, nothing saved`, async () => { const f = fake(opt); await assert.rejects(analyze(body(), f.deps)); assert.equal(f.log.rpc.length, 1); });
test('save failure is an error, not a success', async () => { await assert.rejects(analyze(body(), fake({ saveError: 'down' }).deps), /could not save/); });
test('over the limit: AI is not called', async () => {
  for (const quota of ['ip_limit', 'day_limit']) { const f = fake({ quota }); await assert.rejects(analyze(body(), f.deps), (e) => e.status === 429); assert.equal(f.log.sent, null); }
});
test('no API key: clear setup error', async () => { await assert.rejects(analyze(body(), fake({ key: '' }).deps), (e) => e.status === 503); });
test('bad input is refused', () => {
  const p = body().patient;
  for (const bad of [{ consent: false }, { consent_version: 'old' }, { image: 'abc' }, { image: Buffer.alloc(3000, 1).toString('base64') }, { image: IMAGE + 'A'.repeat(8_000_001) }, { file_sha256: 'x' },
    { patient: { ...p, age: '' } }, { patient: { ...p, age: 200 } }, { patient: { ...p, body_part: 'brain_mri' } }, { patient: { ...p, name: '' } }])
    assert.throws(() => validateInput(body(bad)), JSON.stringify(bad).slice(0, 60));
});
