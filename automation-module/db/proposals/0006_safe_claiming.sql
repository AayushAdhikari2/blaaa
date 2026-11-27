-- PROPOSAL ONLY — DO NOT APPLY. 0006 — safe event claiming for concurrent workers.
--
-- Workers run on a trusted server with a dedicated low-privilege role (NOT service-role in browser).
-- Claiming uses FOR UPDATE SKIP LOCKED so concurrent workers never claim the same row.
-- Leases allow crash recovery; expired claims become reclaimable. Combined with DB uniqueness
-- (0001/0003/0004), processing is at-least-once transport + idempotent effects.
-- NOT exactly-once. Local V1 JSON store claims inside a single-process mutex; production
-- requires these DB mechanics.

-- ---- outbox claim ----
create or replace function automation.claim_outbox_batch(p_worker text, p_limit integer default 50, p_lease_seconds integer default 60)
returns setof automation.automation_outbox
language plpgsql
security definer
set search_path = automation, public
as $$
begin
  return query
  with claimed as (
    select o.event_id from automation.automation_outbox o
    where o.status in ('pending','failed')
       or (o.status = 'claimed' and o.lease_expires_at < now())
    order by o.created_at
    limit p_limit
    for update skip locked
  )
  update automation.automation_outbox o
     set status = 'claimed', claimed_at = now(), claimed_by = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = o.attempts + 1
    from claimed c
   where o.event_id = c.event_id
  returning o.*;
end;
$$;

-- ---- delivery claim ----
create or replace function automation.claim_delivery_batch(p_worker text, p_limit integer default 50, p_lease_seconds integer default 60)
returns setof automation.automation_deliveries
language plpgsql
security definer
set search_path = automation, public
as $$
begin
  return query
  with claimed as (
    select d.delivery_id from automation.automation_deliveries d
    where d.status = 'pending'
       or (d.status = 'retry_scheduled' and (d.next_retry_at is null or d.next_retry_at <= now()))
       or (d.status = 'processing' and d.lease_expires_at < now())
    order by d.updated_at
    limit p_limit
    for update skip locked
  )
  update automation.automation_deliveries d
     set status = 'processing', claimed_at = now(), claimed_by = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = d.attempts + 1, updated_at = now()
    from claimed c
   where d.delivery_id = c.delivery_id
  returning d.*;
end;
$$;

-- Justified SECURITY DEFINER: only a trusted worker role may claim; search_path pinned;
-- no PII returned beyond what the worker already needs; revoked from public/anon/authenticated.
revoke all on function automation.claim_outbox_batch(text, integer, integer) from public, anon, authenticated;
revoke all on function automation.claim_delivery_batch(text, integer, integer) from public, anon, authenticated;
-- grant execute on function automation.claim_outbox_batch(text, integer, integer) to automation_worker;
-- grant execute on function automation.claim_delivery_batch(text, integer, integer) to automation_worker;

-- ---- retry scheduling (called by worker after a transient failure) ----
-- update automation.automation_deliveries
--    set status = case when attempts >= max_attempts then 'dead_letter' else 'retry_scheduled' end,
--        next_retry_at = now() + least( make_interval(secs => (1000 * power(2, greatest(attempts-1,0))) / 1000.0 ), interval '60 seconds'),
--        last_error = <sanitized>, updated_at = now()
--  where delivery_id = ...;
