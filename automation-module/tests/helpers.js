import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { LOCAL_STATE_DIR } from '../src/paths.js';
import { MockStore } from '../src/adapters/mock/mock-store.js';
import { MockRecipientProvider } from '../src/adapters/mock/mock-recipient-provider.js';
import { MockNotificationSink } from '../src/adapters/mock/mock-notification-sink.js';
import { ManualClock } from '../src/core/clock.js';
import { createEngine } from '../src/core/event-ingestion.js';

export const RECEPTION_1 = '11111111-1111-4111-8111-111111111111';
export const RECEPTION_2 = '22222222-2222-4222-8222-222222222222';
export const ADMIN_1 = '33333333-3333-4333-8333-333333333333';
export const ADMIN_2 = '44444444-4444-4444-8444-444444444444';
export const DOCTOR = '55555555-5555-4555-8555-555555555555';
export const LAB = '66666666-6666-4666-8666-666666666666';
export const INACTIVE_RECEPTION = '77777777-7777-4777-8777-777777777777';

export const ELIGIBLE_RECIPIENTS = [RECEPTION_1, RECEPTION_2, ADMIN_1, ADMIN_2];

export async function makeEngine(overrides = {}) {
  const tmpRoot = await mkdtemp(path.join(await ensureTestsDir(), 't-'));
  const clock = overrides.clock ?? new ManualClock('2024-06-01T12:00:00.000Z');
  const store = new MockStore({ filePath: path.join(tmpRoot, 'store.json'), clock });
  const recipients = overrides.recipients ?? new MockRecipientProvider();
  const sink = overrides.sink ?? new MockNotificationSink();
  const engine = createEngine({ store, recipients, sink, clock, ...overrides.engine });
  return { engine, store, recipients, sink, clock, tmpRoot, async cleanup() { await rm(tmpRoot, { recursive: true, force: true }); } };
}

async function ensureTestsDir() {
  const { mkdir } = await import('node:fs/promises');
  const dir = path.join(LOCAL_STATE_DIR, 'tests');
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Build a valid appointment.requested event. Synthetic. */
export function validEvent(overrides = {}) {
  return {
    event_id: overrides.event_id ?? '00000000-0000-4000-8000-000000000001',
    event_type: 'appointment.requested',
    schema_version: 1,
    source: 'public.appointments',
    source_id: '100001',
    occurred_at: '2024-06-01T11:59:00.000Z',
    payload: { appointment_id: '100001' },
    ...overrides,
  };
}
