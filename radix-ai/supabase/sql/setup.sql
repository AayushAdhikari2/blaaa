-- =====================================================================
-- RADIX AI / CAREPULSE: COMPLETE SETUP (ONE FILE)
-- Base project (schema + v3..v11 safety fixes)
--   + patient master record, queue board, triage, notifications,
--     clinical notes, appointments, X-ray module.
-- Paste ALL of this in Supabase > SQL Editor > Run. Safe to re-run.
-- Order inside this file: base -> patients -> queue -> token -> notify -> clinical -> appointments -> triage -> X-ray.
-- Merge notes:
--   * Base v11 (token counters, allergy terms, short bill numbers "BL-0012") is kept as the token + bill logic.
--   * The patient-step v13 token counter is NOT applied (base v11 already fixes the race); register_visit below
--     combines patient linking + base short bill numbers + next_token().
-- =====================================================================

-- >>>>>>>>>> BASE: setup.sql (schema.sql + v3..v11)
-- RADIX AI — ONE-FILE SETUP (steps 1-10 + v11 safety fixes). Paste all of this in Supabase > SQL Editor > Run.
-- = schema.sql + schema_v3..v11.sql in order. Safe to re-run.

-- >>>>>>>>>> schema.sql
-- RADIX AI v2 — run this whole file once in Supabase > SQL Editor

create table if not exists doctors(
  id text primary key, name text not null, dept text not null, avg_min int not null default 10);
insert into doctors values
  ('d1','Dr. Sharma','General Medicine',8),
  ('d2','Dr. Thapa','Cardiology',12),
  ('d3','Dr. Gurung','Pediatrics',10)
on conflict (id) do nothing;

create sequence if not exists bill_seq;

create table if not exists visits(
  id bigint generated always as identity primary key,
  bill text unique not null,
  code text not null,
  name text not null,
  phone text not null,
  age int,
  reason text,
  doctor_id text not null references doctors(id),
  visit_date date not null default (now() at time zone 'Asia/Kathmandu')::date,
  token int not null,
  status text not null default 'waiting'
    check (status in ('waiting','in_room','report_pending','review','done')),
  q_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  test_name text,
  test_due timestamptz
);
create index if not exists visits_day_idx on visits(doctor_id, visit_date, status);

alter table doctors enable row level security;
alter table visits enable row level security;
drop policy if exists "doctors read" on doctors;
create policy "doctors read" on doctors for select to anon, authenticated using (true);
drop policy if exists "staff all" on visits;
create policy "staff all" on visits for all to authenticated using (true) with check (true);
-- anon (patients) get NO direct access to visits; they use patient_status() below.

-- Reception: create visit with bill no, code and token
create or replace function register_visit(p_name text,p_phone text,p_age int,p_reason text,p_doctor text)
returns visits language plpgsql as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits;
begin
  insert into visits(bill,code,name,phone,age,reason,doctor_id,visit_date,token)
  values('BL-'||to_char(d,'YYYYMMDD')||'-'||lpad(nextval('bill_seq')::text,4,'0'),
         lpad(floor(100000+random()*900000)::int::text,6,'0'),
         p_name,p_phone,p_age,p_reason,p_doctor,d,
         (select count(*)+1 from visits where doctor_id=p_doctor and visit_date=d))
  returning * into v;
  return v;
end $$;
grant usage on sequence bill_seq to authenticated;
grant execute on function register_visit(text,text,int,text,text) to authenticated;

-- Patient portal: bill no + code -> that one visit's status only
create or replace function patient_status(p_bill text,p_code text)
returns json language plpgsql security definer set search_path=public as $$
declare v visits; d doctors; pos int; q int; r int;
begin
  select * into v from visits where bill=upper(trim(p_bill)) and code=trim(p_code);
  if not found then return null; end if;
  select * into d from doctors where id=v.doctor_id;
  select count(*) into q from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review');
  select count(*)+1 into pos from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review') and q_at<v.q_at;
  select count(*) into r from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status='in_room';
  return json_build_object('bill',v.bill,'name',v.name,'doctor',d.name,'dept',d.dept,'token',v.token,
    'status',v.status,'test_name',v.test_name,'test_due',v.test_due,
    'pos',case when v.status in('waiting','review') then pos end,
    'in_room',r,'queue_len',q,'avg_min',d.avg_min);
end $$;
grant execute on function patient_status(text,text) to anon, authenticated;

-- >>>>>>>>>> schema_v3.sql
-- RADIX AI v3 — run AFTER schema.sql from v2. Safe to run once.

-- ---------- roles ----------
create table if not exists profiles(
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null check (role in ('reception','doctor','lab','admin')),
  doctor_id text references doctors(id));
alter table profiles enable row level security;

create or replace function my_role() returns text language sql stable security definer set search_path=public as
$$ select role from profiles where id=auth.uid() $$;
create or replace function my_doctor() returns text language sql stable security definer set search_path=public as
$$ select doctor_id from profiles where id=auth.uid() $$;

drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select to authenticated using (id=auth.uid() or my_role()='admin');
drop policy if exists "admin profiles" on profiles;
create policy "admin profiles" on profiles for all to authenticated using (my_role()='admin') with check (my_role()='admin');
drop policy if exists "admin doctors" on doctors;
create policy "admin doctors" on doctors for all to authenticated using (my_role()='admin') with check (my_role()='admin');

-- ---------- new columns / tables ----------
alter table visits add column if not exists report_path text;
alter table visits add column if not exists paid_at timestamptz;

create table if not exists bill_items(
  id bigint generated always as identity primary key,
  visit_id bigint not null references visits(id) on delete cascade,
  description text not null,
  amount numeric(10,2) not null check (amount>=0),
  created_at timestamptz not null default now());
alter table bill_items enable row level security;
drop policy if exists "billing staff" on bill_items;
create policy "billing staff" on bill_items for all to authenticated
  using (my_role() in ('reception','admin')) with check (my_role() in ('reception','admin'));

create table if not exists appointments(
  id bigint generated always as identity primary key,
  name text not null, phone text not null,
  doctor_id text not null references doctors(id),
  preferred_date date, reason text,
  status text not null default 'requested' check (status in ('requested','converted','cancelled')),
  created_at timestamptz not null default now());
alter table appointments enable row level security;
drop policy if exists "appt staff" on appointments;
create policy "appt staff" on appointments for all to authenticated
  using (my_role() in ('reception','admin')) with check (my_role() in ('reception','admin'));

create table if not exists lookup_attempts(bill text not null, at timestamptz not null default now());
alter table lookup_attempts enable row level security;   -- no policies: only patient_status() touches it

-- ---------- visits: per-role access ----------
drop policy if exists "staff all" on visits;
drop policy if exists "visits read" on visits;
create policy "visits read" on visits for select to authenticated
  using (my_role() in ('reception','lab','admin') or (my_role()='doctor' and doctor_id=my_doctor()));
drop policy if exists "visits insert" on visits;
create policy "visits insert" on visits for insert to authenticated with check (my_role() in ('reception','admin'));
drop policy if exists "visits update" on visits;
create policy "visits update" on visits for update to authenticated
  using (my_role() in ('reception','lab','admin') or (my_role()='doctor' and doctor_id=my_doctor()));

-- each role may only change its own columns
create or replace function guard_visit_update() returns trigger language plpgsql as $$
declare r text := my_role();
begin
  if r='admin' then return new; end if;
  if r is null then raise exception 'not allowed'; end if;
  if (new.bill,new.code,new.name,new.phone,new.age,new.reason,new.doctor_id,new.visit_date,new.token)
     is distinct from (old.bill,old.code,old.name,old.phone,old.age,old.reason,old.doctor_id,old.visit_date,old.token)
  then raise exception 'only admin can edit patient details'; end if;
  if r='reception' and (new.status,new.q_at,new.test_name,new.test_due,new.report_path)
     is distinct from (old.status,old.q_at,old.test_name,old.test_due,old.report_path)
  then raise exception 'reception can only change payment'; end if;
  if r='doctor' and (new.paid_at is distinct from old.paid_at) then raise exception 'doctors cannot change payment'; end if;
  if r='lab' and (new.test_name,new.test_due,new.paid_at) is distinct from (old.test_name,old.test_due,old.paid_at)
  then raise exception 'lab can only change status and report'; end if;
  return new;
end $$;
drop trigger if exists visits_guard on visits;
create trigger visits_guard before update on visits for each row execute function guard_visit_update();

-- ---------- report files (private uploads by lab, unguessable folder per report) ----------
insert into storage.buckets(id,name,public) values('reports','reports',true) on conflict (id) do nothing;
drop policy if exists "lab uploads" on storage.objects;
create policy "lab uploads" on storage.objects for insert to authenticated
  with check (bucket_id='reports' and my_role() in ('lab','admin'));

-- ---------- patient-facing functions ----------
create or replace function patient_status(p_bill text,p_code text)
returns json language plpgsql security definer set search_path=public as $$
declare v visits; d doctors; b text := upper(trim(p_bill)); pos int; q int; r int; tot numeric;
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5
    then return json_build_object('locked',true); end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return null; end if;
  select * into d from doctors where id=v.doctor_id;
  select count(*) into q from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review');
  select count(*)+1 into pos from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review') and q_at<v.q_at;
  select count(*) into r from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status='in_room';
  select coalesce(sum(amount),0) into tot from bill_items where visit_id=v.id;
  return json_build_object('bill',v.bill,'name',v.name,'doctor',d.name,'dept',d.dept,'token',v.token,
    'status',v.status,'test_name',v.test_name,'test_due',v.test_due,'report_path',v.report_path,
    'pos',case when v.status in('waiting','review') then pos end,'in_room',r,'queue_len',q,'avg_min',d.avg_min,
    'total',tot,'paid',v.paid_at is not null);
end $$;
grant execute on function patient_status(text,text) to anon, authenticated;

create or replace function request_appointment(p_name text,p_phone text,p_doctor text,p_date date,p_reason text)
returns void language plpgsql security definer set search_path=public as $$
begin
  if length(trim(p_name))<2 or length(trim(p_phone))<6 then raise exception 'name and phone required'; end if;
  insert into appointments(name,phone,doctor_id,preferred_date,reason)
  values(left(trim(p_name),80),left(trim(p_phone),20),p_doctor,p_date,left(coalesce(p_reason,''),200));
end $$;
grant execute on function request_appointment(text,text,text,date,text) to anon, authenticated;

-- >>>>>>>>>> schema_v4.sql
-- RADIX AI v4 (Admin screen) — run AFTER schema.sql + schema_v3.sql (or setup.sql). Safe to re-run.

-- doctors can be hidden instead of deleted (past visits keep pointing at them)
alter table doctors add column if not exists active boolean not null default true;

