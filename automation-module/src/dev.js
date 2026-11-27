/**
 * `npm run dev` — self-contained local demo. No network, no Supabase, synthetic data only.
 * Runs: generate synthetic appointment.requested → dry-run → process → repeat-delivery → retry demo.
 */
import { MockStore } from './adapters/mock/mock-store.js';
import { MockRecipientProvider } from './adapters/mock/mock-recipient-provider.js';
import { MockNotificationSink } from './adapters/mock/mock-notification-sink.js';
import { EventSimulator } from './adapters/mock/event-simulator.js';
import { createEngine } from './core/event-ingestion.js';
import { getMetrics } from './monitoring/metrics.js';
import path from 'node:path';
import { LOCAL_STATE_DIR } from './paths.js';

const store = new MockStore({ filePath: path.join(LOCAL_STATE_DIR, 'dev-store.json') });
await store.destroy();
const recipients = new MockRecipientProvider();
const sink = new MockNotificationSink();
const engine = createEngine({ store, recipients, sink });
const simulator = new EventSimulator();

const { event } = simulator.generateAppointmentRequested({ appointmentId: '100001', occurredAt: new Date().toISOString() });

console.log('=== synthetic event (no patient data) ===');
console.log(JSON.stringify(event, null, 2));

console.log('\n=== dry-run ===');
const dry = await engine.ingest(event, { dryRun: true });
console.log(JSON.stringify({ ok: dry.ok, planned: dry.result?.plannedNotifications?.length ?? 0 }, null, 2));

console.log('\n=== process ===');
const first = await engine.ingest(event);
console.log(JSON.stringify({ status: first.status, per_recipient: first.per_recipient }, null, 2));

console.log('\n=== repeat delivery (same event_id) ===');
const again = await engine.ingest(event);
console.log(JSON.stringify({ duplicate: again.duplicate, notifications_created_again: 0, per_recipient: again.per_recipient }, null, 2));

console.log('\n=== metrics ===');
console.log(JSON.stringify(await getMetrics(store), null, 2));

console.log('\n=== inbox totals ===');
console.log('delivered notifications:', sink.inbox.length);
