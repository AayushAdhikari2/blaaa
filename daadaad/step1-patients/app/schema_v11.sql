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

-- ---------- register_visit: now patient-aware ----------
drop function if exists register_visit(text,text,int,text,text,text,boolean,text);
drop function if exists register_visit(text,text,int,text,text,text,boolean,text,bigint);
create or replace function register_visit(p_name text,p_phone text,p_age int,p_reason text,p_doctor text,
  p_allergies text default null, p_consent_sms boolean default false, p_consent_version text default null,
  p_patient_id bigint default null)
returns visits language plpgsql security definer set search_path=public as $$
declare d date := (now() at time zone 'Asia/Kathmandu')::date; v visits; pt patients;
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
  values('BL-'||to_char(d,'YYYYMMDD')||'-'||lpad(nextval('bill_seq')::text,4,'0'),
         lpad(floor(100000+random()*900000)::int::text,6,'0'),
         nm,ph,p_age,left(p_reason,200),p_doctor,d,
         (select count(*)+1 from visits where doctor_id=p_doctor and visit_date=d),   -- token race is fixed in step 4
         coalesce(al, pt.allergies), coalesce(p_consent_sms,false), p_consent_version,
         case when p_consent_version is not null then now() end, pt.id)
  returning * into v;
  return v;
end $$;
revoke all on function register_visit(text,text,int,text,text,text,boolean,text,bigint) from public, anon;
grant execute on function register_visit(text,text,int,text,text,text,boolean,text,bigint) to authenticated;

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
