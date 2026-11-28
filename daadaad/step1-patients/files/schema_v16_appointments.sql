-- ===== v16 / STEP 6: real appointments =====
-- Run after v15. Safe to re-run.
-- Doctor schedules + time slots, request -> confirm -> reschedule / cancel, no-show flag, and the appointment SMS (step 4).
-- Flow: patient asks online (optionally picking a free slot) or reception books by phone -> reception confirms -> SMS ->
--       reminder the day before -> patient arrives (existing "Register" button) or is marked no-show.

-- ---------- schedules ----------
create table if not exists doctor_schedules(
  id bigint generated always as identity primary key,
  doctor_id text not null references doctors(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),          -- 0 = Sunday ... 6 = Saturday
  start_time time not null, end_time time not null,
  slot_min int not null default 15 check (slot_min between 5 and 120),
  active boolean not null default true,
  check (end_time > start_time));
create table if not exists doctor_days_off(
  doctor_id text not null references doctors(id) on delete cascade,
  day date not null, note text,
  primary key (doctor_id, day));
alter table doctor_schedules enable row level security; alter table doctor_days_off enable row level security;
drop policy if exists "sched read" on doctor_schedules;  create policy "sched read" on doctor_schedules for select to authenticated using (true);
drop policy if exists "sched admin" on doctor_schedules; create policy "sched admin" on doctor_schedules for all to authenticated using (my_role()='admin') with check (my_role()='admin');
drop policy if exists "off read" on doctor_days_off;  create policy "off read" on doctor_days_off for select to authenticated using (true);
drop policy if exists "off admin" on doctor_days_off; create policy "off admin" on doctor_days_off for all to authenticated using (my_role()='admin') with check (my_role()='admin');
select attach_audit('doctor_schedules'), attach_audit('doctor_days_off');

-- ---------- appointments: new states and columns ----------
alter table appointments drop constraint if exists appointments_status_check;
alter table appointments add constraint appointments_status_check check (status in ('requested','confirmed','converted','cancelled','no_show'));
alter table appointments add column if not exists slot_at timestamptz;
alter table appointments add column if not exists source text not null default 'online';
alter table appointments add column if not exists cancel_reason text;
alter table appointments add column if not exists confirmed_at timestamptz;
alter table appointments add column if not exists confirmed_by uuid;
alter table appointments add column if not exists no_show_at timestamptz;
-- one confirmed appointment per doctor per slot
create unique index if not exists appt_slot_uq on appointments(doctor_id, slot_at) where status='confirmed';
create index if not exists appt_status_idx on appointments(status, slot_at);

-- ---------- slot grid ----------
create or replace function slot_grid(p_doctor text, p_day date) returns setof timestamptz language sql stable as $$
  select distinct ((p_day + s.start_time + m * interval '1 minute') at time zone 'Asia/Kathmandu')
  from doctor_schedules s
  cross join lateral generate_series(0, (extract(epoch from (s.end_time - s.start_time))/60)::int - s.slot_min, s.slot_min) m
  where s.doctor_id=p_doctor and s.active and s.weekday = extract(dow from p_day)::int
    and not exists(select 1 from doctor_days_off o where o.doctor_id=p_doctor and o.day=p_day)
$$;

-- free slots for one doctor on one day. Public: shows only times, never who booked.
create or replace function available_slots(p_doctor text, p_day date) returns json language plpgsql stable security definer set search_path=public as $$
declare t date := (now() at time zone 'Asia/Kathmandu')::date;
begin
  if p_day is null or p_day < t or p_day > t + 60 then return '[]'::json; end if;
  return coalesce((select json_agg(json_build_object('at',g.s,'label',to_char(g.s at time zone 'Asia/Kathmandu','HH12:MI AM')) order by g.s)
    from slot_grid(p_doctor,p_day) g(s)
    where g.s > now() + interval '10 minutes'
      and not exists(select 1 from appointments a where a.doctor_id=p_doctor and a.slot_at=g.s and a.status='confirmed')),'[]'::json);
end $$;
grant execute on function available_slots(text,date) to anon, authenticated;

create or replace function slot_ok(p_doctor text, p_slot timestamptz) returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from slot_grid(p_doctor, (p_slot at time zone 'Asia/Kathmandu')::date) g(s) where g.s = p_slot)
$$;

create or replace function appt_vars(a appointments) returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('clinic',clinic(),'name',split_part(a.name,' ',1),'doctor',(select name from doctors where id=a.doctor_id),
    'date',to_char(coalesce(a.slot_at at time zone 'Asia/Kathmandu', a.preferred_date::timestamp),'Dy DD Mon'),
    'time',coalesce(to_char(a.slot_at at time zone 'Asia/Kathmandu','HH12:MI AM'),''))
$$;

