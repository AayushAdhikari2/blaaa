import { systemClock, isoNow } from './clock.js';
import { validateEvent, EVENT_TYPE_APPOINTMENT_REQUESTED } from './event-validator.js';
import { normalizeEvent } from './event-normalizer.js';
import { EventRouter } from './event-router.js';
import { appointmentRequestedWorkflow } from '../workflows/appointment-requested/workflow.js';
import { AuditLog, AUDIT_TYPES } from '../audit/audit-log.js';
import { NotificationService } from '../notifications/notification-service.js';
import { DeliveryQueue } from '../reliability/retry-queue.js';
import { sanitizeErrorSummary, sanitize } from './sanitize.js';
import { ELIGIBLE_ROLES_APPOINTMENT_REQUESTED } from '../notifications/recipient-resolver.js';

/**
 * Event ingestion + orchestration. `ingest()` is the single entry point.
 *
 * Guarantees (local V1):
 *  - every incoming event validated
 *  - unknown event types rejected, audited, never routed
 *  - event-level idempotency: duplicate event_id → duplicate skipped; no duplicate notifications
 *  - concurrent ingestion of the same event_id is safe (atomic claim inside the store mutex)
 *  - dry-run performs validation + recipient resolution + plan, persists NOTHING
 *    (no event-store write, no notification, no delivery, no persisted audit; in-memory trail returned)
 *  - safe replay via replayEvent()
 *
 * HONESTY NOTE: local V1 persistence is a JSON file; we do NOT claim exactly-once processing.
 * Production relies on transactional outbox + DB uniqueness + SKIP LOCKED claiming
 * (see db/proposals/). At-least-once transport + idempotent processing.
 */

export const EVENT_STATUS = Object.freeze({
  PROCESSING: 'processing',
  SUCCEEDED: 'succeeded',
  PARTIAL: 'partial',
  FAILED: 'failed',
});

/** Audit sink that collects in memory and persists nothing (dry-run). */
function bufferingAudit(collected) {
  return {
    append: async (type, data = {}) => {
      collected.push({ type, ...sanitize(data) });
      return null;
    },
    list: async () => [...collected],
  };
}

