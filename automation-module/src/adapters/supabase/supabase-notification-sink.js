/**
 * PRODUCTION ADAPTER (prepared, NOT active in V1).
 *
 * Production delivery would persist per-recipient in-app notifications into the
 * automation-owned `automation_notifications` table (proposal in db/proposals/) and let a
 * trusted server-side worker deliver; V1 is mock/local only. No email/SMS/WhatsApp. No live
 * Supabase calls in V1. Service-role key server-side only.
 */
export class SupabaseNotificationSink {
  constructor({ client, table = 'automation_notifications' }) {
    if (!client || typeof client.from !== 'function') {
      throw new Error('SupabaseNotificationSink requires an injected server-side Supabase client (trusted server only)');
    }
    this.client = client;
    this.table = table;
  }

  async deliver(notification) {
    // Idempotency handled by DB unique constraint; ON CONFLICT DO NOTHING semantics in proposal.
    const { error } = await this.client.from(this.table).upsert(
      {
        notification_id: notification.notification_id,
        event_id: notification.event_id,
        appointment_id: notification.appointment_id ?? null,
        recipient_id: notification.recipient_id,
        channel: notification.channel,
        notification_type: notification.notification_type,
        title: notification.title,
        body: notification.body,
        payload: notification.payload,
        idempotency_key: notification.idempotency_key,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    );
    if (error) throw new Error(`notification persist failed: ${error.message}`);
  }
}