-- ---------- online request (now with an optional preferred slot) ----------
drop function if exists request_appointment(text,text,text,date,text,boolean,boolean);
create or replace function request_appointment(p_name text,p_phone text,p_doctor text,p_date date,p_reason text,
  p_consent boolean default false, p_sms boolean default false, p_slot timestamptz default null)
returns void language plpgsql security definer set search_path=public as $$
declare ph text := left(trim(coalesce(p_phone,'')),20); dd date := p_date;
begin
  if not coalesce(p_consent,false) then raise exception 'consent required'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(ph)<6 then raise exception 'name and phone required'; end if;
  if not exists(select 1 from doctors where id=p_doctor and active) then raise exception 'unknown doctor'; end if;
  if (select count(*) from appointments where phone=ph and created_at>now()-interval '1 hour')>=3 then raise exception 'too many requests'; end if;
  if (select count(*) from appointments where created_at>now()-interval '1 hour')>=100 then raise exception 'busy, try later'; end if;
  if p_slot is not null then
    if p_slot < now() or not slot_ok(p_doctor,p_slot) then raise exception 'slot not available'; end if;
    dd := (p_slot at time zone 'Asia/Kathmandu')::date;
  end if;
  insert into appointments(name,phone,doctor_id,preferred_date,reason,consent_sms,consent_at,slot_at,source)
  values(left(trim(p_name),80),ph,p_doctor,dd,left(coalesce(p_reason,''),200),coalesce(p_sms,false),now(),p_slot,'online');
end $$;
grant execute on function request_appointment(text,text,text,date,text,boolean,boolean,timestamptz) to anon, authenticated;

-- ---------- reception: confirm / reschedule / book / cancel / no-show ----------
create or replace function confirm_appointment(p_id bigint, p_slot timestamptz default null) returns json language plpgsql security definer set search_path=public as $$
declare a appointments; s timestamptz;
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  select * into a from appointments where id=p_id for update;
  if not found or a.status not in ('requested','confirmed') then raise exception 'this appointment can no longer be confirmed'; end if;
  s := coalesce(p_slot, a.slot_at);
  if s is null then raise exception 'choose a time slot first'; end if;
  if s < now() - interval '30 minutes' then raise exception 'that time has already passed'; end if;
  if not slot_ok(a.doctor_id, s) then raise exception 'that time is outside the doctor''s schedule'; end if;
  begin
    update appointments set status='confirmed', slot_at=s, preferred_date=(s at time zone 'Asia/Kathmandu')::date,
           confirmed_at=now(), confirmed_by=auth.uid(), cancel_reason=null where id=p_id;
  exception when unique_violation then raise exception 'that time is already booked: pick another slot';
  end;
  perform audit_write(auth.uid(),case when a.status='confirmed' then 'APPT_RESCHEDULE' else 'APPT_CONFIRM' end,'appointments',p_id::text,'{}'::jsonb);
  return json_build_object('slot_at',s);
end $$;
revoke all on function confirm_appointment(bigint,timestamptz) from public, anon; grant execute on function confirm_appointment(bigint,timestamptz) to authenticated;

create or replace function reschedule_appointment(p_id bigint, p_slot timestamptz) returns json language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  if p_slot is null then raise exception 'choose a time slot first'; end if;
  if not exists(select 1 from appointments where id=p_id and status='confirmed') then raise exception 'only a confirmed appointment can be rescheduled'; end if;
  return confirm_appointment(p_id, p_slot);
end $$;
revoke all on function reschedule_appointment(bigint,timestamptz) from public, anon; grant execute on function reschedule_appointment(bigint,timestamptz) to authenticated;

create or replace function book_appointment(p_name text, p_phone text, p_doctor text, p_slot timestamptz, p_reason text, p_sms boolean default false) returns json
language plpgsql security definer set search_path=public as $$
declare ph text := left(trim(coalesce(p_phone,'')),20); new_id bigint;
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(norm_phone(ph))<7 then raise exception 'name and phone required'; end if;
  if not exists(select 1 from doctors where id=p_doctor and active) then raise exception 'unknown doctor'; end if;
  if p_slot is null or p_slot < now() - interval '30 minutes' or not slot_ok(p_doctor,p_slot) then raise exception 'slot not available'; end if;
  begin
    insert into appointments(name,phone,doctor_id,preferred_date,reason,consent_sms,consent_at,slot_at,source,status,confirmed_at,confirmed_by)
    values(left(trim(p_name),80),ph,p_doctor,(p_slot at time zone 'Asia/Kathmandu')::date,left(coalesce(p_reason,''),200),coalesce(p_sms,false),
           case when p_sms then now() end,p_slot,'reception','confirmed',now(),auth.uid()) returning appointments.id into new_id;
  exception when unique_violation then raise exception 'that time is already booked: pick another slot';
  end;
  perform audit_write(auth.uid(),'APPT_BOOK','appointments',new_id::text,'{}'::jsonb);
  return json_build_object('id',new_id);
