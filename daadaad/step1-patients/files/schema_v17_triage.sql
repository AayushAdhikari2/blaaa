-- ===== v17 / STEP 7: triage and queue control =====
-- Run after v16. Safe to re-run.
-- Priority (urgent / emergency), skip, "not present" (and back), recall, and per-doctor pause (lunch, emergency).
-- Queue order everywhere becomes: priority first, then arrival time (q_at), then id. "Not present" patients are not in the line.

alter table visits add column if not exists priority smallint not null default 0 check (priority in (0,1,2));   -- 0 normal, 1 urgent, 2 emergency
alter table visits add column if not exists triage_note text;
alter table visits add column if not exists away boolean not null default false;
alter table visits add column if not exists away_at timestamptz;
alter table visits add column if not exists skip_count int not null default 0;
alter table visits add column if not exists recall_count int not null default 0;
alter table doctors add column if not exists paused boolean not null default false;
alter table doctors add column if not exists pause_reason text;
alter table doctors add column if not exists paused_at timestamptz;

insert into settings(key,value) values ('away_return','back') on conflict (key) do nothing;   -- 'back' = returning patient joins the end; 'keep' = keeps the old place

-- these columns can only be changed through the functions below (so every change is checked and logged)
create or replace function guard_triage_cols() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and
     (new.priority,new.triage_note,new.away,new.away_at,new.skip_count,new.recall_count) is distinct from (old.priority,old.triage_note,old.away,old.away_at,old.skip_count,old.recall_count)
  then raise exception 'use the triage buttons to change priority or presence'; end if;
  return new;
end $$;
drop trigger if exists visits_triage_guard on visits; create trigger visits_triage_guard before update on visits for each row execute function guard_triage_cols();
create or replace function guard_doctor_pause() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and (new.paused,new.pause_reason,new.paused_at) is distinct from (old.paused,old.pause_reason,old.paused_at)
  then raise exception 'use the pause button'; end if;
  return new;
end $$;
drop trigger if exists doctors_pause_guard on doctors; create trigger doctors_pause_guard before update on doctors for each row execute function guard_doctor_pause();

-- realtime for pause changes
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
     and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='doctors') then
    alter publication supabase_realtime add table public.doctors;
  end if;
end $$;

-- who may triage this visit: reception, admin, or the visit's own doctor
create or replace function can_triage(p_visit bigint) returns boolean language sql stable security definer set search_path=public as $$
  select case my_role() when 'admin' then true when 'reception' then true
    when 'doctor' then exists(select 1 from visits where id=p_visit and doctor_id=my_doctor()) else false end
$$;