-- admin-only list of staff with their login email (emails live in auth.users, which the browser cannot read)
create or replace function admin_list_staff()
returns table(id uuid, email text, full_name text, role text, doctor_id text, last_sign_in_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  return query
    select p.id, u.email::text, p.full_name, p.role, p.doctor_id, u.last_sign_in_at
    from profiles p join auth.users u on u.id = p.id
    order by (p.role <> 'admin'), p.role, p.full_name;
end $$;
revoke all on function admin_list_staff() from public, anon;
grant execute on function admin_list_staff() to authenticated;

-- >>>>>>>>>> schema_v5.sql
-- RADIX AI v5 (private reports) — run AFTER v3/v4. Safe to re-run.
-- Makes the reports bucket private, limits size (10 MB) and type (PDF/JPG/PNG/WebP),
-- and lets staff create short-lived signed links. Patients get links from the report-link function.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('reports','reports',false,10485760,array['application/pdf','image/jpeg','image/png','image/webp'])
on conflict (id) do update set public=false, file_size_limit=10485760,
  allowed_mime_types=array['application/pdf','image/jpeg','image/png','image/webp'];

drop policy if exists "staff read reports" on storage.objects;
create policy "staff read reports" on storage.objects for select to authenticated
  using (bucket_id='reports' and my_role() in ('doctor','lab','admin'));

-- >>>>>>>>>> schema_v6.sql
-- ===== v6: patient messages (SMS / WhatsApp) =====
-- Run AFTER setup.sql parts v2-v5. Safe to re-run.
-- Messages are queued by database triggers. The send-messages Edge Function delivers them.
-- A message is only queued if the patient agreed to SMS updates at registration.
-- Messages never contain the access code or the name of a test.

-- ---------- clinic settings (edited in Admin > Settings) ----------
create table if not exists settings(key text primary key, value text not null);
insert into settings(key,value) values
  ('clinic_name','RADIX AI Clinic'),
  ('site_url',''),               -- e.g. https://yourclinic.example/app/  (used for QR codes and SMS links)
  ('ahead_threshold','2'),       -- send "N patients ahead" when N is this or lower
  ('retention_days','1095'),     -- step 9: anonymise visits older than this (check your legal retention rules!)
  ('require_mfa','false')        -- step 9: force two-factor login for all staff
on conflict (key) do nothing;
-- databases created before the rename still carry the old default clinic name
update settings set value='RADIX AI Clinic' where key='clinic_name' and value in ('Carepulse Clinic','Carepulse HMS');
alter table settings enable row level security;
drop policy if exists "settings read" on settings;
create policy "settings read" on settings for select to authenticated using (true);
drop policy if exists "settings admin" on settings;
create policy "settings admin" on settings for all to authenticated using (my_role()='admin') with check (my_role()='admin');

-- ---------- consent + allergies on the visit ----------
alter table visits add column if not exists consent_sms boolean not null default false;
alter table visits add column if not exists consent_version text;
alter table visits add column if not exists consent_at timestamptz;
alter table visits add column if not exists allergies text;
alter table appointments add column if not exists consent_sms boolean not null default false;
alter table appointments add column if not exists consent_at timestamptz;

-- registration now records allergies and consent
drop function if exists register_visit(text,text,int,text,text);
create or replace function register_visit(p_name text,p_phone text,p_age int,p_reason text,p_doctor text,
  p_allergies text default null, p_consent_sms boolean default false, p_consent_version text default null)
returns visits language plpgsql as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits;
begin
  insert into visits(bill,code,name,phone,age,reason,doctor_id,visit_date,token,allergies,consent_sms,consent_version,consent_at)
  values('BL-'||to_char(d,'YYYYMMDD')||'-'||lpad(nextval('bill_seq')::text,4,'0'),
         lpad(floor(100000+random()*900000)::int::text,6,'0'),
         left(trim(p_name),80),left(trim(p_phone),20),p_age,left(p_reason,200),p_doctor,d,
         (select count(*)+1 from visits where doctor_id=p_doctor and visit_date=d),
         nullif(left(trim(coalesce(p_allergies,'')),300),''), coalesce(p_consent_sms,false), p_consent_version,
         case when p_consent_version is not null then now() end)
  returning * into v;
  return v;
end $$;
grant execute on function register_visit(text,text,int,text,text,text,boolean,text) to authenticated;

-- ---------- guard: who may change which columns (replaces the v3 version) ----------
create or replace function guard_visit_update() returns trigger language plpgsql as $$
declare r text := my_role();
begin
  -- database functions that run as the owner (patient withdrawal, retention, pharmacy...) are trusted
  if current_user not in ('authenticated','anon','service_role') then return new; end if;
  if r='admin' then return new; end if;
  if r is null then raise exception 'not allowed'; end if;
  if (new.bill,new.code,new.name,new.phone,new.age,new.reason,new.doctor_id,new.visit_date,new.token,new.consent_version,new.consent_at)
     is distinct from (old.bill,old.code,old.name,old.phone,old.age,old.reason,old.doctor_id,old.visit_date,old.token,old.consent_version,old.consent_at)
  then raise exception 'only admin can edit patient details'; end if;
  if r in ('doctor','lab') and new.consent_sms is distinct from old.consent_sms
  then raise exception 'only reception can change message consent'; end if;
  if r='reception' and (new.status,new.q_at,new.test_name,new.test_due,new.report_path)
     is distinct from (old.status,old.q_at,old.test_name,old.test_due,old.report_path)
  then raise exception 'reception can only change payment'; end if;
  if r='doctor' and (new.paid_at is distinct from old.paid_at) then raise exception 'doctors cannot change payment'; end if;
  if r='lab' and (new.test_name,new.test_due,new.paid_at,new.allergies) is distinct from (old.test_name,old.test_due,old.paid_at,old.allergies)
  then raise exception 'lab can only change status and report'; end if;
  return new;
end $$;

-- ---------- outbox ----------
create table if not exists outbox(
  id bigint generated always as identity primary key,
  visit_id bigint references visits(id) on delete set null,
  kind text not null,
  phone text not null,
  body text not null,
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped')),
  attempts int not null default 0,
  error text,
  provider_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(visit_id, kind));
alter table outbox add column if not exists claimed_at timestamptz;
create index if not exists outbox_queue_idx on outbox(status, id);
alter table outbox enable row level security;
drop policy if exists "outbox admin" on outbox;
create policy "outbox admin" on outbox for all to authenticated using (my_role()='admin') with check (my_role()='admin');
-- the send-messages function uses the service-role key (bypasses RLS)

-- the send-messages function takes a batch with this; two senders can never take the same message
create or replace function claim_outbox(p_limit int default 25) returns setof outbox
language sql security definer set search_path=public as $$
  update outbox set attempts=attempts+1, claimed_at=now()
  where id in (select id from outbox where status='queued' and attempts<3
               and (claimed_at is null or claimed_at<now()-interval '2 minutes')
               order by id limit greatest(1,least(p_limit,100)) for update skip locked)
  returning * $$;
revoke all on function claim_outbox(int) from public, anon, authenticated;
grant execute on function claim_outbox(int) to service_role;

create or replace function clinic() returns text language sql stable security definer set search_path=public as
$$ select coalesce((select value from settings where key='clinic_name'),'RADIX AI') $$;

create or replace function msg_text(k text, v visits, n int default 0) returns text
language plpgsql stable security definer set search_path=public as $$
declare dn text := (select name from doctors where id=v.doctor_id); fn text := split_part(v.name,' ',1);
        site text := coalesce((select nullif(value,'') from settings where key='site_url'),'');
begin
  return case k
    when 'registered' then clinic()||': Hi '||fn||', you are registered with '||dn||'. Token T-'||lpad(v.token::text,2,'0')||', bill '||v.bill||'.'
        ||case when site<>'' then ' Track your turn: '||site else '' end
    when 'ahead' then clinic()||': '||case when n=0 then 'You are next for ' else n||' patient'||case when n=1 then '' else 's' end||' ahead of you for ' end||dn||'. Please be ready.'
    when 'called' then clinic()||': '||fn||', please go to '||dn||' now. Token T-'||lpad(v.token::text,2,'0')||'.'
    when 'report_ready' then clinic()||': '||fn||', your report is ready. Please wait to be called back by '||dn||'.'
    else clinic()||': update for '||v.bill end;
end $$;

create or replace function enqueue_msg(v visits, k text, body text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not v.consent_sms or length(trim(v.phone))<6 then return; end if;
  insert into outbox(visit_id,kind,phone,body) values(v.id,k,v.phone,body) on conflict (visit_id,kind) do nothing;
end $$;

-- "N patients ahead": queue one message per visit the first time it is within the threshold
create or replace function queue_alerts(p_doc text, p_date date) returns void
language plpgsql security definer set search_path=public as $$
declare r record; vv visits; thr int := coalesce((select nullif(value,'')::int from settings where key='ahead_threshold'),2);
        inroom int := (select count(*) from visits where doctor_id=p_doc and visit_date=p_date and status='in_room');
begin
  for r in
    select id, row_number() over (order by q_at, id) - 1 + inroom as ahead
    from visits where doctor_id=p_doc and visit_date=p_date and status in ('waiting','review')
  loop
    if r.ahead <= thr then
      select * into vv from visits where id=r.id;
      perform enqueue_msg(vv, case when vv.status='review' then 'ahead_review' else 'ahead' end, msg_text('ahead', vv, r.ahead::int));
    end if;
  end loop;
end $$;

create or replace function trg_visit_msg_ins() returns trigger language plpgsql security definer set search_path=public as $$
begin perform enqueue_msg(new,'registered',msg_text('registered',new)); return new; end $$;
drop trigger if exists visits_msg_ins on visits;
create trigger visits_msg_ins after insert on visits for each row execute function trg_visit_msg_ins();

create or replace function trg_visit_msg_upd() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status is not distinct from old.status then return new; end if;
  if new.status='in_room' then
    perform enqueue_msg(new, case when old.status='review' then 'called_again' else 'called' end, msg_text('called',new));
  elsif new.status='review' and old.status='report_pending' then
    perform enqueue_msg(new,'report_ready',msg_text('report_ready',new));
  end if;
  perform queue_alerts(new.doctor_id,new.visit_date);
  return new;
end $$;
drop trigger if exists visits_msg_upd on visits;
create trigger visits_msg_upd after update of status on visits for each row execute function trg_visit_msg_upd();

-- Optional: send automatically every minute even if nobody has the app open.
-- Needs the pg_cron and pg_net extensions (Supabase > Database > Extensions). Replace the two values, then run once:
-- select cron.schedule('radix-ai-send', '* * * * *', $$ select net.http_post(
--   url := 'https://YOUR-PROJECT.supabase.co/functions/v1/send-messages',
--   headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR-CRON-SECRET"}'::jsonb, body := '{}'::jsonb) $$);

-- >>>>>>>>>> schema_v7.sql
-- ===== v7: public queue board (TV in the waiting room) =====
-- Shows token numbers only. No names, no phone numbers, no bill numbers. Safe for the public.
create or replace function queue_board() returns json
language sql stable security definer set search_path=public as $$
  with t as (select (now() at time zone 'Asia/Kathmandu')::date as d)
  select json_build_object(
    'clinic', coalesce((select value from settings where key='clinic_name'),'RADIX AI'),
    'at', now(),
    'doctors', coalesce((
      select json_agg(x order by x.name) from (
        select dr.name, dr.dept,
          coalesce((select json_agg(v.token order by v.q_at) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status='in_room'),'[]'::json) as serving,
          coalesce((select json_agg(q.token order by q.q_at) from (
              select v.token, v.q_at from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review')
              order by v.q_at limit 6) q),'[]'::json) as next,
          (select count(*) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review')) as waiting
        from doctors dr where dr.active order by dr.name) x),'[]'::json));
$$;
grant execute on function queue_board() to anon, authenticated;

-- >>>>>>>>>> schema_v8.sql
-- ===== v8: reports and dashboard =====
-- Timestamps for waiting-time and report turnaround, plus admin-only summary and export functions.
alter table visits add column if not exists first_called_at timestamptz;
alter table visits add column if not exists done_at timestamptz;
alter table visits add column if not exists test_ordered_at timestamptz;
alter table visits add column if not exists report_ready_at timestamptz;

create or replace function stamp_visit() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status='in_room' and new.first_called_at is null then new.first_called_at := now(); end if;
    if new.status='done' then new.done_at := now(); end if;
    if new.status='report_pending' then new.test_ordered_at := now(); new.report_ready_at := null; end if;
    if new.status='review' and old.status='report_pending' then new.report_ready_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists visits_stamp on visits;
create trigger visits_stamp before update on visits for each row execute function stamp_visit();

create or replace function report_summary(p_from date, p_to date) returns json
language plpgsql security definer set search_path=public as $$
declare r json;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'choose a date range of up to one year'; end if;
  with vv as (
    select v.*, coalesce((select sum(amount) from bill_items b where b.visit_id=v.id),0) as billed
    from visits v where v.visit_date between p_from and p_to)
  select json_build_object(
    'from',p_from,'to',p_to,
    'totals',(select json_build_object(
        'visits',count(*),'completed',count(*) filter (where status='done'),
        'avg_wait_min',round(avg(extract(epoch from first_called_at-created_at)/60)::numeric,1),
        'avg_consult_min',round((avg(extract(epoch from done_at-first_called_at)/60) filter (where done_at is not null and first_called_at is not null))::numeric,1),
        'avg_report_min',round(avg(extract(epoch from report_ready_at-test_ordered_at)/60)::numeric,1),
        'billed',coalesce(sum(billed),0),
        'collected',coalesce(sum(billed) filter (where paid_at is not null),0),
        'unpaid',coalesce(sum(billed) filter (where paid_at is null),0),
        'unpaid_count',count(*) filter (where paid_at is null and billed>0)) from vv),
    'per_day',(select coalesce(json_agg(json_build_object('day',g.d::date,'visits',coalesce(x.n,0),'collected',coalesce(x.c,0)) order by g.d),'[]'::json)
        from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g(d)
        left join (select visit_date, count(*) n, sum(billed) filter (where paid_at is not null) c from vv group by 1) x on x.visit_date=g.d::date),
    'per_doctor',(select coalesce(json_agg(json_build_object('doctor',d.name,'dept',d.dept,'visits',coalesce(s.n,0),
          'avg_wait_min',s.w,'collected',coalesce(s.c,0)) order by coalesce(s.n,0) desc, d.name),'[]'::json)
        from doctors d left join (select doctor_id, count(*) n,
            round(avg(extract(epoch from first_called_at-created_at)/60)::numeric,1) w,
            sum(billed) filter (where paid_at is not null) c from vv group by 1) s on s.doctor_id=d.id),
    'unpaid',(select coalesce(json_agg(u order by u.visit_date),'[]'::json) from (
        select bill,name,phone,visit_date,billed from vv where paid_at is null and billed>0 order by visit_date limit 100) u)
  ) into r;
  return r;
end $$;
revoke all on function report_summary(date,date) from public, anon;
grant execute on function report_summary(date,date) to authenticated;

-- one row per visit for CSV (no access codes; names and phones only when asked for)
create or replace function report_rows(p_from date, p_to date, p_pii boolean default false)
returns table(visit_date date, bill text, doctor text, dept text, status text, token int, wait_min numeric,
              consult_min numeric, report_min numeric, billed numeric, paid boolean, patient text, phone text)
language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'choose a date range of up to one year'; end if;
  return query
    select v.visit_date, v.bill, d.name, d.dept, v.status, v.token,
      round((extract(epoch from v.first_called_at-v.created_at)/60)::numeric,1),
      round((extract(epoch from v.done_at-v.first_called_at)/60)::numeric,1),
      round((extract(epoch from v.report_ready_at-v.test_ordered_at)/60)::numeric,1),
      coalesce((select sum(amount) from bill_items b where b.visit_id=v.id),0), v.paid_at is not null,
      case when p_pii then v.name end, case when p_pii then v.phone end
    from visits v join doctors d on d.id=v.doctor_id
    where v.visit_date between p_from and p_to order by v.visit_date, v.bill;
end $$;
revoke all on function report_rows(date,date,boolean) from public, anon;
grant execute on function report_rows(date,date,boolean) to authenticated;

-- >>>>>>>>>> schema_v9.sql
-- ===== v9: security and privacy =====
-- Run after v6-v8. Safe to re-run.

-- ---------- two-factor gate ----------
-- When Admin > Settings > "Require two-factor" is on, a staff session only gets its role once it has passed the
-- authenticator-app check (JWT level aal2). Until then every role-protected table and function refuses.
create or replace function mfa_ok() returns boolean language sql stable security definer set search_path=public as $$
  select coalesce((select value from settings where key='require_mfa'),'false') <> 'true'
      or coalesce(auth.jwt()->>'aal','') = 'aal2' $$;
create or replace function my_role() returns text language sql stable security definer set search_path=public as
$$ select role from profiles where id=auth.uid() and mfa_ok() $$;
create or replace function my_doctor() returns text language sql stable security definer set search_path=public as
$$ select doctor_id from profiles where id=auth.uid() and mfa_ok() $$;

-- ---------- tamper-evident audit log ----------
-- Append-only. Each row stores the hash of the row before it, so editing or deleting history breaks the chain.
-- Personal data (names, phones, reasons, allergies...) is never written here, only which field changed.
create table if not exists audit_log(
  seq bigint unique,
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid, actor_role text,
  action text not null, table_name text, row_id text, detail jsonb,
  prev_hash text, hash text);

create or replace function audit_hash(prev text, at timestamptz, actor uuid, action text, tbl text, rid text, detail jsonb)
returns text language sql immutable as $$
  select encode(sha256(convert_to(coalesce(prev,'')||'|'||to_char(at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US')||'|'||coalesce(actor::text,'')||'|'
    ||action||'|'||coalesce(tbl,'')||'|'||coalesce(rid,'')||'|'||coalesce(detail::text,''),'UTF8')),'hex') $$;

create or replace function audit_chain() returns trigger language plpgsql as $$
declare last_seq bigint; last_hash text;
begin
  perform pg_advisory_xact_lock(727001);                       -- one writer at a time keeps the chain in order
  select seq, hash into last_seq, last_hash from audit_log order by seq desc limit 1;
  new.seq := coalesce(last_seq,0) + 1;
  new.prev_hash := coalesce(last_hash,'genesis');
  new.hash := audit_hash(new.prev_hash, new.at, new.actor, new.action, new.table_name, new.row_id, new.detail);
  return new;
end $$;
drop trigger if exists audit_log_chain on audit_log;
create trigger audit_log_chain before insert on audit_log for each row execute function audit_chain();

create or replace function audit_block() returns trigger language plpgsql as $$
begin raise exception 'the audit log is append-only'; end $$;
drop trigger if exists audit_log_noedit on audit_log;
create trigger audit_log_noedit before update or delete on audit_log for each row execute function audit_block();
drop trigger if exists audit_log_notrunc on audit_log;
create trigger audit_log_notrunc before truncate on audit_log for each statement execute function audit_block();

alter table audit_log enable row level security;
drop policy if exists "admin reads audit" on audit_log;
create policy "admin reads audit" on audit_log for select to authenticated using (my_role()='admin');
revoke update, delete, truncate on audit_log from anon, authenticated;

create or replace function audit_write(p_actor uuid, p_action text, p_table text, p_row text, p_detail jsonb) returns void
language plpgsql security definer set search_path=public as $$
declare rl text;
begin
  select role into rl from profiles where id=p_actor;
  insert into audit_log(actor,actor_role,action,table_name,row_id,detail)
  values (p_actor, coalesce(rl, case when p_actor is null then 'system' end), p_action, p_table, p_row, p_detail);
end $$;
revoke all on function audit_write(uuid,text,text,text,jsonb) from public, anon, authenticated;

-- for Edge Functions (service role) to record events such as "report link issued"
create or replace function audit_event(p_actor uuid, p_action text, p_row text, p_detail jsonb default '{}') returns void
language sql security definer set search_path=public as $$ select audit_write(p_actor, p_action, 'event', p_row, p_detail) $$;
revoke all on function audit_event(uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function audit_event(uuid,text,text,jsonb) to service_role;

-- generic row trigger: records who changed which row and which fields (values of personal fields are hidden)
create or replace function audit_row() returns trigger language plpgsql security definer set search_path=public as $$
declare o jsonb; n jsonb; d jsonb; rid text;
  sens text[] := '{}';
begin
  -- personal data is hidden only on tables that hold patient information (drug, doctor and settings names are useful to keep)
  if TG_TABLE_NAME in ('visits','appointments','privacy_requests','prescriptions','admissions','claims') then
    sens := array['code','name','phone','reason','allergies','age','details','policy_no','response','note','ack_reason','admit_note','discharge_summary'];
  end if;
  if TG_OP='DELETE' then
    o := to_jsonb(old); rid := coalesce(o->>'id', o->>'key');
    d := (select coalesce(jsonb_object_agg(key, case when key=any(sens) then '"***"'::jsonb else value end),'{}'::jsonb) from jsonb_each(o));
  elsif TG_OP='INSERT' then
    n := to_jsonb(new); rid := coalesce(n->>'id', n->>'key');
    d := (select coalesce(jsonb_object_agg(key, case when key=any(sens) then '"***"'::jsonb else value end),'{}'::jsonb) from jsonb_each(n));
  else
    n := to_jsonb(new); o := to_jsonb(old); rid := coalesce(n->>'id', n->>'key');
    d := (select coalesce(jsonb_object_agg(a.key, jsonb_build_object(
            'old', case when a.key=any(sens) then '"***"'::jsonb else b.value end,
            'new', case when a.key=any(sens) then '"***"'::jsonb else a.value end)),'{}'::jsonb)
          from jsonb_each(n) a join jsonb_each(o) b using (key) where a.value is distinct from b.value);
    if d = '{}'::jsonb then return null; end if;
  end if;
  perform audit_write(auth.uid(), TG_OP, TG_TABLE_NAME, rid, d);
  return null;
end $$;

create or replace function attach_audit(t regclass) returns void language plpgsql as $$
declare nm text := 'audit_' || replace(t::text,'.','_');
begin
  execute format('drop trigger if exists %I on %s', nm, t);
  execute format('create trigger %I after insert or update or delete on %s for each row execute function audit_row()', nm, t);
end $$;

select attach_audit('visits'), attach_audit('bill_items'), attach_audit('appointments'), attach_audit('profiles'),
       attach_audit('doctors'), attach_audit('settings');

create or replace function audit_verify() returns json language plpgsql security definer set search_path=public as $$
declare r record; prev text := 'genesis'; n int := 0;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  for r in select * from audit_log order by seq loop
    n := n + 1;
    if r.prev_hash is distinct from prev or r.hash is distinct from audit_hash(prev, r.at, r.actor, r.action, r.table_name, r.row_id, r.detail) then
      return json_build_object('ok',false,'checked',n,'bad_seq',r.seq);
    end if;
    prev := r.hash;
  end loop;
  return json_build_object('ok',true,'checked',n,'head',prev);
end $$;
revoke all on function audit_verify() from public, anon;
grant execute on function audit_verify() to authenticated;

-- staff opening a report file
create or replace function log_report_open(p_visit bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('doctor','lab','admin') then raise exception 'not allowed'; end if;
  perform audit_write(auth.uid(),'REPORT_OPEN','visits',p_visit::text,'{}'::jsonb);
end $$;
revoke all on function log_report_open(bigint) from public, anon;
grant execute on function log_report_open(bigint) to authenticated;

-- ---------- CSV export is audited (replaces the v8 version) ----------
create or replace function report_rows(p_from date, p_to date, p_pii boolean default false)
returns table(visit_date date, bill text, doctor text, dept text, status text, token int, wait_min numeric,
              consult_min numeric, report_min numeric, billed numeric, paid boolean, patient text, phone text)
language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'choose a date range of up to one year'; end if;
  perform audit_write(auth.uid(),'EXPORT','visits',null,jsonb_build_object('from',p_from,'to',p_to,'with_names',coalesce(p_pii,false)));
  return query
    select v.visit_date, v.bill, d.name, d.dept, v.status, v.token,
      round((extract(epoch from v.first_called_at-v.created_at)/60)::numeric,1),
      round((extract(epoch from v.done_at-v.first_called_at)/60)::numeric,1),
      round((extract(epoch from v.report_ready_at-v.test_ordered_at)/60)::numeric,1),
      coalesce((select sum(amount) from bill_items b where b.visit_id=v.id),0), v.paid_at is not null,
      case when p_pii then v.name end, case when p_pii then v.phone end
    from visits v join doctors d on d.id=v.doctor_id
    where v.visit_date between p_from and p_to order by v.visit_date, v.bill;
end $$;

-- ---------- public booking: consent required + rate limits ----------
drop function if exists request_appointment(text,text,text,date,text);
create or replace function request_appointment(p_name text,p_phone text,p_doctor text,p_date date,p_reason text,
  p_consent boolean default false, p_sms boolean default false)
returns void language plpgsql security definer set search_path=public as $$
declare ph text := left(trim(coalesce(p_phone,'')),20);
begin
  if not coalesce(p_consent,false) then raise exception 'consent required'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(ph)<6 then raise exception 'name and phone required'; end if;
  if not exists(select 1 from doctors where id=p_doctor and active) then raise exception 'unknown doctor'; end if;
  if (select count(*) from appointments where phone=ph and created_at>now()-interval '1 hour')>=3 then raise exception 'too many requests'; end if;
  if (select count(*) from appointments where created_at>now()-interval '1 hour')>=100 then raise exception 'busy, try later'; end if;
  insert into appointments(name,phone,doctor_id,preferred_date,reason,consent_sms,consent_at)
  values(left(trim(p_name),80),ph,p_doctor,p_date,left(coalesce(p_reason,''),200),coalesce(p_sms,false),now());
end $$;
grant execute on function request_appointment(text,text,text,date,text,boolean,boolean) to anon, authenticated;

-- ---------- patient rights: stop messages, ask for access / correction / erasure ----------
create or replace function patient_withdraw_sms(p_bill text, p_code text) returns boolean
language plpgsql security definer set search_path=public as $$
declare v visits; b text := upper(trim(p_bill));
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5 then return false; end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return false; end if;
  update visits set consent_sms=false where id=v.id;
  update outbox set status='skipped', error='consent withdrawn' where visit_id=v.id and status='queued';
  perform audit_write(null,'CONSENT_WITHDRAWN','visits',v.id::text,'{"channel":"sms"}'::jsonb);
  return true;
end $$;
grant execute on function patient_withdraw_sms(text,text) to anon, authenticated;

create table if not exists privacy_requests(
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('access','correction','erasure','withdraw_consent','question')),
  bill text, name text not null, phone text not null, details text,
  status text not null default 'open' check (status in ('open','in_progress','done','rejected')),
  response text, handled_by uuid,
  created_at timestamptz not null default now(),
  due_at timestamptz not null default now() + interval '30 days',
  closed_at timestamptz);
alter table privacy_requests enable row level security;
drop policy if exists "privacy staff" on privacy_requests;
create policy "privacy staff" on privacy_requests for all to authenticated
  using (my_role() in ('admin','reception')) with check (my_role() in ('admin','reception'));
select attach_audit('privacy_requests');

create or replace function submit_privacy_request(p_kind text,p_name text,p_phone text,p_bill text,p_details text) returns void
language plpgsql security definer set search_path=public as $$
declare ph text := left(trim(coalesce(p_phone,'')),20);
begin
  if p_kind not in ('access','correction','erasure','withdraw_consent','question') then raise exception 'unknown request type'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(ph)<6 then raise exception 'name and phone required'; end if;
  if (select count(*) from privacy_requests where phone=ph and created_at>now()-interval '1 day')>=3 then raise exception 'too many requests'; end if;
  insert into privacy_requests(kind,name,phone,bill,details)
  values(p_kind,left(trim(p_name),80),ph,nullif(left(upper(trim(coalesce(p_bill,''))),30),''),left(coalesce(p_details,''),1000));
end $$;
grant execute on function submit_privacy_request(text,text,text,text,text) to anon, authenticated;

-- ---------- data retention ----------
-- Visits older than the retention period (Admin > Settings) are anonymised: name, phone, reason, allergies, age,
-- access code and report file are removed. Billing amounts and counts stay for your reports. The audit log is kept.
create table if not exists retention_queue(path text primary key, queued_at timestamptz not null default now());
alter table retention_queue enable row level security;
drop policy if exists "retention admin" on retention_queue;
create policy "retention admin" on retention_queue for all to authenticated using (my_role()='admin') with check (my_role()='admin');

drop policy if exists "admin delete reports" on storage.objects;
create policy "admin delete reports" on storage.objects for delete to authenticated
  using (bucket_id='reports' and my_role()='admin');

create or replace function retention_days() returns int language sql stable security definer set search_path=public as
$$ select coalesce((select nullif(value,'')::int from settings where key='retention_days'),1095) $$;

create or replace function retention_preview() returns json language plpgsql security definer set search_path=public as $$
declare cutoff date := (now() at time zone 'Asia/Kathmandu')::date - retention_days();
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  return json_build_object('days',retention_days(),'cutoff',cutoff,
    'visits',(select count(*) from visits where visit_date<cutoff and name<>'[removed]'),
    'files',(select count(*) from visits where visit_date<cutoff and name<>'[removed]' and report_path is not null),
    'pending_files',(select count(*) from retention_queue),
    'appointments',(select count(*) from appointments where created_at<now()-interval '90 days'),
    'messages',(select count(*) from outbox where created_at<now()-interval '90 days'));
end $$;

create or replace function retention_run() returns json language plpgsql security definer set search_path=public as $$
declare cutoff date := (now() at time zone 'Asia/Kathmandu')::date - retention_days(); nv int; na int; nm int; nf int;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if retention_days() < 90 then raise exception 'retention period must be at least 90 days'; end if;
  insert into retention_queue(path) select report_path from visits where visit_date<cutoff and name<>'[removed]' and report_path is not null on conflict do nothing;
  get diagnostics nf = row_count;
  update visits set name='[removed]', phone='', reason=null, allergies=null, age=null, report_path=null, consent_sms=false,
         code='x'||md5(random()::text||id::text)
   where visit_date<cutoff and name<>'[removed]';
  get diagnostics nv = row_count;
  delete from appointments where created_at<now()-interval '90 days'; get diagnostics na = row_count;
  delete from outbox where created_at<now()-interval '90 days'; get diagnostics nm = row_count;
  delete from lookup_attempts where at<now()-interval '2 days';
  perform audit_write(auth.uid(),'RETENTION_RUN','visits',null,jsonb_build_object('cutoff',cutoff,'visits',nv,'files',nf,'appointments',na,'messages',nm));
  return json_build_object('visits',nv,'files_queued',nf,'appointments',na,'messages',nm);
end $$;

create or replace function retention_pending_files() returns text[] language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  return coalesce((select array_agg(path) from (select path from retention_queue order by queued_at limit 100) q),'{}');
end $$;
create or replace function retention_files_done(p_paths text[]) returns void language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  delete from retention_queue where path = any(p_paths);
end $$;
revoke all on function retention_preview(), retention_run(), retention_pending_files(), retention_files_done(text[]) from public, anon;
grant execute on function retention_preview(), retention_run(), retention_pending_files(), retention_files_done(text[]) to authenticated;

-- >>>>>>>>>> schema_v10.sql
-- ===== v10: pilot kit + first modules (pharmacy, wards/beds, insurance claims, staff feedback) =====
-- Run after v9 (needs attach_audit). Safe to re-run.
-- The sample drugs, interactions and prices at the bottom are PLACEHOLDERS: a pharmacist must review them before real use.

-- new login role
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check check (role in ('reception','doctor','lab','pharmacy','admin'));

-- =====================================================================
-- PHARMACY: drugs, stock with expiry (first-expiry-first-out), prescriptions, allergy + interaction checks
-- =====================================================================
create table if not exists drugs(
  id bigint generated always as identity primary key,
  name text not null, generic text not null, drug_class text, strength text, form text,
  rx_class text not null default 'OTC' check (rx_class in ('OTC','Rx','Controlled')),
  unit_price numeric(10,2) not null default 0 check (unit_price>=0),
  active boolean not null default true,
  unique(name, strength));
create table if not exists drug_stock(
  id bigint generated always as identity primary key,
  drug_id bigint not null references drugs(id) on delete cascade,
  batch text not null, expiry date not null, qty int not null check (qty>=0),
  created_at timestamptz not null default now(),
  unique(drug_id, batch));
create table if not exists drug_interactions(
  generic_a text not null, generic_b text not null,
  severity text not null check (severity in ('minor','moderate','major')), note text,
  primary key (generic_a, generic_b), check (generic_a < generic_b));   -- names in lower case, a before b
create table if not exists prescriptions(
  id bigint generated always as identity primary key,
  visit_id bigint not null references visits(id) on delete cascade,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','dispensed','cancelled')),
  note text, ack_reason text, dispensed_at timestamptz, dispensed_by uuid);
create table if not exists prescription_items(
  id bigint generated always as identity primary key,
  rx_id bigint not null references prescriptions(id) on delete cascade,
  drug_id bigint not null references drugs(id),
  dose text not null, days int, qty int not null check (qty>0));
create index if not exists rx_visit_idx on prescriptions(visit_id);

alter table drugs enable row level security; alter table drug_stock enable row level security;
alter table drug_interactions enable row level security; alter table prescriptions enable row level security;
alter table prescription_items enable row level security;

drop policy if exists "drugs read" on drugs;           create policy "drugs read" on drugs for select to authenticated using (true);
drop policy if exists "drugs write" on drugs;          create policy "drugs write" on drugs for all to authenticated
  using (my_role() in ('pharmacy','admin')) with check (my_role() in ('pharmacy','admin'));
drop policy if exists "stock read" on drug_stock;      create policy "stock read" on drug_stock for select to authenticated
  using (my_role() in ('pharmacy','admin','doctor'));
drop policy if exists "stock write" on drug_stock;     create policy "stock write" on drug_stock for update to authenticated
  using (my_role() in ('pharmacy','admin')) with check (my_role() in ('pharmacy','admin'));
drop policy if exists "interactions read" on drug_interactions; create policy "interactions read" on drug_interactions for select to authenticated using (true);
drop policy if exists "interactions write" on drug_interactions; create policy "interactions write" on drug_interactions for all to authenticated
  using (my_role()='admin') with check (my_role()='admin');
-- a doctor only sees prescriptions of visits they can already see (visits has its own policy)
drop policy if exists "rx read" on prescriptions;      create policy "rx read" on prescriptions for select to authenticated
  using (my_role() in ('pharmacy','admin') or (my_role()='doctor' and exists(select 1 from visits v where v.id=visit_id)));
drop policy if exists "rxi read" on prescription_items; create policy "rxi read" on prescription_items for select to authenticated
  using (my_role() in ('pharmacy','admin') or (my_role()='doctor' and exists(select 1 from prescriptions p where p.id=rx_id)));
-- prescriptions are created and dispensed only through the functions below

-- allergy + interaction check shared by prescribing and dispensing
create or replace function rx_check(p_visit bigint, p_drugs bigint[]) returns json
language plpgsql stable security definer set search_path=public as $$
declare al text[]; ra jsonb; ri jsonb;
begin
  if my_role() not in ('doctor','pharmacy','admin') then raise exception 'not allowed'; end if;
  select coalesce(array_agg(lower(trim(x))) filter (where length(trim(x))>=3),'{}') into al
    from visits v, unnest(regexp_split_to_array(coalesce(v.allergies,''), '[,;\n]+')) x where v.id=p_visit;
  select coalesce(jsonb_agg(distinct jsonb_build_object('drug',d.name,'allergen',a)),'[]'::jsonb) into ra
    from drugs d, unnest(al) a
   where d.id = any(p_drugs) and (
         lower(d.name) like '%'||a||'%' or lower(d.generic) like '%'||a||'%' or lower(coalesce(d.drug_class,'')) like '%'||a||'%'
      or (length(d.generic)>=4 and a like '%'||lower(d.generic)||'%')
      or (length(coalesce(d.drug_class,''))>=4 and a like '%'||lower(d.drug_class)||'%'));
  select coalesce(jsonb_agg(jsonb_build_object('a',x.generic_a,'b',x.generic_b,'severity',x.severity,'note',x.note)),'[]'::jsonb) into ri
    from drug_interactions x
   where exists(select 1 from drugs d1 where d1.id=any(p_drugs) and lower(d1.generic)=x.generic_a)
     and exists(select 1 from drugs d2 where d2.id=any(p_drugs) and lower(d2.generic)=x.generic_b);
  return json_build_object('allergy',ra,'interactions',ri);
end $$;
revoke all on function rx_check(bigint,bigint[]) from public, anon;
grant execute on function rx_check(bigint,bigint[]) to authenticated;

create or replace function check_text(c json) returns text language sql immutable as $$
  select coalesce((select string_agg('Allergy: '||(e->>'drug')||' (patient allergic to '||(e->>'allergen')||')', '; ') from json_array_elements(c->'allergy') e),'');
$$;

-- doctor: p_items = [{"drug_id":1,"dose":"1 tab 3x daily","days":5,"qty":15}, ...]
create or replace function create_rx(p_visit bigint, p_items jsonb, p_note text default null, p_ack text default null) returns json
language plpgsql security definer set search_path=public as $$
declare v visits; c json; rid bigint; it jsonb; ids bigint[]; majors text; n int := jsonb_array_length(coalesce(p_items,'[]'::jsonb));
begin
  if my_role() not in ('doctor','admin') then raise exception 'only doctors can prescribe'; end if;
  select * into v from visits where id=p_visit;
  if not found then raise exception 'visit not found'; end if;
  if my_role()='doctor' and v.doctor_id is distinct from my_doctor() then raise exception 'this is not your patient'; end if;
  if n < 1 or n > 15 then raise exception 'add between 1 and 15 medicines'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if (it->>'drug_id') is null or length(trim(coalesce(it->>'dose','')))=0 or coalesce((it->>'qty')::int,0) < 1 or (it->>'qty')::int > 1000
      then raise exception 'each medicine needs a dose and a quantity (1 to 1000)'; end if;
    if not exists(select 1 from drugs where id=(it->>'drug_id')::bigint and active) then raise exception 'unknown or inactive medicine'; end if;
  end loop;
  select array_agg((x->>'drug_id')::bigint) into ids from jsonb_array_elements(p_items) x;
  c := rx_check(p_visit, ids);
  if json_array_length(c->'allergy') > 0 then
    raise exception 'ALLERGY CONFLICT. % Remove the medicine, or correct the allergy list if it is wrong.', check_text(c); end if;
  select string_agg(initcap(e->>'a')||' + '||initcap(e->>'b')||': '||coalesce(e->>'note','interaction'), '; ') into majors
    from json_array_elements(c->'interactions') e where e->>'severity'='major';
  if majors is not null and length(trim(coalesce(p_ack,'')))=0 then
    raise exception 'MAJOR INTERACTION. % Give a reason to continue, or change the medicines.', majors; end if;
  insert into prescriptions(visit_id,note,ack_reason) values(p_visit, left(p_note,300), nullif(left(trim(coalesce(p_ack,'')),300),'')) returning id into rid;
  insert into prescription_items(rx_id,drug_id,dose,days,qty)
    select rid,(x->>'drug_id')::bigint,left(x->>'dose',80),nullif(x->>'days','')::int,(x->>'qty')::int from jsonb_array_elements(p_items) x;
  return json_build_object('id',rid,'checks',c);
end $$;
revoke all on function create_rx(bigint,jsonb,text,text) from public, anon;
grant execute on function create_rx(bigint,jsonb,text,text) to authenticated;

create or replace function cancel_rx(p_rx bigint) returns void language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('doctor','pharmacy','admin') then raise exception 'not allowed'; end if;
  if my_role()='doctor' and not exists(select 1 from prescriptions p join visits v on v.id=p.visit_id where p.id=p_rx and v.doctor_id=my_doctor())
    then raise exception 'this is not your patient'; end if;
  update prescriptions set status='cancelled' where id=p_rx and status='pending';
  if not found then raise exception 'only pending prescriptions can be cancelled'; end if;
end $$;
revoke all on function cancel_rx(bigint) from public, anon; grant execute on function cancel_rx(bigint) to authenticated;

-- prescriptions of one visit (doctor view)
create or replace function visit_rx(p_visit bigint) returns json language plpgsql stable security definer set search_path=public as $$
begin
  if my_role() not in ('doctor','admin') then raise exception 'not allowed'; end if;
  if my_role()='doctor' and not exists(select 1 from visits where id=p_visit and doctor_id=my_doctor()) then raise exception 'this is not your patient'; end if;
  return coalesce((select json_agg(json_build_object('id',p.id,'status',p.status,'created_at',p.created_at,
      'items',(select json_agg(json_build_object('drug',d.name||coalesce(' '||d.strength,''),'dose',i.dose,'days',i.days,'qty',i.qty) order by i.id)
               from prescription_items i join drugs d on d.id=i.drug_id where i.rx_id=p.id)) order by p.id)
    from prescriptions p where p.visit_id=p_visit),'[]'::json);
end $$;
revoke all on function visit_rx(bigint) from public, anon; grant execute on function visit_rx(bigint) to authenticated;

-- pharmacist: pending prescriptions with patient, items, stock on hand and checks
create or replace function pharmacy_queue() returns json language plpgsql stable security definer set search_path=public as $$
declare today date := (now() at time zone 'Asia/Kathmandu')::date;
begin
  if my_role() not in ('pharmacy','admin') then raise exception 'not allowed'; end if;
  return coalesce((select json_agg(x order by x.created_at) from (
    select p.id, p.created_at, p.note, p.ack_reason, v.bill, v.name, v.age, v.allergies, d.name as doctor,
      (select json_agg(json_build_object('drug',dr.name||coalesce(' '||dr.strength,''),'form',dr.form,'rx_class',dr.rx_class,
          'dose',i.dose,'days',i.days,'qty',i.qty,
          'stock',(select coalesce(sum(s.qty),0) from drug_stock s where s.drug_id=dr.id and s.expiry>=today)) order by i.id)
         from prescription_items i join drugs dr on dr.id=i.drug_id where i.rx_id=p.id) as items,
      rx_check(v.id,(select array_agg(drug_id) from prescription_items where rx_id=p.id)) as checks
    from prescriptions p join visits v on v.id=p.visit_id join doctors d on d.id=v.doctor_id
    where p.status='pending' order by p.created_at limit 60) x),'[]'::json);
end $$;
revoke all on function pharmacy_queue() from public, anon; grant execute on function pharmacy_queue() to authenticated;

-- dispense: blocks on allergy conflict, needs a reason for a major interaction, takes stock first-expiry-first-out,
-- skips expired batches, and adds the medicines to the patient's bill. All or nothing.
create or replace function dispense_rx(p_rx bigint, p_override text default null) returns json
language plpgsql security definer set search_path=public as $$
declare rx prescriptions; v visits; c json; i record; s record; need int; take int; billed numeric := 0;
        today date := (now() at time zone 'Asia/Kathmandu')::date; majors int; batches jsonb;
begin
  if my_role() not in ('pharmacy','admin') then raise exception 'only the pharmacy can dispense'; end if;
  select * into rx from prescriptions where id=p_rx for update;
  if not found or rx.status<>'pending' then raise exception 'this prescription is not pending'; end if;
  select * into v from visits where id=rx.visit_id;
  c := rx_check(v.id,(select array_agg(drug_id) from prescription_items where rx_id=rx.id));
  if json_array_length(c->'allergy')>0 then raise exception 'ALLERGY CONFLICT. % Do not dispense. Ask the doctor.', check_text(c); end if;
  select count(*) into majors from json_array_elements(c->'interactions') e where e->>'severity'='major';
  if majors>0 and length(trim(coalesce(p_override,'')))=0 and rx.ack_reason is null then
    raise exception 'MAJOR INTERACTION between these medicines. Give a reason to continue, or ask the doctor.'; end if;
  batches := '[]'::jsonb;
  for i in select it.*, d.name as dn, d.strength, d.unit_price from prescription_items it join drugs d on d.id=it.drug_id where it.rx_id=rx.id order by it.id loop
    need := i.qty;
    for s in select * from drug_stock where drug_id=i.drug_id and expiry>=today and qty>0 order by expiry, id for update loop
      exit when need<=0;
      take := least(need, s.qty);
      update drug_stock set qty=qty-take where id=s.id;
      batches := batches || jsonb_build_object('drug',i.dn,'batch',s.batch,'qty',take);
      need := need-take;
    end loop;
    if need>0 then raise exception 'Not enough in-date stock for % (short by %).', i.dn||coalesce(' '||i.strength,''), need; end if;
    if i.unit_price*i.qty>0 then
      insert into bill_items(visit_id,description,amount) values(v.id,'Pharmacy: '||i.dn||coalesce(' '||i.strength,'')||' x'||i.qty,i.unit_price*i.qty);
      billed := billed + i.unit_price*i.qty;
    end if;
  end loop;
  update prescriptions set status='dispensed', dispensed_at=now(), dispensed_by=auth.uid() where id=rx.id;
  perform audit_write(auth.uid(),'DISPENSE','prescriptions',rx.id::text,
    jsonb_build_object('batches',batches,'billed',billed,'interaction_override',nullif(left(trim(coalesce(p_override,'')),200),'')));
  return json_build_object('ok',true,'billed',billed);
end $$;
revoke all on function dispense_rx(bigint,text) from public, anon; grant execute on function dispense_rx(bigint,text) to authenticated;

create or replace function add_stock(p_drug bigint, p_batch text, p_expiry date, p_qty int) returns void
language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('pharmacy','admin') then raise exception 'not allowed'; end if;
  if length(trim(coalesce(p_batch,'')))=0 then raise exception 'batch number required'; end if;
  if p_qty is null or p_qty<1 or p_qty>100000 then raise exception 'quantity must be 1 to 100000'; end if;
  if p_expiry is null or p_expiry <= (now() at time zone 'Asia/Kathmandu')::date then raise exception 'expiry date must be in the future'; end if;
  insert into drug_stock(drug_id,batch,expiry,qty) values(p_drug,left(trim(p_batch),40),p_expiry,p_qty)
  on conflict (drug_id,batch) do update set qty=drug_stock.qty+excluded.qty, expiry=excluded.expiry;
  perform audit_write(auth.uid(),'STOCK_IN','drug_stock',p_drug::text,jsonb_build_object('batch',left(trim(p_batch),40),'qty',p_qty,'expiry',p_expiry));
end $$;
revoke all on function add_stock(bigint,text,date,int) from public, anon; grant execute on function add_stock(bigint,text,date,int) to authenticated;

-- =====================================================================
-- WARDS AND BEDS: admit, transfer, discharge, bed charges added to the bill
-- =====================================================================
create table if not exists wards(id text primary key, name text not null, active boolean not null default true);
create table if not exists beds(
  id text primary key, ward_id text not null references wards(id), label text not null,
  rate numeric(10,2) not null default 0 check (rate>=0), active boolean not null default true);
create table if not exists admissions(
  id bigint generated always as identity primary key,
  visit_id bigint not null references visits(id),
  bed_id text not null references beds(id),
  admitted_at timestamptz not null default now(), since timestamptz not null default now(),
  discharged_at timestamptz, admit_note text, discharge_summary text,
  admitted_by uuid default auth.uid());
create unique index if not exists admissions_one_per_bed on admissions(bed_id) where discharged_at is null;
create unique index if not exists admissions_one_per_visit on admissions(visit_id) where discharged_at is null;
alter table wards enable row level security; alter table beds enable row level security; alter table admissions enable row level security;
drop policy if exists "wards read" on wards; create policy "wards read" on wards for select to authenticated using (true);
drop policy if exists "wards admin" on wards; create policy "wards admin" on wards for all to authenticated using (my_role()='admin') with check (my_role()='admin');
drop policy if exists "beds read" on beds; create policy "beds read" on beds for select to authenticated using (true);
drop policy if exists "beds admin" on beds; create policy "beds admin" on beds for all to authenticated using (my_role()='admin') with check (my_role()='admin');
drop policy if exists "adm read" on admissions; create policy "adm read" on admissions for select to authenticated using (my_role() in ('reception','doctor','admin'));

create or replace function bed_charge(p_visit bigint, p_bed text, p_from timestamptz) returns void
language plpgsql security definer set search_path=public as $$
declare b beds; days int;
begin
  select * into b from beds where id=p_bed;
  if b.rate>0 then
    days := greatest(1, ceil(extract(epoch from (now()-p_from))/86400)::int);
    insert into bill_items(visit_id,description,amount) values(p_visit,'Bed '||b.label||' x'||days||' day'||case when days=1 then '' else 's' end,b.rate*days);
  end if;
end $$;
revoke all on function bed_charge(bigint,text,timestamptz) from public, anon, authenticated;

create or replace function admit_patient(p_visit bigint, p_bed text, p_note text default null) returns bigint
language plpgsql security definer set search_path=public as $$
declare aid bigint;
begin
  if my_role() not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  if my_role()='doctor' and not exists(select 1 from visits where id=p_visit and doctor_id=my_doctor()) then raise exception 'this is not your patient'; end if;
  if not exists(select 1 from beds where id=p_bed and active) then raise exception 'this bed is not available'; end if;
  begin
    insert into admissions(visit_id,bed_id,admit_note) values(p_visit,p_bed,left(p_note,300)) returning id into aid;
  exception when unique_violation then raise exception 'that bed is occupied, or the patient is already admitted';
  end;
  update visits set status='done' where id=p_visit and status in ('waiting','in_room');   -- the OPD visit ends when the patient is admitted
  perform audit_write(auth.uid(),'ADMIT','admissions',aid::text,jsonb_build_object('bed',p_bed,'visit',p_visit));
  return aid;
end $$;

create or replace function transfer_bed(p_adm bigint, p_bed text) returns void language plpgsql security definer set search_path=public as $$
declare a admissions;
begin
  if my_role() not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  select * into a from admissions where id=p_adm and discharged_at is null for update;
  if not found then raise exception 'admission not found'; end if;
  if a.bed_id=p_bed then return; end if;
  if not exists(select 1 from beds where id=p_bed and active) then raise exception 'this bed is not available'; end if;
  begin
    update admissions set bed_id=p_bed, since=now() where id=p_adm;
  exception when unique_violation then raise exception 'that bed is occupied';
  end;
  perform bed_charge(a.visit_id, a.bed_id, a.since);
  perform audit_write(auth.uid(),'TRANSFER','admissions',p_adm::text,jsonb_build_object('from',a.bed_id,'to',p_bed));
end $$;

create or replace function discharge_patient(p_adm bigint, p_summary text) returns void language plpgsql security definer set search_path=public as $$
declare a admissions;
begin
  if my_role() not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  if length(trim(coalesce(p_summary,'')))<3 then raise exception 'write a short discharge summary'; end if;
  select * into a from admissions where id=p_adm and discharged_at is null for update;
  if not found then raise exception 'admission not found'; end if;
  update admissions set discharged_at=now(), discharge_summary=left(p_summary,2000) where id=p_adm;
  perform bed_charge(a.visit_id, a.bed_id, a.since);
  perform audit_write(auth.uid(),'DISCHARGE','admissions',p_adm::text,jsonb_build_object('bed',a.bed_id));
end $$;
revoke all on function admit_patient(bigint,text,text), transfer_bed(bigint,text), discharge_patient(bigint,text) from public, anon;
grant execute on function admit_patient(bigint,text,text), transfer_bed(bigint,text), discharge_patient(bigint,text) to authenticated;

create or replace function bed_board() returns json language plpgsql stable security definer set search_path=public as $$
begin
  if my_role() not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  return coalesce((select json_agg(w order by w.name) from (
    select wd.id, wd.name, wd.active,
      coalesce((select json_agg(json_build_object('id',b.id,'label',b.label,'rate',b.rate,'active',b.active,
          'adm', (select json_build_object('id',a.id,'visit_id',a.visit_id,'name',v.name,'bill',v.bill,'since',a.admitted_at,'doctor',d.name,'note',a.admit_note)
                  from admissions a join visits v on v.id=a.visit_id join doctors d on d.id=v.doctor_id
                  where a.bed_id=b.id and a.discharged_at is null)) order by b.label) from beds b where b.ward_id=wd.id),'[]'::json) as beds
    from wards wd) w),'[]'::json);
end $$;
revoke all on function bed_board() from public, anon; grant execute on function bed_board() to authenticated;

-- =====================================================================
-- INSURANCE CLAIMS: draft -> submitted -> approved / rejected -> paid
-- =====================================================================
create table if not exists insurers(id bigint generated always as identity primary key, name text unique not null, active boolean not null default true);
create table if not exists claims(
  id bigint generated always as identity primary key,
  visit_id bigint not null references visits(id) on delete cascade,
  insurer_id bigint not null references insurers(id),
  policy_no text not null, amount numeric(10,2) not null check (amount>=0),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','paid')),
  approved_amount numeric(10,2) check (approved_amount>=0), note text,
  created_by uuid default auth.uid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(visit_id, insurer_id));
alter table insurers enable row level security; alter table claims enable row level security;
drop policy if exists "insurers read" on insurers; create policy "insurers read" on insurers for select to authenticated using (my_role() in ('reception','admin'));
drop policy if exists "insurers admin" on insurers; create policy "insurers admin" on insurers for all to authenticated using (my_role()='admin') with check (my_role()='admin');
drop policy if exists "claims staff" on claims; create policy "claims staff" on claims for all to authenticated
  using (my_role() in ('reception','admin')) with check (my_role() in ('reception','admin'));

create or replace function claims_flow() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status is distinct from old.status then
    if not ((old.status='draft' and new.status='submitted') or (old.status='submitted' and new.status in ('approved','rejected'))
         or (old.status='approved' and new.status='paid') or (old.status='rejected' and new.status='submitted')) then
      raise exception 'a claim cannot go from % to %', old.status, new.status; end if;
    if new.status='approved' and new.approved_amount is null then raise exception 'enter the approved amount'; end if;
  end if;
  return new;
end $$;
drop trigger if exists claims_flow_trg on claims;
create trigger claims_flow_trg before update on claims for each row execute function claims_flow();

-- =====================================================================
-- PILOT: staff feedback (the "Send feedback" button) so problems are written down while people work
-- =====================================================================
create table if not exists feedback(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid not null default auth.uid(), role text, screen text,
  kind text not null default 'confusing' check (kind in ('bug','confusing','idea','praise')),
  message text not null check (length(trim(message))>=3),
  status text not null default 'new' check (status in ('new','seen','fixed')));
alter table feedback enable row level security;
drop policy if exists "feedback send" on feedback; create policy "feedback send" on feedback for insert to authenticated
  with check (user_id=auth.uid() and my_role() is not null);
drop policy if exists "feedback admin" on feedback; create policy "feedback admin" on feedback for select to authenticated using (my_role()='admin');
drop policy if exists "feedback admin upd" on feedback; create policy "feedback admin upd" on feedback for update to authenticated
  using (my_role()='admin') with check (my_role()='admin');

-- audit the new tables
select attach_audit('drugs'), attach_audit('prescriptions'), attach_audit('prescription_items'), attach_audit('drug_stock'),
       attach_audit('wards'), attach_audit('beds'), attach_audit('admissions'), attach_audit('insurers'), attach_audit('claims');

-- =====================================================================
-- patient_status: final version (adds prescription status and message consent)
-- =====================================================================
create or replace function patient_status(p_bill text,p_code text)
returns json language plpgsql security definer set search_path=public as $$
declare v visits; d doctors; b text := upper(trim(p_bill)); pos int; q int; r int; tot numeric; rx text;
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5
    then return json_build_object('locked',true); end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return null; end if;
  select * into d from doctors where id=v.doctor_id;
  select count(*) into q from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review');
  select count(*)+1 into pos from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review') and q_at<v.q_at;
  select count(*) into r from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status='in_room';
  select coalesce(sum(amount),0) into tot from bill_items where visit_id=v.id;
  select case when exists(select 1 from prescriptions where visit_id=v.id and status='pending') then 'pending'
              when exists(select 1 from prescriptions where visit_id=v.id and status='dispensed') then 'dispensed' else 'none' end into rx;
  return json_build_object('bill',v.bill,'name',v.name,'doctor',d.name,'dept',d.dept,'token',v.token,
    'status',v.status,'test_name',v.test_name,'test_due',v.test_due,'report_path',v.report_path,
    'pos',case when v.status in('waiting','review') then pos end,'in_room',r,'queue_len',q,'avg_min',d.avg_min,
    'total',tot,'paid',v.paid_at is not null,'rx',rx,'sms',v.consent_sms);
end $$;
grant execute on function patient_status(text,text) to anon, authenticated;

-- =====================================================================
-- SAMPLE DATA (placeholders: edit or delete in the app. A pharmacist must review before real use.)
-- =====================================================================
insert into drugs(name,generic,drug_class,strength,form,rx_class,unit_price) values
  ('Paracetamol','paracetamol',null,'500 mg','tablet','OTC',2),
  ('Ibuprofen','ibuprofen','nsaid','400 mg','tablet','OTC',3),
  ('Aspirin','aspirin','nsaid','75 mg','tablet','OTC',2),
  ('Amoxicillin','amoxicillin','penicillin','500 mg','capsule','Rx',8),
  ('Metformin','metformin',null,'500 mg','tablet','Rx',3),
  ('Warfarin','warfarin',null,'5 mg','tablet','Rx',6),
  ('Cetirizine','cetirizine',null,'10 mg','tablet','OTC',2),
  ('ORS','oral rehydration salts',null,'1 sachet','sachet','OTC',15)
on conflict (name,strength) do nothing;
insert into drug_interactions(generic_a,generic_b,severity,note) values
  ('ibuprofen','warfarin','major','raises bleeding risk'),
  ('aspirin','warfarin','major','raises bleeding risk'),
  ('aspirin','ibuprofen','moderate','may reduce aspirin protection and irritate the stomach')
on conflict do nothing;
insert into wards(id,name) values ('w1','General Ward') on conflict do nothing;
insert into beds(id,ward_id,label,rate) values ('w1-1','w1','G-1',0),('w1-2','w1','G-2',0),('w1-3','w1','G-3',0),('w1-4','w1','G-4',0) on conflict do nothing;

-- >>>>>>>>>> schema_v11.sql
-- ===== v11: safety fixes (Phase 7 "Must") =====
-- 1) no duplicate token numbers when two desks register at the same instant
-- 2) allergy synonym / class table (e.g. "sulfa", "NSAIDs") editable by an admin
-- 3) interaction + allergy check also looks at the same patient's earlier prescriptions
-- Run after v10. Safe to re-run. The sample allergy terms are PLACEHOLDERS: a pharmacist must review them.

-- =====================================================================
-- 1) TOKENS: one counter row per doctor per day, incremented atomically (row lock)
-- =====================================================================
create table if not exists token_counters(
  doctor_id text not null references doctors(id) on delete cascade,
  visit_date date not null,
  last int not null default 0,
  primary key (doctor_id, visit_date));
alter table token_counters enable row level security;      -- no policies: only the function below touches it

create or replace function next_token(p_doctor text, p_date date) returns int
language plpgsql security definer set search_path=public as $$
declare n int;
begin
  insert into token_counters(doctor_id, visit_date, last)
  values (p_doctor, p_date, coalesce((select max(token) from visits where doctor_id=p_doctor and visit_date=p_date),0) + 1)
  on conflict (doctor_id, visit_date) do update set last = token_counters.last + 1
  returning last into n;
  return n;
end $$;
revoke all on function next_token(text,date) from public, anon;
grant execute on function next_token(text,date) to authenticated;

-- register_visit is redefined in section 5 (short bill numbers) and uses next_token() too.

-- belt and braces: the database itself refuses a duplicate token (only added if today's data has none)
do $$ begin
  if not exists (select 1 from visits group by doctor_id, visit_date, token having count(*)>1) then
    create unique index if not exists visits_token_uniq on visits(doctor_id, visit_date, token);
  end if;
end $$;

-- =====================================================================
-- 2) ALLERGY TERMS: "sulfa" -> sulfamethoxazole, cotrimoxazole ...
-- =====================================================================
create table if not exists allergy_terms(
  term text primary key check (length(trim(term))>=3 and term=lower(term)),   -- what the patient/doctor types, lower case
  expands text[] not null default '{}',                                       -- drug names / generics / classes it covers, lower case
  note text,
  active boolean not null default true);
alter table allergy_terms enable row level security;
drop policy if exists "allergy terms read" on allergy_terms;
create policy "allergy terms read" on allergy_terms for select to authenticated using (true);
drop policy if exists "allergy terms write" on allergy_terms;
create policy "allergy terms write" on allergy_terms for all to authenticated
  using (my_role()='admin') with check (my_role()='admin');

insert into allergy_terms(term, expands, note) values
 ('sulfa',        '{sulfamethoxazole,sulfadiazine,sulfasalazine,sulfacetamide,cotrimoxazole,co-trimoxazole,trimethoprim-sulfamethoxazole}', 'sulfonamide antibiotics'),
 ('sulpha',       '{sulfamethoxazole,sulfadiazine,sulfasalazine,sulfacetamide,cotrimoxazole,co-trimoxazole,trimethoprim-sulfamethoxazole}', 'spelling'),
 ('sulfonamide',  '{sulfamethoxazole,sulfadiazine,sulfasalazine,sulfacetamide,cotrimoxazole,co-trimoxazole,trimethoprim-sulfamethoxazole}', ''),
 ('nsaid',        '{ibuprofen,diclofenac,naproxen,ketorolac,mefenamic,piroxicam,indomethacin,aspirin,acetylsalicylic,celecoxib,etoricoxib,aceclofenac,nimesulide}', 'covers "NSAID" and "NSAIDs"'),
 ('anti-inflammatory', '{ibuprofen,diclofenac,naproxen,ketorolac,mefenamic,piroxicam,indomethacin,aspirin,acetylsalicylic,celecoxib,etoricoxib,aceclofenac,nimesulide}', ''),
 ('aspirin',      '{aspirin,acetylsalicylic}', 'brand/generic names only; not widened to all NSAIDs'),
 ('penicillin',   '{penicillin,amoxicillin,ampicillin,cloxacillin,flucloxacillin,piperacillin,benzylpenicillin,phenoxymethylpenicillin,co-amoxiclav,amoxiclav,amoxicillin-clavulanate}', 'covers "penicillins"'),
 ('amoxicillin',  '{penicillin,amoxicillin,ampicillin,co-amoxiclav,amoxiclav,amoxicillin-clavulanate}', 'same family'),
 ('cephalosporin','{cefixime,ceftriaxone,cefuroxime,cefalexin,cephalexin,cefotaxime,cefpodoxime,cefadroxil,ceftazidime,cefdinir}', 'covers "cephalosporins"'),
 ('macrolide',    '{azithromycin,clarithromycin,erythromycin,roxithromycin}', ''),
 ('quinolone',    '{ciprofloxacin,levofloxacin,ofloxacin,norfloxacin,moxifloxacin}', 'also matches "fluoroquinolone"'),
 ('tetracycline', '{tetracycline,doxycycline,minocycline}', ''),
 ('statin',       '{atorvastatin,rosuvastatin,simvastatin,pravastatin}', ''),
 ('paracetamol',  '{paracetamol,acetaminophen}', 'same drug, two names'),
 ('acetaminophen','{paracetamol,acetaminophen}', 'same drug, two names'),
 ('opioid',       '{codeine,tramadol,morphine,pethidine}', ''),
 ('ace inhibitor','{enalapril,lisinopril,ramipril,captopril,perindopril}', '')
on conflict (term) do nothing;

-- =====================================================================
-- 3) rx_check: allergy terms + same patient's earlier prescriptions
--    "same patient" = same phone (last 10 digits) and same name (until a patient master record exists).
--    "earlier prescription" = pending or dispensed and its course (days, default 30) is still running.
--    Allergies written on the patient's earlier visits (last 2 years) count too.
-- =====================================================================
create or replace function rx_check(p_visit bigint, p_drugs bigint[]) returns json
language plpgsql stable security definer set search_path=public as $$
declare al text[]; ra jsonb; ri jsonb; earlier bigint[]; vis visits; key_phone text;
begin
  if my_role() not in ('doctor','pharmacy','admin') then raise exception 'not allowed'; end if;
  select * into vis from visits where id=p_visit;
  key_phone := right(regexp_replace(coalesce(vis.phone,''),'\D','','g'),10);

  -- allergies: this visit + the same patient's earlier visits
  select coalesce(array_agg(distinct lower(trim(x))) filter (where length(trim(x))>=3),'{}') into al
    from visits v, unnest(regexp_split_to_array(coalesce(v.allergies,''), '[,;\n]+')) x
   where v.id=p_visit
      or (vis.id is not null and length(key_phone)>=7 and v.visit_date >= vis.visit_date - 730
          and right(regexp_replace(coalesce(v.phone,''),'\D','','g'),10)=key_phone
          and lower(trim(v.name))=lower(trim(vis.name)));

  -- every allergen text -> the words it stands for (itself + matching allergy_terms rows)
  select coalesce(jsonb_agg(distinct jsonb_build_object('drug',d.name,'allergen',m.a)),'[]'::jsonb) into ra
    from drugs d
    cross join lateral (
      select a, array_cat(array[a], coalesce((select array_agg(distinct e) from allergy_terms t, unnest(t.expands) e
                                               where t.active and a like '%'||t.term||'%'),'{}')) as words
        from unnest(al) a) m
   where d.id = any(p_drugs) and (
         lower(d.name) like '%'||m.a||'%' or lower(d.generic) like '%'||m.a||'%' or lower(coalesce(d.drug_class,'')) like '%'||m.a||'%'
      or (length(d.generic)>=4 and m.a like '%'||lower(d.generic)||'%')
      or (length(coalesce(d.drug_class,''))>=4 and m.a like '%'||lower(d.drug_class)||'%')
      or exists (select 1 from unnest(m.words) w
                  where length(w)>=4 and (lower(d.name) like '%'||w||'%' or lower(d.generic) like '%'||w||'%'
                                          or lower(coalesce(d.drug_class,'')) like '%'||w||'%')));

  -- the patient's other medicines that are still being taken
  select coalesce(array_agg(distinct i.drug_id),'{}') into earlier
    from prescriptions p join prescription_items i on i.rx_id=p.id
    join visits v on v.id=p.visit_id
   where p.status in ('pending','dispensed')
     and p.created_at + make_interval(days => coalesce(i.days,30)) > now()
     and (v.id=p_visit
          or (vis.id is not null and length(key_phone)>=7
              and right(regexp_replace(coalesce(v.phone,''),'\D','','g'),10)=key_phone
              and lower(trim(v.name))=lower(trim(vis.name))));

  -- interactions: every pair with at least one medicine from this prescription; 'earlier' = the other one is only in older prescriptions
  select coalesce(jsonb_agg(jsonb_build_object('a',x.generic_a,'b',x.generic_b,'severity',x.severity,'note',x.note,
           'earlier', not (exists(select 1 from drugs d where d.id=any(p_drugs) and lower(d.generic)=x.generic_a)
                       and exists(select 1 from drugs d where d.id=any(p_drugs) and lower(d.generic)=x.generic_b)))),'[]'::jsonb) into ri
    from drug_interactions x
   where (exists(select 1 from drugs d1 where d1.id=any(p_drugs) and lower(d1.generic)=x.generic_a)
          and exists(select 1 from drugs d2 where (d2.id=any(p_drugs) or d2.id=any(earlier)) and lower(d2.generic)=x.generic_b))
      or (exists(select 1 from drugs d1 where d1.id=any(p_drugs) and lower(d1.generic)=x.generic_b)
          and exists(select 1 from drugs d2 where (d2.id=any(p_drugs) or d2.id=any(earlier)) and lower(d2.generic)=x.generic_a));
  return json_build_object('allergy',ra,'interactions',ri);
end $$;
revoke all on function rx_check(bigint,bigint[]) from public, anon;
grant execute on function rx_check(bigint,bigint[]) to authenticated;

-- the doctor's error text now says when the other medicine is from an earlier prescription
create or replace function check_text(c json) returns text language sql immutable as $$
  select coalesce((select string_agg('Allergy: '||(e->>'drug')||' (patient allergic to '||(e->>'allergen')||')', '; ') from json_array_elements(c->'allergy') e),'');
$$;

-- create_rx: same logic as v10, but the major-interaction message says when the other medicine is from an earlier prescription
create or replace function create_rx(p_visit bigint, p_items jsonb, p_note text default null, p_ack text default null) returns json
language plpgsql security definer set search_path=public as $$
declare v visits; c json; rid bigint; it jsonb; ids bigint[]; majors text; n int := jsonb_array_length(coalesce(p_items,'[]'::jsonb));
begin
  if my_role() not in ('doctor','admin') then raise exception 'only doctors can prescribe'; end if;
  select * into v from visits where id=p_visit;
  if not found then raise exception 'visit not found'; end if;
  if my_role()='doctor' and v.doctor_id is distinct from my_doctor() then raise exception 'this is not your patient'; end if;
  if n < 1 or n > 15 then raise exception 'add between 1 and 15 medicines'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if (it->>'drug_id') is null or length(trim(coalesce(it->>'dose','')))=0 or coalesce((it->>'qty')::int,0) < 1 or (it->>'qty')::int > 1000
      then raise exception 'each medicine needs a dose and a quantity (1 to 1000)'; end if;
    if not exists(select 1 from drugs where id=(it->>'drug_id')::bigint and active) then raise exception 'unknown or inactive medicine'; end if;
  end loop;
  select array_agg((x->>'drug_id')::bigint) into ids from jsonb_array_elements(p_items) x;
  c := rx_check(p_visit, ids);
  if json_array_length(c->'allergy') > 0 then
    raise exception 'ALLERGY CONFLICT. % Remove the medicine, or correct the allergy list if it is wrong.', check_text(c); end if;
  select string_agg(initcap(e->>'a')||' + '||initcap(e->>'b')||case when (e->>'earlier')::boolean then ' (with an earlier prescription of this patient)' else '' end||': '||coalesce(e->>'note','interaction'), '; ') into majors
    from json_array_elements(c->'interactions') e where e->>'severity'='major';
  if majors is not null and length(trim(coalesce(p_ack,'')))=0 then
    raise exception 'MAJOR INTERACTION. % Give a reason to continue, or change the medicines.', majors; end if;
  insert into prescriptions(visit_id,note,ack_reason) values(p_visit, left(p_note,300), nullif(left(trim(coalesce(p_ack,'')),300),'')) returning id into rid;
  insert into prescription_items(rx_id,drug_id,dose,days,qty)
    select rid,(x->>'drug_id')::bigint,left(x->>'dose',80),nullif(x->>'days','')::int,(x->>'qty')::int from jsonb_array_elements(p_items) x;
  return json_build_object('id',rid,'checks',c);
end $$;
revoke all on function create_rx(bigint,jsonb,text,text) from public, anon;
grant execute on function create_rx(bigint,jsonb,text,text) to authenticated;

-- =====================================================================
-- 4) DOCTOR: this patient's earlier visits and prescriptions (same patient = same phone + same name)
-- =====================================================================
-- merge: renamed from patient_history(p_visit) so it does not clash with the patient-record function patient_history(p_patient)
create or replace function visit_patient_history(p_visit bigint) returns json
language plpgsql stable security definer set search_path=public as $$
declare vis visits; key_phone text;
begin
  if my_role() not in ('doctor','admin') then raise exception 'not allowed'; end if;
  select * into vis from visits where id=p_visit;
  if not found then raise exception 'visit not found'; end if;
  if my_role()='doctor' and vis.doctor_id is distinct from my_doctor() then raise exception 'this is not your patient'; end if;
  key_phone := right(regexp_replace(coalesce(vis.phone,''),'\D','','g'),10);
  if length(key_phone) < 7 or vis.name is null then return '[]'::json; end if;
  return coalesce((select json_agg(x order by x.visit_date desc, x.id desc) from (
    select v.id, v.visit_date, v.reason, v.allergies, v.status, d.name as doctor,
      (select json_agg(json_build_object('id',p.id,'status',p.status,'created_at',p.created_at,'items',
          (select json_agg(json_build_object('drug',dr.name||coalesce(' '||dr.strength,''),'dose',i.dose,'days',i.days,'qty',i.qty) order by i.id)
             from prescription_items i join drugs dr on dr.id=i.drug_id where i.rx_id=p.id)) order by p.id)
         from prescriptions p where p.visit_id=v.id and p.status<>'cancelled') as rx
    from visits v join doctors d on d.id=v.doctor_id
   where v.id<>p_visit and right(regexp_replace(coalesce(v.phone,''),'\D','','g'),10)=key_phone
     and lower(trim(v.name))=lower(trim(vis.name))
   order by v.visit_date desc, v.id desc limit 20) x),'[]'::json);
end $$;
revoke all on function visit_patient_history(bigint) from public, anon;
grant execute on function visit_patient_history(bigint) to authenticated;

-- =====================================================================
-- 5) SHORT BILL NUMBERS: new bills are "BL-0012" (was "BL-20261127-0012").
--    Patients may type "BL-0012", "bl0012", "BL 12" or just "12"; old long numbers still work as typed.
--    The number comes from one global sequence, so it is unique forever (it grows to BL-10000 etc., never repeats).
-- =====================================================================
create or replace function norm_bill(p text) returns text language plpgsql immutable as $$
declare s text := upper(regexp_replace(coalesce(p,''),'[\s_]+','','g')); d text;
begin
  if s ~ '^(BL-?)?[0-9]{1,9}$' then                      -- short form: 12, BL12, BL-12, BL-0012
    d := ltrim(regexp_replace(s,'^BL-?','','i'),'0'); if d='' then d:='0'; end if;
    return 'BL-'||lpad(d, greatest(4,length(d)), '0');
  elsif s ~ '^BL[0-9]{8}-?[0-9]{1,6}$' then               -- old long form typed without dashes
    return regexp_replace(s,'^BL([0-9]{8})-?([0-9]+)$','BL-\1-\2');
  end if;
  return s;
