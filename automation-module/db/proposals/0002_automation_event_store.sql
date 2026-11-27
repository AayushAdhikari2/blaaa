-- PROPOSAL ONLY — DO NOT APPLY. 0002 — durable automation-owned event storage.

create table if not exists automation.automation_events (
  event_id        uuid primary key,                 -- stable id; never regenerated
  event_type      text not null,                    -- 'appointment.requested'
  schema_version  integer not null default 1,
  source          text not null,
  source_id       text not null,
  occurred_at     timestamptz not null,
  payload         jsonb not null,                   -- minimal; no patient name/phone/code/secrets
  status          text not null default 'received'
                    check (status in ('received','processing','succeeded','partial','failed','dead_letter')),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  attempts        integer not null default 0,
  replay_count    integer not null default 0,
  -- safe claiming (worker lease); see 0006
  claimed_at      timestamptz,
  claimed_by      text,
  lease_expires_at timestamptz,
  last_error      text,                             -- sanitized summary only
  constraint automation_events_unique unique (event_type, source, source_id, event_id)
);

create index if not exists automation_events_status_idx
  on automation.automation_events (status, received_at);
create index if not exists automation_events_claim_idx
  on automation.automation_events (status, lease_expires_at);
create index if not exists automation_events_source_idx
  on automation.automation_events (source, source_id);