create or replace function set_priority(p_visit bigint, p_level int, p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  if not can_triage(p_visit) then raise exception 'not allowed'; end if;
  if p_level not in (0,1,2) then raise exception 'invalid priority'; end if;
  update visits set priority=p_level, triage_note=case when p_level=0 then null else left(nullif(trim(coalesce(p_reason,'')),''),120) end
   where id=p_visit and status<>'done';
  if not found then raise exception 'this visit is already completed'; end if;
  perform audit_write(auth.uid(),'TRIAGE','visits',p_visit::text,jsonb_build_object('level',p_level));
end $$;

-- skip = go to the back of the line (e.g. "I need the toilet")
create or replace function skip_visit(p_visit bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if not can_triage(p_visit) then raise exception 'not allowed'; end if;
  update visits set q_at=now(), skip_count=skip_count+1 where id=p_visit and status in ('waiting','review') and not away;
  if not found then raise exception 'only a waiting patient can be skipped'; end if;
  perform audit_write(auth.uid(),'QUEUE_SKIP','visits',p_visit::text,'{}'::jsonb);
end $$;

-- not present: called but not here. Leaves the line (a called patient goes back to waiting, marked away).
create or replace function mark_away(p_visit bigint) returns void language plpgsql security definer set search_path=public as $$
declare v visits;
begin
  if not can_triage(p_visit) then raise exception 'not allowed'; end if;
  select * into v from visits where id=p_visit for update;
  if not found or v.status not in ('waiting','review','in_room') then raise exception 'this patient cannot be marked not present'; end if;
  update visits set away=true, away_at=now(),
         status=case when v.status='in_room' then (case when v.report_path is not null then 'review' else 'waiting' end) else v.status end
   where id=p_visit;
  perform audit_write(auth.uid(),'QUEUE_AWAY','visits',p_visit::text,'{}'::jsonb);
end $$;

create or replace function mark_back(p_visit bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if not can_triage(p_visit) then raise exception 'not allowed'; end if;
  update visits set away=false, away_at=null,
         q_at=case when coalesce((select value from settings where key='away_return'),'back')='keep' then q_at else now() end
   where id=p_visit and away and status in ('waiting','review');
  if not found then raise exception 'this patient is not marked as away'; end if;
  perform audit_write(auth.uid(),'QUEUE_BACK','visits',p_visit::text,'{}'::jsonb);
end $$;

-- recall: the patient was called but has not come. Sends one more SMS (if they agreed to SMS).
create or replace function recall_visit(p_visit bigint) returns void language plpgsql security definer set search_path=public as $$
declare v visits;
begin
  if not can_triage(p_visit) then raise exception 'not allowed'; end if;
  update visits set recall_count=recall_count+1 where id=p_visit and status='in_room' returning * into v;
  if not found then raise exception 'only a patient who is with the doctor can be called again'; end if;
  perform enqueue_msg(v, 'recall '||v.recall_count, msg_text('recall', v));
  perform audit_write(auth.uid(),'QUEUE_RECALL','visits',p_visit::text,jsonb_build_object('n',v.recall_count));
end $$;

create or replace function set_doctor_pause(p_doctor text, p_paused boolean, p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  if not (my_role() in ('reception','admin') or (my_role()='doctor' and p_doctor=my_doctor())) then raise exception 'not allowed'; end if;
  update doctors set paused=p_paused, pause_reason=case when p_paused then left(nullif(trim(coalesce(p_reason,'')),''),60) end,
         paused_at=case when p_paused then now() end where id=p_doctor;
  if not found then raise exception 'unknown doctor'; end if;
  perform audit_write(auth.uid(),case when p_paused then 'QUEUE_PAUSE' else 'QUEUE_RESUME' end,'doctors',p_doctor,'{}'::jsonb);
end $$;

do $$ declare f text; begin
  foreach f in array array['set_priority(bigint,int,text)','skip_visit(bigint)','mark_away(bigint)','mark_back(bigint)','recall_visit(bigint)','set_doctor_pause(text,boolean,text)','can_triage(bigint)'] loop
    execute format('revoke all on function %s from public, anon', f); execute format('grant execute on function %s to authenticated', f);
  end loop; end $$;

-- ---------- call next: priority first, never a paused doctor, never an absent patient ----------
create or replace function call_next(p_doctor text) returns json
language plpgsql security definer set search_path=public as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits;
begin
  if my_role() = 'doctor' then
    if p_doctor is distinct from my_doctor() then raise exception 'this is not your queue'; end if;
  elsif my_role() is distinct from 'admin' then raise exception 'not allowed'; end if;
  if (select paused from doctors where id=p_doctor) then raise exception 'the queue is paused: resume it first'; end if;
  select * into v from visits
   where doctor_id=p_doctor and visit_date=d and status in ('waiting','review') and not away
   order by priority desc, q_at, id limit 1 for update skip locked;
  if not found then return null; end if;
  update visits set status='in_room' where id=v.id returning * into v;
  return row_to_json(v);
end $$;

-- ---------- "N patients ahead" messages follow the same order ----------
create or replace function queue_alerts(p_doc text, p_date date) returns void
language plpgsql security definer set search_path=public as $$
declare r record; vv visits; thr int := coalesce((select nullif(value,'')::int from settings where key='ahead_threshold'),2);
        inroom int := (select count(*) from visits where doctor_id=p_doc and visit_date=p_date and status='in_room');
begin
  if (select paused from doctors where id=p_doc) then return; end if;
  for r in
    select id, row_number() over (order by priority desc, q_at, id) - 1 + inroom as ahead
    from visits where doctor_id=p_doc and visit_date=p_date and status in ('waiting','review') and not away
  loop
    if r.ahead <= thr then
      select * into vv from visits where id=r.id;
      perform enqueue_msg(vv, case when vv.status='review' then 'ahead_review' else 'ahead' end, msg_text('ahead', vv, r.ahead::int));
    end if;
  end loop;
end $$;

-- ---------- patient page: same order, plus "not present" and "paused" ----------
create or replace function patient_status(p_bill text,p_code text)
returns json language plpgsql security definer set search_path=public as $$
declare v visits; d doctors; b text := upper(trim(p_bill)); pos int; q int; r int; tot numeric; rx text;
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5
    then return json_build_object('locked',true); end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return null; end if;
  select * into d from doctors where id=v.doctor_id;
  select count(*) into q from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review') and not away;
  select count(*)+1 into pos from visits o where o.doctor_id=v.doctor_id and o.visit_date=v.visit_date and o.status in('waiting','review') and not o.away
     and (o.priority>v.priority or (o.priority=v.priority and (o.q_at<v.q_at or (o.q_at=v.q_at and o.id<v.id))));
  select count(*) into r from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status='in_room';
  select coalesce(sum(amount),0) into tot from bill_items where visit_id=v.id;
  select case when exists(select 1 from prescriptions where visit_id=v.id and status='pending') then 'pending'
              when exists(select 1 from prescriptions where visit_id=v.id and status='dispensed') then 'dispensed' else 'none' end into rx;
  return json_build_object('bill',v.bill,'name',v.name,'doctor',d.name,'dept',d.dept,'token',v.token,
    'status',v.status,'test_name',v.test_name,'test_due',v.test_due,'report_path',v.report_path,
    'pos',case when v.status in('waiting','review') and not v.away then pos end,'in_room',r,'queue_len',q,'avg_min',d.avg_min,
    'total',tot,'paid',v.paid_at is not null,'rx',rx,'sms',v.consent_sms,
    'away',v.away,'paused',d.paused,'pause_reason',d.pause_reason,'recalled',v.recall_count);
end $$;
grant execute on function patient_status(text,text) to anon, authenticated;

-- ---------- waiting-room TV board: same order, shows "paused", still no personal data ----------
create or replace function queue_board() returns json
language sql stable security definer set search_path=public as $$
  with t as (select (now() at time zone 'Asia/Kathmandu')::date as d)
  select json_build_object(
    'clinic', coalesce((select value from settings where key='clinic_name'),'Carepulse'),
    'at', now(),
    'doctors', coalesce((
      select json_agg(x order by x.name) from (
        select dr.name, dr.dept, dr.paused,
          coalesce((select json_agg(v.token order by v.q_at) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status='in_room'),'[]'::json) as serving,
          coalesce((select json_agg(q.token order by q.priority desc, q.q_at, q.id) from (
              select v.token, v.q_at, v.priority, v.id from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review') and not v.away
              order by v.priority desc, v.q_at, v.id limit 6) q),'[]'::json) as next,
          (select count(*) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review') and not v.away) as waiting
        from doctors dr where dr.active order by dr.name) x),'[]'::json));
$$;
grant execute on function queue_board() to anon, authenticated;
