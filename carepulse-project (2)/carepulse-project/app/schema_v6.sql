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
