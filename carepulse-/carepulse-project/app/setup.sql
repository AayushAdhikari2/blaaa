-- Carepulse HMS — ONE-FILE SETUP (steps 1-10). Paste all of this in Supabase > SQL Editor > Run.
-- = schema.sql + schema_v3..v10.sql in order. Safe to re-run.

-- >>>>>>>>>> schema.sql
-- Carepulse HMS v2 — run this whole file once in Supabase > SQL Editor

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
-- Carepulse HMS v3 — run AFTER schema.sql from v2. Safe to run once.

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
-- Carepulse HMS v4 (Admin screen) — run AFTER schema.sql + schema_v3.sql (or setup.sql). Safe to re-run.

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
-- Carepulse HMS v5 (private reports) — run AFTER v3/v4. Safe to re-run.
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
  ('clinic_name','Carepulse Clinic'),
  ('site_url',''),               -- e.g. https://yourclinic.example/app/  (used for QR codes and SMS links)
  ('ahead_threshold','2'),       -- send "N patients ahead" when N is this or lower
  ('retention_days','1095'),     -- step 9: anonymise visits older than this (check your legal retention rules!)
  ('require_mfa','false')        -- step 9: force two-factor login for all staff
on conflict (key) do nothing;
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
$$ select coalesce((select value from settings where key='clinic_name'),'Carepulse') $$;

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
-- select cron.schedule('carepulse-send', '* * * * *', $$ select net.http_post(
--   url := 'https://YOUR-PROJECT.supabase.co/functions/v1/send-messages',
--   headers := '{"Content-Type":"application/json","x-cron-secret":"YOUR-CRON-SECRET"}'::jsonb, body := '{}'::jsonb) $$);

-- >>>>>>>>>> schema_v7.sql
-- ===== v7: public queue board (TV in the waiting room) =====
-- Shows token numbers only. No names, no phone numbers, no bill numbers. Safe for the public.
create or replace function queue_board() returns json
language sql stable security definer set search_path=public as $$
  with t as (select (now() at time zone 'Asia/Kathmandu')::date as d)
  select json_build_object(
    'clinic', coalesce((select value from settings where key='clinic_name'),'Carepulse'),
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
