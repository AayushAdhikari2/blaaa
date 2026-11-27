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
