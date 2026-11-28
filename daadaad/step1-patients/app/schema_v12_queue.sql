-- ===== v12 / STEP 2: queue board (realtime + "Call next") =====
-- Run after v11. Safe to re-run.

-- 1. realtime: lets the browser hear about visit changes instantly (Supabase applies the table's RLS to these events,
--    so a doctor only receives events for their own patients)
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='visits') then
    alter publication supabase_realtime add table public.visits;
  end if;
end $$;

-- 2. call the next patient: oldest in the queue (waiting, or back from lab) goes to the room.
--    One statement under a row lock: two clicks at once (or two screens) can never call the same patient.
--    Same order the patient's own "you are Nth" number uses (q_at), so the board and the patient page agree.
create or replace function call_next(p_doctor text) returns json
language plpgsql security definer set search_path=public as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits;
begin
  if my_role() = 'doctor' then
    if p_doctor is distinct from my_doctor() then raise exception 'this is not your queue'; end if;
  elsif my_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  select * into v from visits
   where doctor_id=p_doctor and visit_date=d and status in ('waiting','review')
   order by q_at, id limit 1 for update skip locked;
  if not found then return null; end if;
  update visits set status='in_room' where id=v.id returning * into v;
  return row_to_json(v);
end $$;
revoke all on function call_next(text) from public, anon;
grant execute on function call_next(text) to authenticated;
