-- Carepulse HMS v4 (Admin screen) — run AFTER schema.sql + schema_v3.sql (or setup.sql). Safe to re-run.

-- doctors can be hidden instead of deleted (past visits keep pointing at them)
alter table doctors add column if not exists active boolean not null default true;

-- admin-only list of staff with their login email (emails live in auth.users, which the browser cannot read)
create or replace function admin_list_staff()
returns table(id uuid, email text, full_name text, role text, doctor_id text, last_sign_in_at timestamptz)
language plpgsql security definer set search_path=public as $$
begin
  if my_role() is distinct from 'admin' then raise exception 'admins only'; end if;
  return query
    select p.id, u.email::text, p.full_name, p.role, p.doctor_id, u.last_sign_in_at
    from profiles p join auth.users u on u.id = p.id
    order by (p.role <> 'admin'), p.role, p.full_name;
end $$;
revoke all on function admin_list_staff() from public, anon;
grant execute on function admin_list_staff() to authenticated;