end $$;
grant execute on function norm_bill(text) to anon, authenticated;

create or replace function register_visit(p_name text,p_phone text,p_age int,p_reason text,p_doctor text,
  p_allergies text default null, p_consent_sms boolean default false, p_consent_version text default null)
returns visits language plpgsql as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits; n bigint := nextval('bill_seq');
begin
  insert into visits(bill,code,name,phone,age,reason,doctor_id,visit_date,token,allergies,consent_sms,consent_version,consent_at)
  values('BL-'||lpad(n::text, greatest(4,length(n::text)), '0'),
         lpad(floor(100000+random()*900000)::int::text,6,'0'),
         left(trim(p_name),80),left(trim(p_phone),20),p_age,left(p_reason,200),p_doctor,d,
         next_token(p_doctor, d),
         nullif(left(trim(coalesce(p_allergies,'')),300),''), coalesce(p_consent_sms,false), p_consent_version,
         case when p_consent_version is not null then now() end)
  returning * into v;
  return v;
end $$;
grant execute on function register_visit(text,text,int,text,text,text,boolean,text) to authenticated;

-- patient lookups, privacy requests and SMS withdrawal now understand the short forms (same logic as before, plus norm_bill)
create or replace function patient_status(p_bill text,p_code text)
returns json language plpgsql security definer set search_path=public as $$
declare v visits; d doctors; b text := norm_bill(p_bill); pos int; q int; r int; tot numeric; rx text;
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5
    then return json_build_object('locked',true); end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return null; end if;
  select * into d from doctors where id=v.doctor_id;
  select count(*) into q from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review');
  select count(*)+1 into pos from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status in('waiting','review') and q_at<v.q_at;
  select count(*) into r from visits where doctor_id=v.doctor_id and visit_date=v.visit_date and status='in_room';
  select coalesce(sum(amount),0) into tot from bill_items where visit_id=v.id;
  select case when exists(select 1 from prescriptions where visit_id=v.id and status='pending') then 'pending'
              when exists(select 1 from prescriptions where visit_id=v.id and status='dispensed') then 'dispensed' else 'none' end into rx;
  return json_build_object('bill',v.bill,'name',v.name,'doctor',d.name,'dept',d.dept,'token',v.token,
    'status',v.status,'test_name',v.test_name,'test_due',v.test_due,'report_path',v.report_path,
    'pos',case when v.status in('waiting','review') then pos end,'in_room',r,'queue_len',q,'avg_min',d.avg_min,
    'total',tot,'paid',v.paid_at is not null,'rx',rx,'sms',v.consent_sms);
