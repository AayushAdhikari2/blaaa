-- PROPOSAL ONLY — DO NOT APPLY. 0005 — append-only execution history / audit (spec section 13).

create table if not exists automation.automation_execution_log (
  log_id      bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  type        text not null,            -- event.received, event.validation, recipients.resolved,
                                        -- notification.created, notification.duplicate_skipped,
                                        -- delivery.attempt, delivery.result, retry.attempt, retry.scheduled,
                                        -- event.failed, delivery.failed, dead_letter, manual.replay, ...
  event_id    uuid,
  recipient_id uuid,
  delivery_id uuid,
  notification_id uuid,
  appointment_id text,
  data        jsonb not null default '{}'::jsonb,  -- sanitized; NO patient name/phone/access code/password/token/secret
  constraint automation_execution_log_no_patient_keys check (
    not (data ?| array['name','phone','access_code','code','password','token','secret','email','full_name','service_role_key'])
  )
);

create index if not exists automation_execution_log_event_idx on automation.automation_execution_log (event_id, at);
create index if not exists automation_execution_log_type_idx on automation.automation_execution_log (type, at);

-- Append-only: forbid UPDATE/DELETE at the DB layer.
create or replace function automation.forbid_mutation()
returns trigger language plpgsql as $$ begin raise exception 'append-only table'; end $$;
drop trigger if exists automation_execution_log_no_update on automation.automation_execution_log;
create trigger automation_execution_log_no_update before update on automation.automation_execution_log
  for each row execute function automation.forbid_mutation();
drop trigger if exists automation_execution_log_no_delete on automation.automation_execution_log;
create trigger automation_execution_log_no_delete before delete on automation.automation_execution_log
  for each row execute function automation.forbid_mutation();

-- monitoring view (safe columns only)
create or replace view automation.automation_metrics as
select
  (select count(*) from automation.automation_events) as total_events,
  (select count(*) from automation.automation_events where status='succeeded') as processed_events,
  (select count(*) from automation.automation_events where status in ('failed','dead_letter','partial')) as failed_events,
  (select count(*) from automation.automation_notifications) as notification_count,
  (select count(*) from automation.automation_deliveries where status in ('pending','processing','retry_scheduled')) as pending_deliveries,
  (select count(*) from automation.automation_delivery_attempts where outcome='failed' and failure_class='transient') as retry_count,
  (select count(*) from automation.automation_deliveries where status='dead_letter') as dead_letter_count;