export function createEngine({
  store,
  recipients,
  sink,
  clock = systemClock(),
  policy,
  retryPolicy,
  router,
} = {}) {
  if (!store) throw new Error('store is required');
  if (!recipients) throw new Error('recipients provider is required');
  if (!sink) throw new Error('notification sink is required');

  const audit = new AuditLog({ store, clock });
  const notifications = new NotificationService({ store, audit, clock });
  const queue = new DeliveryQueue({ store, audit, clock, policy: policy ?? retryPolicy });
  const eventRouter = router ?? new EventRouter().register(EVENT_TYPE_APPOINTMENT_REQUESTED, appointmentRequestedWorkflow);

  const ctx = { recipients, notifications, queue, audit, sink, clock };

  async function refreshEventStatus(eventId) {
    return store.update((state) => {
      const ev = state.events[eventId];
      if (!ev) return null;
      const deliveries = Object.values(state.deliveries).filter((d) => d.event_id === eventId);
      const failedCount = deliveries.filter((d) => ['failed', 'dead_letter'].includes(d.status)).length;
      const pendingCount = deliveries.filter((d) => ['pending', 'processing', 'retry_scheduled'].includes(d.status)).length;
      const succeededCount = deliveries.filter((d) => d.status === 'succeeded').length;
      let status = EVENT_STATUS.SUCCEEDED;
      if (failedCount > 0 || pendingCount > 0) {
        status = failedCount > 0 && succeededCount === 0 && pendingCount === 0 ? EVENT_STATUS.FAILED : EVENT_STATUS.PARTIAL;
      }
      ev.status = status;
      ev.updated_at = isoNow(clock);
      return status;
    });
  }

  /**
   * Ingest one raw event.
   * @param {unknown} raw
   * @param {{ dryRun?: boolean }} [options]
   */
  async function ingest(raw, options = {}) {
    const startedAtMs = clock.now().getTime();
    const dryRun = options.dryRun === true;

    const rawType = raw && typeof raw === 'object' ? sanitizeEventType(raw.event_type) : null;

    // ---- validation first ----
    const validation = validateEvent(raw);

    // dry-run: nothing persisted; in-memory audit trail
    const collected = [];
    const auditSink = dryRun ? bufferingAudit(collected) : audit;
    const auditRec = async (type, data) => auditSink.append(type, data);

    await auditRec(AUDIT_TYPES.EVENT_RECEIVED, {
      event_type: rawType ?? 'unknown',
      dry_run: dryRun,
      received_at: isoNow(clock),
    });

    if (!validation.valid) {
      // distinguish unknown event type vs structurally invalid for observability
      const unknownOnly =
        validation.errors.length === 1 && validation.errors[0].field === 'event_type' && !validation.knownEventType;
      await auditRec(AUDIT_TYPES.EVENT_VALIDATION, {
        outcome: unknownOnly ? 'unknown_event_type' : 'invalid',
        known_event_type: validation.knownEventType,
        error_count: validation.errors.length,
        errors: validation.errors,
      });
      await auditRec(AUDIT_TYPES.EVENT_REJECTED, {
        event_type: rawType ?? 'unknown',
        reason: unknownOnly ? 'unknown_event_type' : 'invalid_event',
      });
      return {
        ok: false,
        status: 'rejected',
        reason: unknownOnly ? 'unknown_event_type' : 'validation_failed',
        errors: validation.errors,
        knownEventType: validation.knownEventType,
        dryRun,
        ...(dryRun ? { audit_trail: collected } : {}),
      };
    }
    await auditRec(AUDIT_TYPES.EVENT_VALIDATION, { outcome: 'valid', known_event_type: true });

    // ---- normalize (allow-list; drops extra/patient fields) ----
    const event = normalizeEvent(raw);

    // ---- dry-run branch: no persistence whatsoever ----
    if (dryRun) {
      const dryCtx = { ...ctx, dryRun: true, audit: auditSink };
      try {
        const result = await eventRouter.route(event, dryCtx);
        return { ok: true, dryRun: true, event, result, audit_trail: collected };
      } catch (err) {
        return {
          ok: false, dryRun: true, event, reason: 'workflow_error',
          error: sanitizeErrorSummary(err), audit_trail: collected,
        };
      }
    }

    // ---- event-level idempotency + atomic claim ----
    const claim = await store.update((state) => {
      const existing = state.events[event.event_id];
      if (existing) return { duplicate: true, existing };
      state.events[event.event_id] = {
        ...event,
        status: EVENT_STATUS.PROCESSING,
        received_at: isoNow(clock),
        updated_at: isoNow(clock),
        processing_started_at: isoNow(clock),
        processing_completed_at: null,
        processing_duration_ms: null,
        result: null,
        error: null,
        replay_count: 0,
      };
      return { duplicate: false };
    });

    if (claim.duplicate) {
      await audit.append(AUDIT_TYPES.EVENT_DUPLICATE, {
        event_id: event.event_id,
        event_type: event.event_type,
        existing_status: claim.existing.status,
      });
      const perRecipient = await perRecipientResults(event.event_id);
      return { ok: true, duplicate: true, event_id: event.event_id, status: claim.existing.status, per_recipient: perRecipient };
    }

    // ---- route + handle (workflow isolated; event-level failure recorded, not thrown) ----
    let result = null;
    let eventError = null;
    try {
      result = await eventRouter.route(event, { ...ctx, dryRun: false });
    } catch (err) {
      eventError = sanitizeErrorSummary(err);
      await audit.append(AUDIT_TYPES.EVENT_FAILED, { event_id: event.event_id, error: eventError });
    }

    const durationMs = Math.max(0, clock.now().getTime() - startedAtMs);
    await store.update((state) => {
      const ev = state.events[event.event_id];
      ev.processing_completed_at = isoNow(clock);
      ev.processing_duration_ms = durationMs;
      ev.result = result ?? null;
      ev.error = eventError;
      const m = state.metrics;
      m.processingDurationMsTotal += durationMs;
      m.processingDurationMsMax = Math.max(m.processingDurationMsMax, durationMs);
      m.processingSamples += 1;
    });

    const status = await refreshEventStatus(event.event_id);
    return {
      ok: !eventError,
      duplicate: false,
      event_id: event.event_id,
      status: eventError ? EVENT_STATUS.FAILED : status,
      result,
      error: eventError,
      per_recipient: await perRecipientResults(event.event_id),
      processing_duration_ms: durationMs,
    };
  }

  /** Per-recipient results for an event (notifications + delivery state). */
  async function perRecipientResults(eventId) {
    const state = await store.read();
    const deliveries = Object.values(state.deliveries).filter((d) => d.event_id === eventId);
    return deliveries.map((d) => ({
      recipient_id: d.recipient_id,
      notification_id: d.notification_id,
      delivery_id: d.delivery_id,
      channel: d.channel,
      status: d.status,
      attempts: d.attempts,
      next_retry_at: d.next_retry_at,
      last_error: d.last_error,
    }));
  }

  /**
   * Manual replay of a previously ingested event (spec sections 9, 12, 13).
   * Idempotent: already-succeeded recipients are NOT repeated; only non-succeeded
   * recipients are re-attempted; no duplicate notifications created.
   */
  async function replayEvent(eventId, options = {}) {
    const state = await store.read();
    const event = state.events[eventId];
    if (!event) return { ok: false, status: 'missing', event_id: eventId };
    if (event.status === EVENT_STATUS.PROCESSING) return { ok: false, status: 'processing', event_id: eventId };

    await audit.append(AUDIT_TYPES.MANUAL_REPLAY, {
      event_id: eventId,
      event_type: event.event_type,
      prior_status: event.status,
      replay_count: (event.replay_count ?? 0) + 1,
    });

    await store.update((s) => {
      const ev = s.events[eventId];
      ev.replay_count = (ev.replay_count ?? 0) + 1;
      ev.status = EVENT_STATUS.PROCESSING;
      ev.updated_at = isoNow(clock);
    });

    const current = await store.read();
    const unfinished = Object.values(current.deliveries).filter((d) => d.event_id === eventId && d.status !== 'succeeded');
    for (const d of unfinished) {
      await queue.replayOne(d.delivery_id, {
        sink,
        recheck: recheckEligibilitySafe,
        replayContext: options.replayContext ?? 'manual',
      });
    }

    // If no deliveries exist yet (e.g. earlier workflow error), re-run workflow; idempotency prevents duplicates.
    const after = await store.read();
    const anyDeliveries = Object.values(after.deliveries).some((d) => d.event_id === eventId);
    if (!anyDeliveries && event.event_type === EVENT_TYPE_APPOINTMENT_REQUESTED) {
      try {
        await eventRouter.route(event, { ...ctx, dryRun: false });
      } catch (err) {
        await audit.append(AUDIT_TYPES.EVENT_FAILED, { event_id: eventId, error: sanitizeErrorSummary(err) });
      }
    }

    const status = await refreshEventStatus(eventId);
    return { ok: true, event_id: eventId, status, per_recipient: await perRecipientResults(eventId) };
  }

  async function recheckEligibilitySafe(recipientId) {
    try {
      const staff = await recipients.getStaff(recipientId);
      return Boolean(staff && staff.active !== false && ELIGIBLE_ROLES_APPOINTMENT_REQUESTED.includes(staff.role));
    } catch {
      return false;
    }
  }

  /** Run the retry queue for all due deliveries (trusted-worker equivalent for local V1). */
  async function processRetries() {
    const results = await queue.processDue({ sink, recheck: recheckEligibilitySafe });
    const touched = new Set(results.filter((r) => r.delivery).map((r) => r.delivery.event_id));
    for (const id of touched) await refreshEventStatus(id);
    return results;
  }

  /** Manual retry of a single delivery. Never repeats successful deliveries. */
  async function retryDelivery(deliveryId) {
    const before = await queue.get(deliveryId);
    const result = await queue.retryOne(deliveryId, { sink, recheck: recheckEligibilitySafe });
    if (before) await refreshEventStatus(before.event_id);
    return result;
  }

  /** Manual replay of a single failed / dead-lettered delivery. */
  async function replayDelivery(deliveryId) {
    const before = await queue.get(deliveryId);
    const result = await queue.replayOne(deliveryId, { sink, recheck: recheckEligibilitySafe, replayContext: 'manual' });
    if (before) await refreshEventStatus(before.event_id);
    return result;
  }

  return {
    ingest,
    replayEvent,
    processRetries,
    retryDelivery,
    replayDelivery,
    perRecipientResults,
    refreshEventStatus,
    // exposed building blocks (clear interfaces; adapters injected)
    audit,
    notifications,
    queue,
    router: eventRouter,
    store,
    clock,
  };
}

function sanitizeEventType(t) {
  return typeof t === 'string' ? t.slice(0, 100) : null;
}