end $$;
grant execute on function patient_status(text,text) to anon, authenticated;

create or replace function patient_withdraw_sms(p_bill text, p_code text) returns boolean
language plpgsql security definer set search_path=public as $$
declare v visits; b text := norm_bill(p_bill);
begin
  if (select count(*) from lookup_attempts where bill=b and at>now()-interval '15 minutes')>=5 then return false; end if;
  select * into v from visits where bill=b and code=trim(p_code);
  if not found then insert into lookup_attempts(bill) values(b); return false; end if;
  update visits set consent_sms=false where id=v.id;
  update outbox set status='skipped', error='consent withdrawn' where visit_id=v.id and status='queued';
  perform audit_write(null,'CONSENT_WITHDRAWN','visits',v.id::text,'{"channel":"sms"}'::jsonb);
  return true;
end $$;
grant execute on function patient_withdraw_sms(text,text) to anon, authenticated;

create or replace function submit_privacy_request(p_kind text,p_name text,p_phone text,p_bill text,p_details text) returns void
language plpgsql security definer set search_path=public as $$
declare ph text := left(trim(coalesce(p_phone,'')),20);
begin
  if p_kind not in ('access','correction','erasure','withdraw_consent','question') then raise exception 'unknown request type'; end if;
  if length(trim(coalesce(p_name,'')))<2 or length(ph)<6 then raise exception 'name and phone required'; end if;
  if (select count(*) from privacy_requests where phone=ph and created_at>now()-interval '1 day')>=3 then raise exception 'too many requests'; end if;
  insert into privacy_requests(kind,name,phone,bill,details)
  values(p_kind,left(trim(p_name),80),ph,nullif(left(norm_bill(p_bill),30),''),left(coalesce(p_details,''),1000));
