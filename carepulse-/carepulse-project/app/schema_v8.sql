-- ===== v8: reports and dashboard =====
-- Timestamps for waiting-time and report turnaround, plus admin-only summary and export functions.
alter table visits add column if not exists first_called_at timestamptz;
alter table visits add column if not exists done_at timestamptz;
alter table visits add column if not exists test_ordered_at timestamptz;
alter table visits add column if not exists report_ready_at timestamptz;

create or replace function stamp_visit() returns trigger language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if new.status='in_room' and new.first_called_at is null then new.first_called_at := now(); end if;
    if new.status='done' then new.done_at := now(); end if;
    if new.status='report_pending' then new.test_ordered_at := now(); new.report_ready_at := null; end if;
    if new.status='review' and old.status='report_pending' then new.report_ready_at := now(); end if;
  end if;
  return new;
end $$;
drop trigger if exists visits_stamp on visits;
create trigger visits_stamp before update on visits for each row execute function stamp_visit();

create or replace function report_summary(p_from date, p_to date) returns json
language plpgsql security definer set search_path=public as $$
declare r json;
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'choose a date range of up to one year'; end if;
  with vv as (
    select v.*, coalesce((select sum(amount) from bill_items b where b.visit_id=v.id),0) as billed
    from visits v where v.visit_date between p_from and p_to)
  select json_build_object(
    'from',p_from,'to',p_to,
    'totals',(select json_build_object(
        'visits',count(*),'completed',count(*) filter (where status='done'),
        'avg_wait_min',round(avg(extract(epoch from first_called_at-created_at)/60)::numeric,1),
        'avg_consult_min',round((avg(extract(epoch from done_at-first_called_at)/60) filter (where done_at is not null and first_called_at is not null))::numeric,1),
        'avg_report_min',round(avg(extract(epoch from report_ready_at-test_ordered_at)/60)::numeric,1),
        'billed',coalesce(sum(billed),0),
        'collected',coalesce(sum(billed) filter (where paid_at is not null),0),
        'unpaid',coalesce(sum(billed) filter (where paid_at is null),0),
        'unpaid_count',count(*) filter (where paid_at is null and billed>0)) from vv),
    'per_day',(select coalesce(json_agg(json_build_object('day',g.d::date,'visits',coalesce(x.n,0),'collected',coalesce(x.c,0)) order by g.d),'[]'::json)
        from generate_series(p_from::timestamp,p_to::timestamp,interval '1 day') g(d)
        left join (select visit_date, count(*) n, sum(billed) filter (where paid_at is not null) c from vv group by 1) x on x.visit_date=g.d::date),
    'per_doctor',(select coalesce(json_agg(json_build_object('doctor',d.name,'dept',d.dept,'visits',coalesce(s.n,0),
          'avg_wait_min',s.w,'collected',coalesce(s.c,0)) order by coalesce(s.n,0) desc, d.name),'[]'::json)
        from doctors d left join (select doctor_id, count(*) n,
            round(avg(extract(epoch from first_called_at-created_at)/60)::numeric,1) w,
            sum(billed) filter (where paid_at is not null) c from vv group by 1) s on s.doctor_id=d.id),
    'unpaid',(select coalesce(json_agg(u order by u.visit_date),'[]'::json) from (
        select bill,name,phone,visit_date,billed from vv where paid_at is null and billed>0 order by visit_date limit 100) u)
  ) into r;
  return r;
end $$;
revoke all on function report_summary(date,date) from public, anon;
grant execute on function report_summary(date,date) to authenticated;

-- one row per visit for CSV (no access codes; names and phones only when asked for)
create or replace function report_rows(p_from date, p_to date, p_pii boolean default false)
returns table(visit_date date, bill text, doctor text, dept text, status text, token int, wait_min numeric,
              consult_min numeric, report_min numeric, billed numeric, paid boolean, patient text, phone text)
language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'choose a date range of up to one year'; end if;
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
revoke all on function report_rows(date,date,boolean) from public, anon;
grant execute on function report_rows(date,date,boolean) to authenticated;
