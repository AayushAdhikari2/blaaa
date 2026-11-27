-- STEP A: in Supabase > Authentication > Users > "Add user" create 4 users
--         (tick "Auto Confirm User"). Use real emails you can remember.
-- STEP B: replace the emails below with yours, then run this file in the SQL Editor.
-- Roles: admin | reception | doctor | lab.  doctor_id: d1 = Dr. Sharma, d2 = Dr. Thapa, d3 = Dr. Gurung

insert into profiles(id, full_name, role, doctor_id)
select id, 'Admin',          'admin',     null from auth.users where email = 'admin@example.com'
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, doctor_id = excluded.doctor_id;

insert into profiles(id, full_name, role, doctor_id)
select id, 'Reception Desk', 'reception', null from auth.users where email = 'reception@example.com'
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, doctor_id = excluded.doctor_id;

insert into profiles(id, full_name, role, doctor_id)
select id, 'Dr. Sharma',     'doctor',    'd1' from auth.users where email = 'doctor@example.com'
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, doctor_id = excluded.doctor_id;

insert into profiles(id, full_name, role, doctor_id)
select id, 'Lab Desk',       'lab',       null from auth.users where email = 'lab@example.com'
on conflict (id) do update set role = excluded.role, full_name = excluded.full_name, doctor_id = excluded.doctor_id;

-- Check: should list 4 rows
select p.full_name, p.role, p.doctor_id, u.email from profiles p join auth.users u on u.id = p.id;
