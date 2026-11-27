import { AUDIT_TYPES } from '../../audit/audit-log.js';
import {
  resolveRecipients,
  recheckEligibility,
  ELIGIBLE_ROLES_APPOINTMENT_REQUESTED,
} from '../../notifications/recipient-resolver.js';
// NotificationService.createNotification emits notification.created / notification.duplicate_skipped audit.
import { CHANNEL_IN_APP, NOTIFICATION_TYPE_APPOINTMENT_REQUESTED } from '../../notifications/idempotency.js';
import { classifyError, errorSummary } from '../../reliability/error-classification.js';

export const PROCESS_NAME = 'appointment-requested';
export const WORKFLOW_VERSION = 1;

/**
 * PROCESS 01 — appointment.requested.
 *
 * Source event: INSERT into public.appointments with status='requested'.
 * Recipients: profiles.role in ('reception','admin'); never doctor/lab/anonymous/patient;
 * recipients resolved server-side; eligibility re-checked at processing time.
 * One in-app notification per eligible staff profile; idempotent per
 * (event_id, recipient_id, channel, notification_type).
 * Partial recipient failure: one recipient's failure never blocks others; failed recipients
 * are retryable/dead-lettered individually; successful recipients are never repeated.
 *
 * NOT implemented here (later separate workflows): doctor notification, patient notification.
 */
export async function appointmentRequestedWorkflow(event, ctx) {
  const {
    recipients: recipientProvider,
    notifications: notificationService,
    queue,
    audit,
    sink,
    clock,
    dryRun = false,
  } = ctx;

  const appointment_id = String(event.payload.appointment_id);
  const now = clock.now().toISOString();

  // ---- recipient resolution (trusted server-side; never from event/browser) ----
  const recipients = await resolveRecipients(recipientProvider, { roles: ELIGIBLE_ROLES_APPOINTMENT_REQUESTED });
  await audit.append(AUDIT_TYPES.RECIPIENTS_RESOLVED, {
    event_id: event.event_id,
    appointment_id,
    recipient_count: recipients.length,
    roles_allowed: [...ELIGIBLE_ROLES_APPOINTMENT_REQUESTED],
    recipients: recipients.map((r) => ({ recipient_id: r.id, role: r.role })),
    dry_run: dryRun,
  });

  // ---- dry-run: report plan, mutate nothing ----
  if (dryRun) {
    const planned = recipients.map((r) => ({
      recipient_id: r.id,
      role: r.role,
      channel: CHANNEL_IN_APP,
      notification_type: NOTIFICATION_TYPE_APPOINTMENT_REQUESTED,
      title: 'New appointment request',
      body: 'A new online appointment request requires reception review.',
    }));
    await audit.append(AUDIT_TYPES.DRY_RUN, { event_id: event.event_id, appointment_id, planned_count: planned.length });
    return { dryRun: true, appointment_id, recipients, plannedNotifications: planned, created: 0, delivered: 0 };
  }

  // ---- per-recipient processing; failure isolated per recipient (partial success) ----
  const results = [];
  for (const recipient of recipients) {
    const outcome = {
      recipient_id: recipient.id,
      role: recipient.role,
      notification_id: null,
      created: false,
      duplicate: false,
      delivery_status: 'skipped',
      error: null,
    };
    try {
      // Re-check eligibility at processing time.
      const stillEligible = await recheckEligibility(recipientProvider, recipient.id, ELIGIBLE_ROLES_APPOINTMENT_REQUESTED);
      if (!stillEligible) {
        await audit.append(AUDIT_TYPES.RECIPIENT_SKIPPED, {
          event_id: event.event_id,
          recipient_id: recipient.id,
          reason: 'recipient no longer eligible at processing time',
        });
        outcome.delivery_status = 'skipped_ineligible';
        results.push(outcome);
        continue;
      }

      // Idempotent notification creation.
      const created = await notificationService.createNotification({
        event,
        appointment_id,
        recipient_id: recipient.id,
        now,
        channel: CHANNEL_IN_APP,
        notification_type: NOTIFICATION_TYPE_APPOINTMENT_REQUESTED,
      });
      outcome.notification_id = created.notification.notification_id;
      outcome.created = created.created;
      outcome.duplicate = created.duplicate;

      // Idempotent per-recipient delivery.
      const delivery = await queue.enqueue({ notification: created.notification });
      const deliveryResult = await queue.attempt(delivery.delivery_id, {
        sink,
        recheck: (recipientId) => recheckEligibility(recipientProvider, recipientId, ELIGIBLE_ROLES_APPOINTMENT_REQUESTED),
      });
      outcome.delivery_status = deliveryResult.status;
    } catch (err) {
      // Partial recipient failure: isolate, record sanitized summary, continue with others.
      outcome.error = errorSummary(err);
      outcome.delivery_status = classifyError(err) === 'transient' ? 'retry_scheduled' : 'failed';
      await audit.append(AUDIT_TYPES.DELIVERY_FAILED, {
        event_id: event.event_id,
        appointment_id,
        recipient_id: recipient.id,
        error: outcome.error,
        failure_class: classifyError(err),
      });
    }
    results.push(outcome);
  }

  const summary = {
    appointment_id,
    recipient_count: recipients.length,
    notifications_created: results.filter((r) => r.created).length,
    duplicates_skipped: results.filter((r) => r.duplicate).length,
    succeeded: results.filter((r) => r.delivery_status === 'succeeded').length,
    retry_scheduled: results.filter((r) => r.delivery_status === 'retry_scheduled').length,
    failed: results.filter((r) => r.delivery_status === 'failed' || r.delivery_status === 'dead_letter').length,
    per_recipient: results,
  };
  return summary;
}
