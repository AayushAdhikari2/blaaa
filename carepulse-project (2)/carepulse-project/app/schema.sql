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
