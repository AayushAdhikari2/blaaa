import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecipients, recheckEligibility, ELIGIBLE_ROLES_APPOINTMENT_REQUESTED } from '../src/notifications/recipient-resolver.js';
import { MockRecipientProvider } from '../src/adapters/mock/mock-recipient-provider.js';
import { makeEngine, validEvent, RECEPTION_1, RECEPTION_2, ADMIN_1, ADMIN_2, DOCTOR, LAB, INACTIVE_RECEPTION, ELIGIBLE_RECIPIENTS } from './helpers.js';

test('roles allowed = reception + admin only', () => {
  assert.deepEqual([...ELIGIBLE_ROLES_APPOINTMENT_REQUESTED], ['reception', 'admin']);
});

test('correct reception/admin recipient resolution', async () => {
  const provider = new MockRecipientProvider();
  const recipients = await resolveRecipients(provider, {});
  assert.deepEqual(recipients.map((r) => r.id).sort(), [...ELIGIBLE_RECIPIENTS].sort());
  assert.ok(recipients.every((r) => r.role === 'reception' || r.role === 'admin'));
});

test('doctor excluded', async () => {
  const provider = new MockRecipientProvider();
  const recipients = await resolveRecipients(provider, {});
  assert.ok(!recipients.some((r) => r.id === DOCTOR));
  assert.ok(!recipients.some((r) => r.role === 'doctor'));
});

test('lab excluded', async () => {
  const provider = new MockRecipientProvider();
  const recipients = await resolveRecipients(provider, {});
  assert.ok(!recipients.some((r) => r.id === LAB));
  assert.ok(!recipients.some((r) => r.role === 'lab'));
});

test('inactive reception excluded', async () => {
  const provider = new MockRecipientProvider();
  const recipients = await resolveRecipients(provider, {});
  assert.ok(!recipients.some((r) => r.id === INACTIVE_RECEPTION));
});

test('cannot widen roles via options (no doctor/lab injection)', async () => {
  const provider = new MockRecipientProvider();
  const recipients = await resolveRecipients(provider, { roles: ['reception', 'admin', 'doctor', 'lab'] });
  assert.ok(!recipients.some((r) => r.role === 'doctor' || r.role === 'lab'));
});

test('event-injected recipients are rejected', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent({ payload: { appointment_id: '100001', recipients: [DOCTOR] }, recipients: [DOCTOR] }));
  assert.equal(res.ok, false);
  assert.equal((await ctx.engine.notifications.list({})).length, 0);
});

test('one notification per eligible staff profile; none for doctor/lab', async (t) => {
  const ctx = await makeEngine(); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent());
  const recipients = res.per_recipient.map((p) => p.recipient_id).sort();
  assert.deepEqual(recipients, [...ELIGIBLE_RECIPIENTS].sort());
  assert.equal(res.per_recipient.length, 4);
  const notes = await ctx.engine.notifications.list({});
  assert.equal(notes.length, 4);
  assert.ok(!notes.some((n) => n.recipient_id === DOCTOR || n.recipient_id === LAB));
  // sink inbox likewise
  assert.equal(ctx.sink.inbox.length, 4);
  assert.ok(!ctx.sink.inbox.some((n) => n.recipient_id === DOCTOR || n.recipient_id === LAB));
});

test('eligibility re-checked at processing time', async (t) => {
  const provider = new MockRecipientProvider();
  const ctx = await makeEngine({ recipients: provider }); t.after(ctx.cleanup);
  // demote reception between resolution and delivery would require hooking; simulate re-check fn directly:
  assert.equal(await recheckEligibility(provider, RECEPTION_1, ['reception', 'admin']), true);
  provider.setRole(RECEPTION_1, 'doctor');
  assert.equal(await recheckEligibility(provider, RECEPTION_1, ['reception', 'admin']), false);
  provider.setActive(ADMIN_1, false);
  assert.equal(await recheckEligibility(provider, ADMIN_1, ['reception', 'admin']), false);
  provider.removeStaff(ADMIN_2);
  assert.equal(await recheckEligibility(provider, ADMIN_2, ['reception', 'admin']), false);
});

test('recheck at processing time prevents notification for staff who lost eligibility', async (t) => {
  const provider = new MockRecipientProvider();
  const ctx = await makeEngine({ recipients: provider, sink: undefined }); t.after(ctx.cleanup);
  // sabotage sink delivery to flip role mid-flight isn't trivial; emulate by removing after resolve via wrapping provider:
  const realList = provider.listStaff.bind(provider);
  provider.listStaff = async () => { const s = await realList(); provider.setRole(RECEPTION_1, 'lab'); return s; };
  const ctx2 = await makeEngine({ recipients: provider }); t.after(ctx2.cleanup);
  const res = await ctx2.engine.ingest(validEvent());
  // RECEPTION_1 was eligible at resolution but no longer at recheck → no notification for them
  assert.ok(!res.per_recipient.some((p) => p.recipient_id === RECEPTION_1));
  assert.equal(res.per_recipient.length, 3);
});

test('zero eligible recipients → success with no notifications', async (t) => {
  const provider = new MockRecipientProvider([
    { id: DOCTOR, role: 'doctor', active: true },
    { id: LAB, role: 'lab', active: true },
  ]);
  const ctx = await makeEngine({ recipients: provider }); t.after(ctx.cleanup);
  const res = await ctx.engine.ingest(validEvent());
  assert.equal(res.ok, true);
  assert.equal(res.per_recipient.length, 0);
  assert.equal((await ctx.engine.notifications.list({})).length, 0);
});
