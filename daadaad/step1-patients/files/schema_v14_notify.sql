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
