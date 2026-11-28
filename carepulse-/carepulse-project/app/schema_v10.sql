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