end $$;
revoke all on function book_appointment(text,text,text,timestamptz,text,boolean) from public, anon; grant execute on function book_appointment(text,text,text,timestamptz,text,boolean) to authenticated;

create or replace function cancel_appointment(p_id bigint, p_reason text default null) returns void language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  update appointments set status='cancelled', cancel_reason=left(nullif(trim(coalesce(p_reason,'')),''),200) where id=p_id and status in ('requested','confirmed');
  if not found then raise exception 'this appointment cannot be cancelled'; end if;
  perform audit_write(auth.uid(),'APPT_CANCEL','appointments',p_id::text,'{}'::jsonb);
end $$;
revoke all on function cancel_appointment(bigint,text) from public, anon; grant execute on function cancel_appointment(bigint,text) to authenticated;

create or replace function mark_no_show(p_id bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  update appointments set status='no_show', no_show_at=now() where id=p_id and status='confirmed' and slot_at < now();
  if not found then raise exception 'only a confirmed appointment whose time has passed can be marked no-show'; end if;
  perform audit_write(auth.uid(),'APPT_NO_SHOW','appointments',p_id::text,'{}'::jsonb);
end $$;
revoke all on function mark_no_show(bigint) from public, anon; grant execute on function mark_no_show(bigint) to authenticated;

-- ---------- board for reception ----------
create or replace function appointments_board(p_from date default null, p_to date default null) returns json language plpgsql stable security definer set search_path=public as $$
declare t date := (now() at time zone 'Asia/Kathmandu')::date; f date := coalesce(p_from,t); e date := coalesce(p_to,t+14);
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  return coalesce((select json_agg(x order by x.slot_at nulls last, x.id) from (
    select a.id,a.name,a.phone,a.doctor_id,d.name as doctor,a.slot_at,a.preferred_date,a.status,a.reason,a.consent_sms,a.source,a.cancel_reason,
      (select count(*) from appointments b where b.status='no_show' and norm_phone(b.phone)=norm_phone(a.phone) and b.created_at>now()-interval '180 days') as prior_no_shows,
      (select o.status from outbox o where o.appointment_id=a.id order by o.id desc limit 1) as sms
    from appointments a join doctors d on d.id=a.doctor_id
    where a.status='requested' or (coalesce((a.slot_at at time zone 'Asia/Kathmandu')::date, a.preferred_date) between f and e and a.status in ('confirmed','converted','no_show','cancelled'))
    limit 300) x),'[]'::json);
end $$;
revoke all on function appointments_board(date,date) from public, anon; grant execute on function appointments_board(date,date) to authenticated;

-- ---------- appointment messages ----------
create or replace function trg_appt_msg() returns trigger language plpgsql security definer set search_path=public as $$
declare stamp text; k text;
begin
  stamp := to_char(new.slot_at at time zone 'Asia/Kathmandu','YYYYMMDDHH24MI');
  if tg_op='INSERT' then
    if new.status='requested' then perform enqueue_appt_msg(new,'appt_received',tpl('appt_received',appt_vars(new)));
    elsif new.status='confirmed' then perform enqueue_appt_msg(new,'appt_confirmed '||stamp,tpl('appt_confirmed',appt_vars(new))); end if;
  elsif new.status='confirmed' and (old.status is distinct from 'confirmed' or new.slot_at is distinct from old.slot_at) then
    k := case when old.status='confirmed' then 'appt_changed' else 'appt_confirmed' end;
    perform enqueue_appt_msg(new,k||' '||stamp,tpl(k,appt_vars(new)));
  elsif new.status='cancelled' and old.status='confirmed' then
    perform enqueue_appt_msg(new,'appt_cancelled',tpl('appt_cancelled',appt_vars(new)));
  end if;
  return new;
end $$;
drop trigger if exists appt_msg_ins on appointments; create trigger appt_msg_ins after insert on appointments for each row execute function trg_appt_msg();
drop trigger if exists appt_msg_upd on appointments; create trigger appt_msg_upd after update of status, slot_at on appointments for each row execute function trg_appt_msg();

-- day-before reminders (called by queue_all_reminders from v14)
create or replace function queue_appt_reminders() returns int language plpgsql security definer set search_path=public as $$
declare tm date := (now() at time zone 'Asia/Kathmandu')::date + 1; a appointments; n int := 0; k text;
begin
  for a in select * from appointments where status='confirmed' and consent_sms and (slot_at at time zone 'Asia/Kathmandu')::date = tm loop
    k := 'appt_reminder '||to_char(a.slot_at at time zone 'Asia/Kathmandu','YYYYMMDDHH24MI');
    if not exists(select 1 from outbox where appointment_id=a.id and kind=k) then
      perform enqueue_appt_msg(a,k,tpl('appt_reminder',appt_vars(a))); n := n+1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function queue_appt_reminders() from public, anon, authenticated;
