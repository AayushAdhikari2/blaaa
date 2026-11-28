-- ===== v7: public queue board (TV in the waiting room) =====
-- Shows token numbers only. No names, no phone numbers, no bill numbers. Safe for the public.
create or replace function queue_board() returns json
language sql stable security definer set search_path=public as $$
  with t as (select (now() at time zone 'Asia/Kathmandu')::date as d)
  select json_build_object(
    'clinic', coalesce((select value from settings where key='clinic_name'),'Carepulse'),
    'at', now(),
    'doctors', coalesce((
      select json_agg(x order by x.name) from (
        select dr.name, dr.dept,
          coalesce((select json_agg(v.token order by v.q_at) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status='in_room'),'[]'::json) as serving,
          coalesce((select json_agg(q.token order by q.q_at) from (
              select v.token, v.q_at from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review')
              order by v.q_at limit 6) q),'[]'::json) as next,
          (select count(*) from visits v, t where v.doctor_id=dr.id and v.visit_date=t.d and v.status in ('waiting','review')) as waiting
        from doctors dr where dr.active order by dr.name) x),'[]'::json));
$$;
grant execute on function queue_board() to anon, authenticated;
