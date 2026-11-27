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
