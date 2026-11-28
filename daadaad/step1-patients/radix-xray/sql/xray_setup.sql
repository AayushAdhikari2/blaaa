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