end $$;
grant execute on function submit_privacy_request(text,text,text,text,text) to anon, authenticated;


select attach_audit('allergy_terms');

-- >>>>>>>>>> PATIENTS: step 1 (patient master record)
-- ===== v11 / STEP 1: patient master record =====
-- Run after v10 (needs my_role, my_doctor, audit_write). Safe to re-run.
-- Adds: patients table + permanent patient number, search, history, edit, merge, erase,
--       and a new register_visit that links every visit to a patient (reuses a returning patient).

-- ---------- helpers ----------
-- digits only; drops the Nepal country code, so +977 9841234567, 977-9841234567 and 9841234567 all match
create or replace function norm_phone(p text) returns text language sql immutable as $$
  select case when d ~ '^977\d{10}$' then substr(d,4) else d end
  from (select regexp_replace(coalesce(p,''),'\D','','g') as d) x
$$;

create sequence if not exists patient_seq;

-- ---------- patients ----------
create table if not exists patients(
  id bigint generated always as identity primary key,
  patient_no text unique not null default ('PT-'||lpad(nextval('patient_seq')::text,6,'0')),
  name text not null,
  phone text not null,
  phone_norm text not null,
  age int check (age is null or (age>=0 and age<=120)),
  sex text check (sex is null or sex in ('F','M','O')),
  allergies text,
  merged_into bigint references patients(id),
  erased boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now());
