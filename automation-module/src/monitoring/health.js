/**
 * System health checks for the dashboard System Health section + monitoring API.
 * No secrets, no connection strings, no patient data.
 */
import { DELIVERY_STATES } from '../reliability/retry-queue.js';

export const ENGINE_VERSION = '1.0.0';
export const PROCESS_01 = 'appointment.requested';

export async function checkHealth(store, { startedAtMs } = {}) {
  const checks = [];
  let storeReadable = false;
  let storeWritable = false;
  let counts = { events: 0, notifications: 0, deliveries: 0, audit: 0 };

  try {
    const state = await store.read();
    storeReadable = true;
    counts = {
      events: Object.keys(state.events ?? {}).length,
      notifications: Object.keys(state.notifications ?? {}).length,
      deliveries: Object.keys(state.deliveries ?? {}).length,
      audit: (state.audit ?? []).length,
    };
    // dead-letter depth
    const deliveries = Object.values(state.deliveries ?? {});
    checks.push({
      name: 'queue_depth',
      status: 'ok',
      pending: deliveries.filter((d) => d.status === DELIVERY_STATES.PENDING).length,
      processing: deliveries.filter((d) => d.status === DELIVERY_STATES.PROCESSING).length,
      retry_scheduled: deliveries.filter((d) => d.status === DELIVERY_STATES.RETRY_SCHEDULED).length,
      dead_letter: deliveries.filter((d) => d.status === DELIVERY_STATES.DEAD_LETTER).length,
    });
  } catch {
    checks.push({ name: 'store_readable', status: 'error', message: 'store read failed' });
  }

  try {
    await store.probeWritable();
    storeWritable = true;
  } catch {
    checks.push({ name: 'store_writable', status: 'error', message: 'store write probe failed' });
  }

  checks.push({ name: 'store_readable', status: storeReadable ? 'ok' : 'error' });
  checks.push({ name: 'store_writable', status: storeWritable ? 'ok' : 'error' });

  const ok = storeReadable && storeWritable;
  return {
    status: ok ? 'ok' : 'degraded',
    mode: 'DEMO MODE — NOT CONNECTED TO SUPABASE',
    engine: 'carepulse-automation-engine',
    version: ENGINE_VERSION,
    process: PROCESS_01,
    uptime_ms: startedAtMs ? Math.max(0, Date.now() - startedAtMs) : null,
    checks,
    counts,
    generated_at: new Date().toISOString(),
  };
}
