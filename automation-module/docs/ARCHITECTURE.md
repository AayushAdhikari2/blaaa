# Architecture

## Goals
Independent, event-driven automation for hospital business events. Focused, not a massive
generic workflow builder. Clear interfaces between core logic and adapters. Extensible for
future hospital events and separate workflows (doctor notification, patient notification are
**later, separate** workflows — not implemented).

## Layered design

```
                         ┌──────────────────────────────────────────────┐
   raw event (untrusted) │  CORE                                          │
   ────────────────────► │  event-validator  → reject invalid/unknown    │
                         │  event-normalizer → allow-list canonical form │
                         │  event-ingestion  → idempotent claim + route  │ ──► audit
                         │  event-router     → event_type → handler      │
                         └───────────────────────┬──────────────────────┘
                                                 ▼
                         ┌──────────────────────────────────────────────┐
                         │  WORKFLOW appointment.requested (Process 01)  │
                         │  recipient-resolver (trusted, re-check)       │
                         │  notification-service (idempotent create)     │
                         └───────────────────────┬──────────────────────┘
                                                 ▼
                         ┌──────────────────────────────────────────────┐
                         │  RELIABILITY delivery queue                   │
                         │  pending→processing→succeeded                 │
                         │   →retry_scheduled→failed→dead_letter         │
                         │  bounded backoff, max attempts, classify,     │
                         │  sanitized errors, manual replay, history     │
                         └───────────────────────┬──────────────────────┘
                                                 ▼
   adapters ────────────────────────────────────────────────────────────
   mock: MockStore(.local JSON, atomic, mutex) · MockRecipientProvider · MockNotificationSink · EventSimulator
   supabase (prepared, not active V1): SupabaseRecipientProvider · SupabaseNotificationSink (trusted server, service-role server-only, no live calls)
   monitoring: metrics · health   audit: append-only sanitized
```

## Core interfaces (adapters injected; core has no I/O of its own)

```js
// recipient resolution — trusted server-side; NEVER client-supplied
RecipientProvider.listStaff(): Promise<{ id, role, active? }[]>
RecipientProvider.getStaff(id): Promise<{ id, role, active? } | null>

// delivery target — V1 mock/local; no email/SMS/WhatsApp
NotificationSink.deliver(notification): Promise<void>   // throws transient|permanent

// persistence — local V1; production Postgres proposal mirrors contract
Store.read(): Promise<State>
Store.update(fn): Promise<...>   // atomic read-modify-write inside mutex

// engine
createEngine({ store, recipients, sink, clock, policy }): {
  ingest(raw, { dryRun? }), replayEvent(id), processRetries(),
  retryDelivery(id), replayDelivery(id), perRecipientResults(id), ...
}
Clock { now(): Date }   // injectable; ManualClock for deterministic tests
```

## Event flow
1. **Ingest** raw → audit `event.received`.
2. **Validate** (`event-validator`) → `event.validation`. Invalid → rejected. Unknown type → `unknown_event_type`, rejected. Nothing routed.
3. **Normalize** allow-list → canonical envelope; strip extras; no patient fields.
4. **Idempotency** atomic claim on `event_id`. Duplicate → `event.duplicate`, no reprocessing, no repeated successful deliveries.
5. **Route** `appointment.requested` → Process 01 workflow.
6. **Recipients** resolve `reception`+`admin`; count audited; re-check eligibility per recipient at processing time.
7. **Notifications** idempotent create `notification.created` / `notification.duplicate_skipped`.
8. **Delivery** per-recipient queue; `delivery.attempt`/`delivery.result`; partial isolation.
9. **Retry** transient → `retry.scheduled`; due processing; max → `event.failed` → `dead_letter`.
10. **Status** event → succeeded | partial | failed. **Audit + metrics** throughout.

## Dry-run
Validation + recipient resolution + planned notifications; **nothing persisted** (no event claim,
no notification, no delivery, no persisted audit; in-memory trail returned).

## Replay
`replayEvent(id)` / `replayDelivery(id)`: append-only history preserved; replay marker appended;
non-succeeded recipients re-attempted; **already-succeeded deliveries never repeated**; no duplicate
notifications (unique key); fresh bounded attempt round on manual replay; `manual.replay` audited.

## Exactly-once honesty
Not claimed. Local V1: single-process atomic claim + atomic file rename + unique keys. Production:
at-least-once transport + transactional outbox + DB uniqueness + `FOR UPDATE SKIP LOCKED` + lease
+ idempotent effects. See `docs/supabase-architecture.md`. **Local browser timers are not reliable
production workers.**

## Future extensibility
`EventRouter.register(type, handler)`, `RecipientProvider`, `NotificationSink`, `Store`, `Clock`,
`RetryPolicy` are explicit seams. New hospital events add handlers; no framework needed.

## What is NOT here
Process 02; AI; doctor notification; patient notification; real patient identities; email/SMS/WhatsApp;
live Supabase; any change to existing application code; applied SQL.