create index if not exists patients_phone_idx on patients(phone_norm);
create index if not exists patients_name_idx on patients(lower(name));
-- the same person (same phone + same name) is one record; families sharing a phone stay separate by name
create unique index if not exists patients_person_uq on patients(phone_norm, lower(trim(name)))
  where merged_into is null and not erased;

alter table patients enable row level security;
drop policy if exists "patients read" on patients;
create policy "patients read" on patients for select to authenticated using (my_role() in ('reception','admin'));
-- no insert/update/delete policies: all writes go through the functions below.
-- (patients is deliberately NOT attached to the generic audit trigger: that trigger would copy names/phones into the log.
--  The functions below write audit entries with ids only.)

alter table visits add column if not exists patient_id bigint references patients(id);
create index if not exists visits_patient_idx on visits(patient_id);

-- ---------- backfill: link existing visits ----------
insert into patients(name,phone,phone_norm,age,allergies,created_at)
select g.name, g.phone, g.pn, g.age, g.allergies, g.c
from (
  select norm_phone(phone) pn, lower(trim(name)) nm,
         (array_agg(trim(name) order by created_at desc))[1] name,
         (array_agg(trim(phone) order by created_at desc))[1] phone,
         (array_agg(age order by created_at desc) filter (where age is not null))[1] age,
         (array_agg(allergies order by created_at desc) filter (where allergies is not null))[1] allergies,
         min(created_at) c
  from visits where name<>'[removed]' and patient_id is null and norm_phone(phone)<>''
  group by 1,2) g
where not exists(select 1 from patients p where p.phone_norm=g.pn and lower(trim(p.name))=g.nm and p.merged_into is null and not p.erased)
order by g.c;
update visits v set patient_id=p.id from patients p
 where v.patient_id is null and v.name<>'[removed]'
   and p.phone_norm=norm_phone(v.phone) and lower(trim(p.name))=lower(trim(v.name)) and p.merged_into is null and not p.erased;

-- only admin can move a visit to another patient (reception/doctor cannot re-link by editing)
create or replace function guard_patient_link() returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated','anon') and old.patient_id is not null
     and new.patient_id is distinct from old.patient_id and my_role() is distinct from 'admin'
  then raise exception 'only admin can change which patient a visit belongs to'; end if;
  return new;
end $$;
drop trigger if exists visits_patient_guard on visits;
create trigger visits_patient_guard before update on visits for each row execute function guard_patient_link();

-- when retention anonymises a patient's last remaining visit, the patient record is anonymised too
create or replace function patient_follow_retention() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.name='[removed]' and old.name is distinct from '[removed]' and new.patient_id is not null
     and not exists(select 1 from visits where patient_id=new.patient_id and name<>'[removed]') then
    update patients set name='[removed]', phone='', phone_norm='', age=null, sex=null, allergies=null, erased=true, updated_at=now()
     where id=new.patient_id;
  end if;
  return new;
end $$;
drop trigger if exists visits_patient_retention on visits;
create trigger visits_patient_retention after update of name on visits for each row execute function patient_follow_retention();

-- (register_visit is defined once, in the merged block after the queue step)

