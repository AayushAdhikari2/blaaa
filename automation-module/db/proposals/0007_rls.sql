-- PROPOSAL ONLY — DO NOT APPLY. 0007 — RLS + privileges for automation-owned tables.
--
-- Principle: automation schema is service-role / worker-only. No anon. No browser access to
-- sensitive tables. The future UI reads notifications ONLY through a trusted API or narrowly
-- scoped policy; V1 exposes nothing to the browser beyond safe demo data.

-- schema privileges
revoke all on schema automation from public, anon, authenticated;
grant usage on schema automation to automation_worker;   -- create this role in your project

alter table automation.automation_outbox          enable row level security;
alter table automation.automation_events          enable row level security;
alter table automation.automation_notifications   enable row level security;
alter table automation.automation_deliveries      enable row level security;
alter table automation.automation_delivery_attempts enable row level security;
alter table automation.automation_execution_log   enable row level security;

revoke all on all tables in schema automation from public, anon, authenticated;

-- worker-only policies (service-role bypasses RLS; explicit policy for the named role):
drop policy if exists automation_worker_all on automation.automation_outbox;
create policy automation_worker_all on automation.automation_outbox
  for all to automation_worker using (true) with check (true);
-- (repeat pattern for automation_events / automation_notifications / automation_deliveries /
--  automation_delivery_attempts / automation_execution_log in your reviewed migration.)

-- OPTIONAL future UI (documented, NOT enabled here): a reception/admin staff member could
-- read ONLY their own in-app notifications. Requires my_role() in ('reception','admin') and
-- recipient_id = auth.uid(); never exposes patient data (none is stored). Example:
-- drop policy if exists staff_read_own on automation.automation_notifications;
-- create policy staff_read_own on automation.automation_notifications
--   for select to authenticated
--   using (recipient_id = auth.uid() and my_role() in ('reception','admin'));

-- execution log is append-only AND unreadable to non-workers; no UPDATE/DELETE policy exists,
-- and triggers forbid mutation (0005). anon has no privileges. service-role key stays server-side.
