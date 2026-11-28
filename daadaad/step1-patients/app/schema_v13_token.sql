-- ===== v13 / STEP 3: token race fix =====
-- Run after v11 and v12. Safe to re-run.
-- Before: token = count(visits)+1, so two registrations at the same moment could both get the same token.
-- Now:    one counter row per doctor per day, increased atomically (the second registration waits a few milliseconds).

create table if not exists token_counter(
  doctor_id text not null references doctors(id),
  day date not null,
  last_token int not null default 0,
  primary key (doctor_id, day));
alter table token_counter enable row level security;   -- no policies: only next_token() touches it

-- start the counters from what already exists
insert into token_counter(doctor_id, day, last_token)
select doctor_id, visit_date, max(token) from visits group by 1,2
on conflict (doctor_id, day) do update set last_token = greatest(token_counter.last_token, excluded.last_token);

create or replace function next_token(p_doctor text, p_day date) returns int
language sql security definer set search_path=public as $$
  insert into token_counter(doctor_id, day, last_token) values (p_doctor, p_day, 1)
  on conflict (doctor_id, day) do update set last_token = token_counter.last_token + 1
  returning last_token
$$;
revoke all on function next_token(text,date) from public, anon, authenticated;

-- make a duplicate token impossible even if some other code path inserts visits.
-- (If old data already has duplicates from the race, the index is skipped with a notice: fix them, then re-run.)
do $$ begin
  if exists(select 1 from visits group by doctor_id, visit_date, token having count(*)>1) then
    raise notice 'Duplicate tokens already exist in old visits: unique index not created. Run: select doctor_id, visit_date, token, count(*) from visits group by 1,2,3 having count(*)>1;';
  else
    create unique index if not exists visits_token_uq on visits(doctor_id, visit_date, token);
  end if;
end $$;

-- register_visit: same as v11, only the token line changes
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
         next_token(p_doctor,d),
         coalesce(al, pt.allergies), coalesce(p_consent_sms,false), p_consent_version,
         case when p_consent_version is not null then now() end, pt.id)
  returning * into v;
  return v;
end $$;
revoke all on function register_visit(text,text,int,text,text,text,boolean,text,bigint) from public, anon;
grant execute on function register_visit(text,text,int,text,text,text,boolean,text,bigint) to authenticated;
