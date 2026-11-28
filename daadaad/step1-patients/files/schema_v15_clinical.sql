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
