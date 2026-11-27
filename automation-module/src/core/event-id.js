import { createHash, randomUUID } from 'node:crypto';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Random UUID (for ad-hoc ids; NOT for deterministic event ids). */
export function randomId() {
  return randomUUID();
}

// Fixed namespace for Carepulse automation events (RFC 4122 UUID namespace, random constant).
const AUTOMATION_NAMESPACE = 'b6f0d3a4-1c2e-4f5a-9b8c-7d6e5f4a3b2c';

/**
 * Deterministic UUID v5 (SHA-1 name-based). Same inputs → same UUID, forever.
 * Used so a synthetic event for the same appointment always carries the same event_id,
 * making repeat delivery / replay trivially idempotent.
 */
export function deterministicUuid(namespace, name) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(String(name), 'utf8')).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Deterministic event id for a hospital event.
 * @param {{ eventType: string, source: string, sourceId: string }} parts
 */
export function deterministicEventId({ eventType, source, sourceId }) {
  return deterministicUuid(AUTOMATION_NAMESPACE, `${eventType}|${source}|${String(sourceId)}`);
}