-- ---------- search (reception / admin) ----------
create or replace function patient_search(p_q text) returns json language plpgsql stable security definer set search_path=public as $$
declare q text := lower(trim(coalesce(p_q,''))); dg text := regexp_replace(q,'\D','','g'); pat text;
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  if length(q)<2 then return '[]'::json; end if;
  pat := '%'||replace(replace(replace(q,'\','\\'),'%','\%'),'_','\_')||'%';
  return coalesce((select json_agg(x) from (
    select p.id, p.patient_no, p.name, p.phone, p.age, p.sex, p.allergies,
           (select count(*) from visits v where v.patient_id=p.id) as visits,
           (select max(v.visit_date) from visits v where v.patient_id=p.id) as last_visit
    from patients p
    where p.merged_into is null and not p.erased and (
          (length(dg)>=4 and p.phone_norm like '%'||dg||'%')
       or lower(p.name) like pat escape '\'
       or lower(p.patient_no) like pat escape '\')
    order by (select max(v.created_at) from visits v where v.patient_id=p.id) desc nulls last, p.name
    limit 15) x),'[]'::json);
end $$;
revoke all on function patient_search(text) from public, anon; grant execute on function patient_search(text) to authenticated;

-- ---------- history (reception, admin, and a doctor who has seen this patient) ----------
drop function if exists patient_history(bigint);   -- merge: base version used parameter p_visit, patient version uses p_patient
create or replace function patient_history(p_patient bigint) returns json language plpgsql security definer set search_path=public as $$
declare r text := my_role(); pt patients; out json;
begin
  if r not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  select * into pt from patients where id=p_patient and not erased;
  if not found then raise exception 'patient not found'; end if;
  if r='doctor' and not exists(select 1 from visits where patient_id=p_patient and doctor_id=my_doctor())
    then raise exception 'this is not your patient'; end if;
  perform audit_write(auth.uid(),'PATIENT_VIEW','patients',p_patient::text,'{}'::jsonb);
  select json_agg(json_build_object('id',v.id,'date',v.visit_date,'bill',case when r='doctor' then null else v.bill end,
           'doctor',d.name,'reason',v.reason,'status',v.status,'test_name',v.test_name,
           'report_path',case when r in ('doctor','admin') then v.report_path end,'has_report',v.report_path is not null,
           'paid',v.paid_at is not null,
           'total',case when r in ('reception','admin') then (select coalesce(sum(amount),0) from bill_items b where b.visit_id=v.id) end)
         order by v.created_at desc) into out
    from visits v join doctors d on d.id=v.doctor_id where v.patient_id=p_patient;
  return json_build_object('patient',json_build_object('id',pt.id,'patient_no',pt.patient_no,'name',pt.name,'phone',pt.phone,
           'age',pt.age,'sex',pt.sex,'allergies',pt.allergies,'since',pt.created_at),
         'visits',coalesce(out,'[]'::json));
end $$;
revoke all on function patient_history(bigint) from public, anon; grant execute on function patient_history(bigint) to authenticated;

-- ---------- edit details (reception / admin) ----------
create or replace function patient_update(p_id bigint, p_name text, p_phone text, p_age int, p_sex text, p_allergies text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  if length(trim(coalesce(p_name,'')))<1 then raise exception 'name is required'; end if;
  if length(norm_phone(p_phone))<7 then raise exception 'enter a valid phone number'; end if;
  begin
    update patients set name=left(trim(p_name),80), phone=left(trim(p_phone),20), phone_norm=norm_phone(p_phone), age=p_age,
           sex=nullif(p_sex,''), allergies=nullif(left(trim(coalesce(p_allergies,'')),300),''), updated_at=now()
     where id=p_id and merged_into is null and not erased;
  exception when unique_violation then raise exception 'another patient already has this name and phone';
  end;
  if not found then raise exception 'patient not found'; end if;
  perform audit_write(auth.uid(),'PATIENT_UPDATE','patients',p_id::text,'{}'::jsonb);
end $$;
revoke all on function patient_update(bigint,text,text,int,text,text) from public, anon; grant execute on function patient_update(bigint,text,text,int,text,text) to authenticated;

-- ---------- admin: merge two records of the same person ----------
create or replace function patient_merge(p_keep bigint, p_drop bigint) returns void language plpgsql security definer set search_path=public as $$
declare k patients; x patients;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_keep=p_drop then raise exception 'choose two different records'; end if;
  select * into k from patients where id=p_keep and merged_into is null and not erased for update;
  select * into x from patients where id=p_drop and merged_into is null and not erased for update;
  if k.id is null or x.id is null then raise exception 'both records must exist and be active'; end if;
  update visits set patient_id=k.id where patient_id=x.id;
  update patients set allergies=coalesce(allergies,x.allergies), age=coalesce(age,x.age), updated_at=now() where id=k.id;
  -- keep the merged shell for traceability but free its name/phone and remove personal data
  update patients set merged_into=k.id, name='[merged]', phone='', phone_norm='', allergies=null, age=null, updated_at=now() where id=x.id;
  perform audit_write(auth.uid(),'PATIENT_MERGE','patients',k.id::text,jsonb_build_object('merged',x.id));
end $$;
revoke all on function patient_merge(bigint,bigint) from public, anon; grant execute on function patient_merge(bigint,bigint) to authenticated;

-- ---------- admin: erase one patient (privacy request) ----------
-- same effect as retention on that patient's visits: personal fields removed, report files queued for deletion, billing amounts kept
create or replace function patient_erase(p_id bigint) returns json language plpgsql security definer set search_path=public as $$
declare nv int;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if not exists(select 1 from patients where id=p_id) then raise exception 'patient not found'; end if;
  if exists(select 1 from admissions a join visits v on v.id=a.visit_id where v.patient_id=p_id and a.discharged_at is null)
    then raise exception 'this patient is currently admitted'; end if;
  insert into retention_queue(path) select report_path from visits where patient_id=p_id and report_path is not null on conflict do nothing;
  update visits set name='[removed]', phone='', reason=null, allergies=null, age=null, report_path=null, consent_sms=false,
         code='x'||md5(random()::text||id::text)
   where patient_id=p_id and name<>'[removed]';
  get diagnostics nv = row_count;
  update patients set name='[removed]', phone='', phone_norm='', age=null, sex=null, allergies=null, erased=true, updated_at=now() where id=p_id;
  perform audit_write(auth.uid(),'PATIENT_ERASE','patients',p_id::text,jsonb_build_object('visits',nv));
  return json_build_object('visits',nv);
end $$;
revoke all on function patient_erase(bigint) from public, anon; grant execute on function patient_erase(bigint) to authenticated;

-- >>>>>>>>>> QUEUE: step 2 (realtime + call_next)
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

-- >>>>>>>>>> MERGED register_visit (patients + short bill + atomic token)
drop function if exists register_visit(text,text,int,text,text,text,boolean,text);   -- old 8-argument version (the base section re-creates it on every run)
drop function if exists register_visit(text,text,int,text,text,text,boolean,text,bigint);
-- register_visit (merged): patient linking + short bill numbers (BL-0012) + atomic token via next_token()
create or replace function register_visit(p_name text,p_phone text,p_age int,p_reason text,p_doctor text,
  p_allergies text default null, p_consent_sms boolean default false, p_consent_version text default null,
  p_patient_id bigint default null)
returns visits language plpgsql security definer set search_path=public as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits; pt patients; bn bigint := nextval('bill_seq');
        nm text := left(trim(coalesce(p_name,'')),80); ph text := left(trim(coalesce(p_phone,'')),20);
        al text := nullif(left(trim(coalesce(p_allergies,'')),300),'');
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  if length(nm)<1 then raise exception 'name is required'; end if;
  if length(norm_phone(ph))<7 then raise exception 'enter a valid phone number'; end if;

  if p_patient_id is not null then
    select * into pt from patients where id=p_patient_id and merged_into is null and not erased for update;
    if not found then raise exception 'patient record not found'; end if;
    if (pt.name,pt.phone_norm,pt.age,pt.allergies) is distinct from (nm,norm_phone(ph),coalesce(p_age,pt.age),coalesce(al,pt.allergies)) then
      begin
        update patients set name=nm, phone=ph, phone_norm=norm_phone(ph), age=coalesce(p_age,age), allergies=coalesce(al,allergies), updated_at=now() where id=pt.id;
      exception when unique_violation then raise exception 'another patient already has this name and phone: pick that record instead';
      end;
      perform audit_write(auth.uid(),'PATIENT_UPDATE','patients',pt.id::text,'{"via":"registration"}'::jsonb);
    end if;
  else
    select * into pt from patients where phone_norm=norm_phone(ph) and lower(trim(name))=lower(nm) and merged_into is null and not erased;
    if not found then
      begin
        insert into patients(name,phone,phone_norm,age,allergies) values(nm,ph,norm_phone(ph),p_age,al) returning * into pt;
        perform audit_write(auth.uid(),'PATIENT_CREATE','patients',pt.id::text,'{}'::jsonb);
      exception when unique_violation then
        select * into pt from patients where phone_norm=norm_phone(ph) and lower(trim(name))=lower(nm) and merged_into is null and not erased;
      end;
    else
      update patients set age=coalesce(p_age,age), allergies=coalesce(al,allergies), phone=ph, updated_at=now() where id=pt.id;
    end if;
  end if;

  insert into visits(bill,code,name,phone,age,reason,doctor_id,visit_date,token,allergies,consent_sms,consent_version,consent_at,patient_id)
  values('BL-'||lpad(bn::text, greatest(4,length(bn::text)), '0'),
         lpad(floor(100000+random()*900000)::int::text,6,'0'),
         nm,ph,p_age,left(p_reason,200),p_doctor,d,
         next_token(p_doctor,d),
         coalesce(al, pt.allergies), coalesce(p_consent_sms,false), p_consent_version,
         case when p_consent_version is not null then now() end, pt.id)
  returning * into v;
  return v;
end $$;
revoke all on function register_visit(text,text,int,text,text,text,boolean,text,bigint) from public, anon;
grant execute on function register_visit(text,text,int,text,text,text,boolean,text,bigint) to authenticated;

-- >>>>>>>>>> NOTIFY: step 4
-- ===== v14 / STEP 4: notifications engine =====
-- Run after v13. Safe to re-run.
-- Adds: editable message wording (templates), message status for reception, reminder framework (day-before reminders).
-- Appointment messages (received / confirmed / changed / cancelled / reminder) switch on together with step 6 (v16);
-- follow-up reminders with step 5 (v15). Your existing messages (registered, "N patients ahead", called, report ready) keep working.

-- messages about an appointment (no visit yet) need their own link
alter table outbox add column if not exists appointment_id bigint references appointments(id) on delete set null;
create unique index if not exists outbox_appt_kind_uq on outbox(appointment_id, kind) where appointment_id is not null;

-- ---------- wording the clinic can edit (Admin > Messages) ----------
create table if not exists msg_templates(kind text primary key, label text not null, body text not null, updated_at timestamptz not null default now());
alter table msg_templates enable row level security;
drop policy if exists "tpl read" on msg_templates;  create policy "tpl read" on msg_templates for select to authenticated using (my_role()='admin');
drop policy if exists "tpl write" on msg_templates; create policy "tpl write" on msg_templates for update to authenticated using (my_role()='admin') with check (my_role()='admin' and length(body) between 5 and 320);
-- placeholders: {clinic} {name} {doctor} {token} {bill} {n} {s} {date} {time} {link}
insert into msg_templates(kind,label,body) values
 ('registered','After registration','{clinic}: Hi {name}, you are registered with {doctor}. Token {token}, bill {bill}.{link}'),
 ('ahead','Patients ahead','{clinic}: {n} patient{s} ahead of you for {doctor}. Please be ready.'),
 ('ahead_next','You are next','{clinic}: You are next for {doctor}. Please be ready.'),
 ('called','Called in','{clinic}: {name}, please go to {doctor} now. Token {token}.'),
 ('recall','Called again (not found)','{clinic}: {name}, {doctor} is calling you again. Please come to the room now. Token {token}.'),
 ('report_ready','Report ready','{clinic}: {name}, your report is ready. Please wait to be called back by {doctor}.'),
 ('followup','Follow-up reminder','{clinic}: {name}, your follow-up visit with {doctor} is due tomorrow ({date}). Please come to the clinic.'),
 ('appt_received','Appointment request received','{clinic}: Hi {name}, we received your appointment request for {doctor}. Reception will confirm the time.'),
 ('appt_confirmed','Appointment confirmed','{clinic}: {name}, your appointment with {doctor} is confirmed for {date} at {time}.'),
 ('appt_changed','Appointment time changed','{clinic}: {name}, your appointment with {doctor} has moved to {date} at {time}.'),
 ('appt_cancelled','Appointment cancelled','{clinic}: {name}, your appointment with {doctor} on {date} at {time} is cancelled. Please call us to book again.'),
 ('appt_reminder','Appointment reminder (day before)','{clinic}: Reminder: {name}, you have an appointment with {doctor} tomorrow, {date} at {time}.')
on conflict (kind) do nothing;

create or replace function tpl(k text, vars jsonb) returns text language plpgsql stable security definer set search_path=public as $$
declare b text := (select body from msg_templates where kind=k); r record;
begin
  if b is null then return coalesce(vars->>'clinic','')||': update'; end if;
  for r in select key, value from jsonb_each_text(vars) loop b := replace(b, '{'||r.key||'}', coalesce(r.value,'')); end loop;
  return b;
end $$;

-- same texts as before, now taken from the templates above
create or replace function msg_text(k text, v visits, n int default 0) returns text
language plpgsql stable security definer set search_path=public as $$
declare dn text := (select name from doctors where id=v.doctor_id);
        site text := coalesce((select nullif(value,'') from settings where key='site_url'),'');
        vars jsonb;
begin
  vars := jsonb_build_object('clinic',clinic(),'name',split_part(v.name,' ',1),'doctor',dn,'token','T-'||lpad(v.token::text,2,'0'),'bill',v.bill,
            'n',n,'s',case when n=1 then '' else 's' end,'link',case when site<>'' then ' Track your turn: '||site else '' end);
  return case k
    when 'ahead' then tpl(case when n=0 then 'ahead_next' else 'ahead' end, vars)
    when 'registered' then tpl('registered',vars) when 'called' then tpl('called',vars)
    when 'report_ready' then tpl('report_ready',vars) when 'recall' then tpl('recall',vars)
    else clinic()||': update for '||v.bill end;
end $$;

-- ---------- appointment-side helpers (used from v16) ----------
create or replace function enqueue_appt_msg(a appointments, k text, body text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not a.consent_sms or length(trim(a.phone))<6 then return; end if;
  insert into outbox(appointment_id,kind,phone,body) values(a.id,k,a.phone,body) on conflict (appointment_id,kind) where appointment_id is not null do nothing;
end $$;

-- ---------- message status for reception: "did the patient get told?" ----------
create or replace function msg_status(p_visit_ids bigint[]) returns json language plpgsql stable security definer set search_path=public as $$
begin
  if my_role() not in ('reception','admin') then raise exception 'not allowed'; end if;
  return coalesce((select json_object_agg(v.id, json_build_object(
      'sms', case when not v.consent_sms then 'off' else coalesce((select o.status from outbox o where o.visit_id=v.id order by o.id desc limit 1),'none') end,
      'kind', (select o.kind from outbox o where o.visit_id=v.id order by o.id desc limit 1)))
    from visits v where v.id = any(p_visit_ids[1:200])), '{}'::json);
end $$;
revoke all on function msg_status(bigint[]) from public, anon; grant execute on function msg_status(bigint[]) to authenticated;

-- ---------- day-before reminders ----------
-- Calls every reminder function that exists (v15 follow-ups, v16 appointments). Run it once a day by cron, or from the button in Admin > Messages.
create or replace function queue_all_reminders() returns json language plpgsql security definer set search_path=public as $$
declare out jsonb := '{}'::jsonb; n int; f text;
begin
  if auth.uid() is not null and coalesce(my_role(),'') not in ('reception','admin') then raise exception 'not allowed'; end if;   -- cron (no login) is allowed
  foreach f in array array['queue_followup_reminders','queue_appt_reminders'] loop
    if to_regprocedure(f||'()') is not null then execute format('select %I()', f) into n; out := out || jsonb_build_object(f, n); end if;
  end loop;
  return out::json;
end $$;
revoke all on function queue_all_reminders() from public, anon; grant execute on function queue_all_reminders() to authenticated;
-- Daily automatic run (pg_cron, 4 pm Nepal time = 10:15 UTC). Run once in the SQL editor if you use pg_cron:
-- select cron.schedule('carepulse-reminders', '15 10 * * *', $$ select queue_all_reminders() $$);

-- >>>>>>>>>> CLINICAL: step 5
-- ===== v15 / STEP 5: clinical notes, vitals, printable prescription, follow-up =====
-- Run after v14. Safe to re-run.

insert into settings(key,value) values ('clinic_address',''),('clinic_phone','') on conflict (key) do nothing;
alter table doctors add column if not exists reg_no text;     -- Nepal Medical Council number, printed on the prescription

create table if not exists consultations(
  id bigint generated always as identity primary key,
  visit_id bigint not null unique references visits(id) on delete cascade,
  doctor_id text not null references doctors(id),
  bp_sys int check (bp_sys between 50 and 300), bp_dia int check (bp_dia between 30 and 200),
  pulse int check (pulse between 20 and 250),
  temp_c numeric(4,1) check (temp_c between 30 and 45),
  spo2 int check (spo2 between 50 and 100),
  weight_kg numeric(5,1) check (weight_kg between 0.5 and 400),
  complaint text, diagnosis text, notes text, advice text,
  follow_up_date date,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid);
alter table consultations enable row level security;
-- no policies on purpose: clinical text is only reachable through the functions below.
-- (consultations is NOT attached to the generic audit trigger, which would copy diagnoses into the audit log;
--  the functions write audit entries with ids only.)

create or replace function nz(p jsonb, k text) returns text language sql immutable as $$ select nullif(trim(p->>k),'') $$;

create or replace function can_clinical(p_visit bigint) returns boolean language sql stable security definer set search_path=public as $$
  select case my_role() when 'admin' then true
    when 'doctor' then exists(select 1 from visits where id=p_visit and doctor_id=my_doctor()) else false end
$$;

-- ---------- save (draft any time; the treating doctor, or admin) ----------
create or replace function save_consult(p_visit bigint, p jsonb) returns json language plpgsql security definer set search_path=public as $$
declare v visits; fu date := nullif(p->>'follow_up_date','')::date; c consultations;
        d date := (now() at time zone 'Asia/Kathmandu')::date;
begin
  if not can_clinical(p_visit) then raise exception 'not allowed'; end if;
  select * into v from visits where id=p_visit;
  if v.visit_date < d-1 and my_role()<>'admin' then raise exception 'this visit is closed for editing (ask admin)'; end if;
  if fu is not null and (fu < d or fu > d+365) then raise exception 'follow-up date must be within the next year'; end if;
  insert into consultations(visit_id,doctor_id,bp_sys,bp_dia,pulse,temp_c,spo2,weight_kg,complaint,diagnosis,notes,advice,follow_up_date,updated_by)
  values(p_visit, v.doctor_id, nz(p,'bp_sys')::int, nz(p,'bp_dia')::int, nz(p,'pulse')::int, nz(p,'temp_c')::numeric, nz(p,'spo2')::int, nz(p,'weight_kg')::numeric,
         left(nz(p,'complaint'),300), left(nz(p,'diagnosis'),300), left(nz(p,'notes'),4000), left(nz(p,'advice'),1500), fu, auth.uid())
  on conflict (visit_id) do update set bp_sys=excluded.bp_sys,bp_dia=excluded.bp_dia,pulse=excluded.pulse,temp_c=excluded.temp_c,spo2=excluded.spo2,
     weight_kg=excluded.weight_kg,complaint=excluded.complaint,diagnosis=excluded.diagnosis,notes=excluded.notes,advice=excluded.advice,
     follow_up_date=excluded.follow_up_date,updated_at=now(),updated_by=auth.uid()
  returning * into c;
  perform audit_write(auth.uid(),'CONSULT_SAVE','visits',p_visit::text,'{}'::jsonb);
  return json_build_object('saved_at',c.updated_at);
exception when check_violation then raise exception 'a vital sign is outside the possible range: please check the numbers';
          when invalid_text_representation or numeric_value_out_of_range then raise exception 'please enter numbers only in the vitals';
end $$;
revoke all on function save_consult(bigint,jsonb) from public, anon; grant execute on function save_consult(bigint,jsonb) to authenticated;

create or replace function get_consult(p_visit bigint) returns json language plpgsql stable security definer set search_path=public as $$
declare c consultations;
begin
  if not can_clinical(p_visit) then raise exception 'not allowed'; end if;
  select * into c from consultations where visit_id=p_visit;
  if not found then return null; end if;
  return json_build_object('bp_sys',c.bp_sys,'bp_dia',c.bp_dia,'pulse',c.pulse,'temp_c',c.temp_c,'spo2',c.spo2,'weight_kg',c.weight_kg,
    'complaint',c.complaint,'diagnosis',c.diagnosis,'notes',c.notes,'advice',c.advice,'follow_up_date',c.follow_up_date,'saved_at',c.updated_at);
end $$;
revoke all on function get_consult(bigint) from public, anon; grant execute on function get_consult(bigint) to authenticated;

-- ---------- doctor's registration number ----------
create or replace function set_reg_no(p_doctor text, p_reg text) returns void language plpgsql security definer set search_path=public as $$
begin
  if not (my_role()='admin' or (my_role()='doctor' and p_doctor=my_doctor())) then raise exception 'not allowed'; end if;
  update doctors set reg_no=nullif(left(trim(p_reg),30),'') where id=p_doctor;
  perform audit_write(auth.uid(),'DOCTOR_REG_NO','doctors',p_doctor,'{}'::jsonb);
end $$;
revoke all on function set_reg_no(text,text) from public, anon; grant execute on function set_reg_no(text,text) to authenticated;

-- ---------- everything the printed prescription needs, in one call ----------
create or replace function rx_print_data(p_visit bigint) returns json language plpgsql stable security definer set search_path=public as $$
declare v visits; d doctors; pt patients; c json;
begin
  if not can_clinical(p_visit) then raise exception 'not allowed'; end if;
  select * into v from visits where id=p_visit; select * into d from doctors where id=v.doctor_id;
  select * into pt from patients where id=v.patient_id;
  c := get_consult(p_visit);
  perform audit_write(auth.uid(),'RX_PRINT','visits',p_visit::text,'{}'::jsonb);
  return json_build_object(
    'clinic',json_build_object('name',clinic(),'address',(select value from settings where key='clinic_address'),'phone',(select value from settings where key='clinic_phone')),
    'doctor',json_build_object('name',d.name,'dept',d.dept,'reg_no',d.reg_no),
    'patient',json_build_object('name',v.name,'age',coalesce(v.age,pt.age),'sex',pt.sex,'patient_no',pt.patient_no,'allergies',v.allergies),
    'visit',json_build_object('date',v.visit_date,'bill',v.bill,'token',v.token),
    'consult',c,
    'items',coalesce((select json_agg(json_build_object('drug',dr.name,'strength',dr.strength,'form',dr.form,'dose',i.dose,'days',i.days,'qty',i.qty) order by i.id)
        from prescriptions r join prescription_items i on i.rx_id=r.id join drugs dr on dr.id=i.drug_id
        where r.visit_id=p_visit and r.status<>'cancelled'),'[]'::json));
end $$;
revoke all on function rx_print_data(bigint) from public, anon; grant execute on function rx_print_data(bigint) to authenticated;

-- ---------- patient history now also carries diagnosis + follow-up (doctor / admin only) ----------
drop function if exists patient_history(bigint);   -- merge: base version used parameter p_visit, patient version uses p_patient
create or replace function patient_history(p_patient bigint) returns json language plpgsql security definer set search_path=public as $$
declare r text := my_role(); pt patients; out json;
begin
  if r not in ('reception','doctor','admin') then raise exception 'not allowed'; end if;
  select * into pt from patients where id=p_patient and not erased;
  if not found then raise exception 'patient not found'; end if;
  if r='doctor' and not exists(select 1 from visits where patient_id=p_patient and doctor_id=my_doctor())
    then raise exception 'this is not your patient'; end if;
  perform audit_write(auth.uid(),'PATIENT_VIEW','patients',p_patient::text,'{}'::jsonb);
  select json_agg(json_build_object('id',v.id,'date',v.visit_date,'bill',case when r='doctor' then null else v.bill end,
           'doctor',d.name,'reason',v.reason,'status',v.status,'test_name',v.test_name,
           'report_path',case when r in ('doctor','admin') then v.report_path end,'has_report',v.report_path is not null,
           'paid',v.paid_at is not null,
           'total',case when r in ('reception','admin') then (select coalesce(sum(amount),0) from bill_items b where b.visit_id=v.id) end,
           'diagnosis',case when r in ('doctor','admin') then c.diagnosis end,
           'follow_up',case when r in ('doctor','admin') then c.follow_up_date end)
         order by v.created_at desc) into out
    from visits v join doctors d on d.id=v.doctor_id left join consultations c on c.visit_id=v.id where v.patient_id=p_patient;
  return json_build_object('patient',json_build_object('id',pt.id,'patient_no',pt.patient_no,'name',pt.name,'phone',pt.phone,
           'age',pt.age,'sex',pt.sex,'allergies',pt.allergies,'since',pt.created_at),
         'visits',coalesce(out,'[]'::json));
end $$;
revoke all on function patient_history(bigint) from public, anon; grant execute on function patient_history(bigint) to authenticated;

-- ---------- retention: notes go when the visit is anonymised ----------
create or replace function consult_follow_retention() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.name='[removed]' and old.name is distinct from '[removed]' then delete from consultations where visit_id=new.id; end if;
  return new;
end $$;
drop trigger if exists visits_consult_retention on visits;
create trigger visits_consult_retention after update of name on visits for each row execute function consult_follow_retention();

-- ---------- follow-up reminders (called by queue_all_reminders from v14) ----------
create or replace function queue_followup_reminders() returns int language plpgsql security definer set search_path=public as $$
declare tm date := (now() at time zone 'Asia/Kathmandu')::date + 1; r record; vv visits; n int := 0; before int;
begin
  for r in select v.id as vid, c.follow_up_date as fu from consultations c join visits v on v.id=c.visit_id
           where c.follow_up_date=tm and v.consent_sms and v.name<>'[removed]' loop
    select * into vv from visits where id=r.vid;
    select count(*) into before from outbox where visit_id=vv.id and kind='followup';
    perform enqueue_msg(vv, 'followup', tpl('followup', jsonb_build_object('clinic',clinic(),'name',split_part(vv.name,' ',1),
            'doctor',(select name from doctors where id=vv.doctor_id),'date',to_char(r.fu,'Dy DD Mon'))));
    if before=0 then n := n+1; end if;
  end loop;
  return n;
end $$;
revoke all on function queue_followup_reminders() from public, anon, authenticated;

-- >>>>>>>>>> APPOINTMENTS: step 6
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

-- >>>>>>>>>> TRIAGE: step 7
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
declare v visits; d doctors; b text := norm_bill(p_bill); pos int; q int; r int; tot numeric; rx text;   -- merge: norm_bill keeps short bill numbers (12, bl12, BL-0012) working
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

-- >>>>>>>>>> X-RAY module
-- RADIX AI X-ray module (standalone). Paste into Supabase > SQL Editor > Run. Safe to re-run.
-- Everything is prefixed xray_ so it cannot collide with the main HMS tables.
-- There is NO column or storage bucket for images. Only report text is kept.
--
-- Rules enforced here (not only in the screens):
--   * only the server function (service_role) can create a report
--   * a patient sees findings only after a registered doctor releases them
--   * the original AI draft can never be edited; the doctor writes a separate final version
--   * released and rejected reports are locked

-- ---------- who may review ----------
create table if not exists xray_reviewers(
  user_id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(trim(full_name)) >= 2),
  registration_no text not null check (length(trim(registration_no)) >= 1),   -- medical council number, printed on the report
  active boolean not null default true);

create or replace function xray_is_reviewer() returns boolean
language sql stable security definer set search_path=public as
$$ select exists(select 1 from xray_reviewers where user_id = auth.uid() and active) $$;

-- ---------- reports ----------
create table if not exists xray_reports(
  id bigint generated always as identity primary key,
  ref text not null unique,                        -- patient's report number, XR-XXXXXXXX
  code_hash text not null,                         -- access code is never stored in clear text
  patient_name text not null,
  phone text not null,
  age int not null check (age between 0 and 120),
  sex text not null check (sex in ('female','male','other')),
  body_part text not null,
  side text not null check (side in ('left','right','both','na')),
  symptoms text,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),  -- fingerprint of the uploaded file; the file is not stored
  consent_version text not null,
  consent_at timestamptz not null default now(),
  ai_result jsonb not null,                        -- original AI draft (immutable)
  ai_model text not null,
  prompt_version text not null,
  ai_urgency text not null check (ai_urgency in ('routine','soon','urgent')),
  status text not null default 'pending_review' check (status in ('pending_review','released','rejected')),
  final_report jsonb,                              -- what the doctor approved; the only findings a patient can see
  reviewer_id uuid,
  reviewer_name text,
  reviewer_reg_no text,
  reviewed_at timestamptz,
  reject_reason text,
  visit_id bigint,                                 -- reserved: link to the HMS visits table when the systems are joined
  created_at timestamptz not null default now(),
  constraint xray_release_needs_reviewer check (
    status <> 'released' or (final_report is not null and reviewer_id is not null and reviewer_name is not null and reviewed_at is not null)));
create index if not exists xray_reports_queue_idx on xray_reports(status, created_at);

create or replace function xray_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending_review' or new.final_report is not null then
      raise exception 'a new report must start as pending review';
    end if;
    return new;
  end if;
  if old.status <> 'pending_review' then
    -- only the future HMS link may be added to a locked report
    if (to_jsonb(new) - 'visit_id') is distinct from (to_jsonb(old) - 'visit_id') then
      raise exception 'this report is locked';
    end if;
  elsif new.ai_result is distinct from old.ai_result or new.ai_model is distinct from old.ai_model
     or new.file_sha256 is distinct from old.file_sha256 or new.ref is distinct from old.ref then
    raise exception 'the original AI draft cannot be changed';
  end if;
  return new;
end $$;
drop trigger if exists xray_reports_guard on xray_reports;
create trigger xray_reports_guard before insert or update on xray_reports for each row execute function xray_guard();

-- ---------- event log (append-only, no patient details) ----------
create table if not exists xray_events(
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  report_id bigint, actor uuid, action text not null);
create or replace function xray_events_block() returns trigger language plpgsql as
$$ begin raise exception 'the event log is append-only'; end $$;
drop trigger if exists xray_events_noedit on xray_events;
create trigger xray_events_noedit before update or delete on xray_events for each row execute function xray_events_block();

-- ---------- limits ----------
create table if not exists xray_scan_log(id bigint generated always as identity primary key, ip_hash text not null, at timestamptz not null default now());
create index if not exists xray_scan_log_idx on xray_scan_log(at);
create table if not exists xray_lookup_fails(ref text not null, at timestamptz not null default now());
create table if not exists xray_limits(id boolean primary key default true check (id), per_ip_hour int not null default 5, per_day int not null default 100);
insert into xray_limits(id) values (true) on conflict do nothing;

-- ---------- access: tables are closed; everything goes through the functions below ----------
alter table xray_reviewers enable row level security;
alter table xray_reports enable row level security;
alter table xray_events enable row level security;
alter table xray_scan_log enable row level security;
alter table xray_lookup_fails enable row level security;
alter table xray_limits enable row level security;
revoke all on xray_reviewers, xray_reports, xray_events, xray_scan_log, xray_lookup_fails, xray_limits from anon, authenticated;

-- ---------- server only: reserve one scan (protects your AI bill) ----------
create or replace function xray_reserve_scan(p_ip_hash text) returns text
language plpgsql security definer set search_path=public as $$
declare l xray_limits;
begin
  perform pg_advisory_xact_lock(727101);
  select * into l from xray_limits;
  delete from xray_scan_log where at < now() - interval '2 days';
  if (select count(*) from xray_scan_log where ip_hash = p_ip_hash and at > now() - interval '1 hour') >= l.per_ip_hour then return 'ip_limit'; end if;
  if (select count(*) from xray_scan_log where at > now() - interval '24 hours') >= l.per_day then return 'day_limit'; end if;
  insert into xray_scan_log(ip_hash) values (p_ip_hash);
  return 'ok';
end $$;

-- ---------- server only: save the AI draft ----------
create or replace function xray_code_hash(p_ref text, p_code text) returns text language sql immutable as
$$ select encode(sha256(convert_to(p_ref || ':' || p_code, 'UTF8')), 'hex') $$;

create or replace function xray_save_report(p jsonb) returns json
language plpgsql security definer set search_path=public as $$
declare v_ref text; v_code text; v_id bigint;
begin
  loop
    v_ref := 'XR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists(select 1 from xray_reports where ref = v_ref);
  end loop;
  -- 8 digits from a cryptographically random UUID
  v_code := lpad(((('x' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))::bit(48)::bigint) % 100000000)::text, 8, '0');
  insert into xray_reports(ref, code_hash, patient_name, phone, age, sex, body_part, side, symptoms, file_sha256,
                           consent_version, ai_result, ai_model, prompt_version, ai_urgency)
  values (v_ref, xray_code_hash(v_ref, v_code), left(trim(p->>'patient_name'), 80), left(trim(p->>'phone'), 20), (p->>'age')::int,
          p->>'sex', left(p->>'body_part', 40), p->>'side', nullif(left(trim(coalesce(p->>'symptoms', '')), 500), ''),
          p->>'file_sha256', p->>'consent_version', p->'ai_result', p->>'ai_model', p->>'prompt_version', p->'ai_result'->>'urgency')
  returning id into v_id;
  insert into xray_events(report_id, action) values (v_id, 'AI_DRAFT_SAVED');
  return json_build_object('ref', v_ref, 'code', v_code);
end $$;

-- ---------- patient: report number + code ----------
create or replace function xray_lookup(p_ref text, p_code text) returns json
language plpgsql security definer set search_path=public as $$
declare r xray_reports; v_ref text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g')); base jsonb;
begin
  if v_ref !~ '^XR-?[0-9A-F]{8}$' then return null; end if;
  v_ref := 'XR-' || right(v_ref, 8);
  perform pg_advisory_xact_lock(hashtext('xray:' || v_ref));       -- parallel guesses cannot slip past the lockout
  delete from xray_lookup_fails where at < now() - interval '1 day';
  if (select count(*) from xray_lookup_fails where ref = v_ref and at > now() - interval '15 minutes') >= 5
    then return json_build_object('locked', true); end if;
  select * into r from xray_reports where ref = v_ref and code_hash = xray_code_hash(v_ref, trim(coalesce(p_code, '')));
  if not found then insert into xray_lookup_fails(ref) values (v_ref); return null; end if;
  base := jsonb_build_object('ref', r.ref, 'status', r.status, 'created_at', r.created_at,
                             'body_part', r.body_part, 'side', r.side);
  if r.status = 'released' then
    base := base || jsonb_build_object('patient_name', r.patient_name, 'age', r.age, 'sex', r.sex, 'report', r.final_report,
      'reviewer_name', r.reviewer_name, 'reviewer_reg_no', r.reviewer_reg_no, 'reviewed_at', r.reviewed_at);
    insert into xray_events(report_id, action) values (r.id, 'PATIENT_VIEWED');
  end if;
  return base::json;
end $$;

-- ---------- doctor ----------
create or replace function xray_me() returns json language sql stable security definer set search_path=public as
$$ select json_build_object('full_name', full_name, 'registration_no', registration_no)
   from xray_reviewers where user_id = auth.uid() and active $$;

create or replace function xray_queue(p_status text default 'pending_review') returns json
language plpgsql security definer set search_path=public as $$
begin
  if not xray_is_reviewer() then raise exception 'reviewers only'; end if;
  return coalesce((select json_agg(t) from (
    select id, ref, patient_name, age, sex, body_part, side, ai_urgency, status, created_at
    from xray_reports where status = p_status
    order by case when p_status = 'pending_review' then case ai_urgency when 'urgent' then 0 when 'soon' then 1 else 2 end end,
             case when p_status = 'pending_review' then created_at end,
             reviewed_at desc
    limit 100) t), '[]'::json);
end $$;

create or replace function xray_get(p_id bigint) returns json
language plpgsql security definer set search_path=public as $$
declare r xray_reports;
begin
  if not xray_is_reviewer() then raise exception 'reviewers only'; end if;
  select * into r from xray_reports where id = p_id;
  if not found then raise exception 'report not found'; end if;
  insert into xray_events(report_id, actor, action) values (r.id, auth.uid(), 'REVIEWER_OPENED');
  return (to_jsonb(r) - 'code_hash')::json;
end $$;

create or replace function xray_release(p_id bigint, p_final jsonb, p_examined_original boolean) returns void
language plpgsql security definer set search_path=public as $$
declare me xray_reviewers; clean jsonb;
begin
  select * into me from xray_reviewers where user_id = auth.uid() and active;
  if not found then raise exception 'reviewers only'; end if;
  if p_examined_original is not true then raise exception 'confirm that you examined the original X-ray'; end if;
  if jsonb_typeof(p_final->'findings') is distinct from 'array'
     or jsonb_typeof(p_final->'recommendations') is distinct from 'array'
     or length(trim(coalesce(p_final->>'impression', ''))) < 3
     or length(trim(coalesce(p_final->>'patient_summary', ''))) < 3
     or coalesce(p_final->>'urgency', '') not in ('routine','soon','urgent') then
    raise exception 'the report needs findings, an impression, a patient summary and an urgency';
  end if;
  if length(p_final::text) > 30000 then raise exception 'the report is too long'; end if;
  -- keep only the known fields
  clean := jsonb_build_object('findings', p_final->'findings', 'impression', p_final->>'impression',
    'patient_summary', p_final->>'patient_summary', 'recommendations', p_final->'recommendations',
    'limitations', coalesce(p_final->'limitations', '[]'::jsonb), 'urgency', p_final->>'urgency');
  update xray_reports set status = 'released', final_report = clean, reviewer_id = me.user_id,
    reviewer_name = me.full_name, reviewer_reg_no = me.registration_no, reviewed_at = now()
  where id = p_id and status = 'pending_review';
  if not found then raise exception 'this report was already reviewed'; end if;
  insert into xray_events(report_id, actor, action) values (p_id, auth.uid(), 'RELEASED');
end $$;

create or replace function xray_reject(p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path=public as $$
begin
  if not xray_is_reviewer() then raise exception 'reviewers only'; end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then raise exception 'give a reason'; end if;
  update xray_reports set status = 'rejected', reject_reason = left(trim(p_reason), 500),
    reviewer_id = auth.uid(), reviewed_at = now()
  where id = p_id and status = 'pending_review';
  if not found then raise exception 'this report was already reviewed'; end if;
  insert into xray_events(report_id, actor, action) values (p_id, auth.uid(), 'REJECTED');
end $$;

-- ---------- function permissions (Supabase grants EXECUTE to everyone by default, so revoke first) ----------
revoke all on function xray_is_reviewer(), xray_reserve_scan(text), xray_code_hash(text,text), xray_save_report(jsonb),
  xray_lookup(text,text), xray_me(), xray_queue(text), xray_get(bigint), xray_release(bigint,jsonb,boolean), xray_reject(bigint,text),
  xray_guard(), xray_events_block()
  from public, anon, authenticated;
grant execute on function xray_reserve_scan(text), xray_save_report(jsonb) to service_role;
grant execute on function xray_lookup(text,text) to anon, authenticated;
grant execute on function xray_me(), xray_queue(text), xray_get(bigint), xray_release(bigint,jsonb,boolean), xray_reject(bigint,text) to authenticated;
