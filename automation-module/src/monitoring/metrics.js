/**
 * Dashboard metrics (spec section 13). Computed from persisted store; nothing sensitive.
 */

export async function getMetrics(store) {
  const state = await store.read();
  const events = Object.values(state.events);
  const notifications = Object.values(state.notifications);
  const deliveries = Object.values(state.deliveries);

  const processedEvents = events.filter((e) => ['succeeded', 'partial', 'failed'].includes(e.status)).length;
  const failedEvents = events.filter((e) => e.status === 'failed' || e.status === 'partial').length;

  const pendingDeliveries = deliveries.filter((d) =>
    ['pending', 'processing', 'retry_scheduled'].includes(d.status)).length;
  const retryScheduled = deliveries.filter((d) => d.status === 'retry_scheduled').length;
  const succeededDeliveries = deliveries.filter((d) => d.status === 'succeeded').length;
  const failedDeliveries = deliveries.filter((d) => d.status === 'failed').length;
  const deadLetter = deliveries.filter((d) => d.status === 'dead_letter').length;

  // retry count = number of retry.attempt audit records + retry-scheduled transitions
  const retryCount = state.audit.filter((a) => a.type === 'retry.attempt').length;

  const finished = succeededDeliveries + failedDeliveries + deadLetter;
  const successRateDeliveries = finished === 0 ? null : succeededDeliveries / finished;
  const successRateEvents = processedEvents === 0 ? null : (processedEvents - failedEvents) / processedEvents;

  const m = state.metrics ?? {};
  const samples = m.processingSamples ?? 0;

  return {
    total_events: events.length,
    processed_events: processedEvents,
    failed_events: failedEvents,
    notification_count: notifications.length,
    pending_deliveries: pendingDeliveries,
    retry_scheduled: retryScheduled,
    retry_count: retryCount,
    dead_letter_count: deadLetter,
    succeeded_deliveries: succeededDeliveries,
    failed_deliveries: failedDeliveries,
    // success rate definition documented; both exposed. Primary = deliveries.
    success_rate: successRateDeliveries,
    success_rate_events: successRateEvents,
    processing_duration_ms_total: m.processingDurationMsTotal ?? 0,
    processing_duration_ms_avg: samples === 0 ? null : (m.processingDurationMsTotal ?? 0) / samples,
    processing_duration_ms_max: m.processingDurationMsMax ?? 0,
    audit_entries: state.audit.length,
    generated_at: new Date().toISOString(),
  };
}
