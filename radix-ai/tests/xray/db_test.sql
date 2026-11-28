-- Run on an empty database after stub.sql and sql/xray_setup.sql. Prints one line per check; any FAIL is a problem.
\set QUIET on
\pset tuples_only on
\pset format unaligned
create schema t; create table t.res(n serial, name text, ok boolean); create table t.v(k text primary key, v text);
grant usage on schema t to anon, authenticated, service_role; grant all on all tables in schema t to anon, authenticated, service_role; grant all on all sequences in schema t to anon, authenticated, service_role;
create function t.ok(name text, c boolean) returns void language sql as $$ insert into t.res(name,ok) values(name, coalesce(c,false)) $$;
create function t.fails(name text, q text) returns void language plpgsql as $$
begin execute q; perform t.ok(name,false); exception when others then perform t.ok(name,true); end $$;
create function t.payload(urg text) returns jsonb language sql as $$ select jsonb_build_object('patient_name','Test Person','phone','9800000000','age',30,'sex','female','body_part','chest','side','na','symptoms','cough',
 'file_sha256',repeat('a',64),'consent_version','v1','ai_model','m','prompt_version','p','ai_result',jsonb_build_object('urgency',urg,'impression','SECRET-DRAFT')) $$;
create function t.final() returns jsonb language sql as $$ select '{"findings":[],"impression":"Doctor impression","patient_summary":"Doctor summary","recommendations":[],"limitations":[],"urgency":"routine","extra":"drop me"}'::jsonb $$;
insert into auth.users(id,email) values ('00000000-0000-0000-0000-00000000000d','doc@x'),('00000000-0000-0000-0000-00000000000e','other@x');
insert into xray_reviewers(user_id,full_name,registration_no) values ('00000000-0000-0000-0000-00000000000d','Dr Test','NMC-1');

select t.ok('no image column or bytea column', not exists(select 1 from information_schema.columns where table_name like 'xray\_%' and (data_type='bytea' or column_name ~* 'image|photo|picture|base64')));

set role anon;
select t.fails('anon cannot create a report', $q$select xray_save_report(t.payload('routine'))$q$);
select t.fails('anon cannot reserve a scan', $q$select xray_reserve_scan('x')$q$);
select t.fails('anon cannot read reports table', 'select * from xray_reports');
select t.fails('anon cannot make itself reviewer', $q$insert into xray_reviewers values (gen_random_uuid(),'Bad','1')$q$);
select t.fails('anon cannot open the queue', 'select xray_queue()');
select t.fails('anon cannot release', 'select xray_release(1, t.final(), true)');
reset role;

set role authenticated; set request.jwt.claims='{"sub":"00000000-0000-0000-0000-00000000000e"}';
select t.fails('non-reviewer login cannot create a report', $q$select xray_save_report(t.payload('routine'))$q$);
select t.fails('non-reviewer cannot open the queue', 'select xray_queue()');
select t.fails('non-reviewer cannot read a report', 'select xray_get(1)');
select t.fails('non-reviewer cannot release', 'select xray_release(1, t.final(), true)');
select t.fails('logged-in user cannot read reports table', 'select * from xray_reports');
reset role;

set role service_role;
insert into t.v select 'r1', xray_save_report(t.payload('routine'))::text;
insert into t.v select 'r2', xray_save_report(t.payload('urgent'))::text;
reset role;
select t.ok('ref and 8-digit code format', (v::json->>'ref') ~ '^XR-[0-9A-F]{8}$' and (v::json->>'code') ~ '^[0-9]{8}$') from t.v where k='r1';
select t.ok('code is stored hashed', not exists(select 1 from xray_reports r, t.v where t.v.k='r1' and r.code_hash = v::json->>'code'));

set role anon;
select t.ok('patient sees pending only: no draft, name or urgency', j->>'status'='pending_review' and j::text !~ 'SECRET-DRAFT|Test Person|urgency')
  from (select xray_lookup(v::json->>'ref', v::json->>'code')::jsonb j from t.v where k='r1') s;
select t.ok('lookup accepts lower case without dash', xray_lookup(lower(replace(v::json->>'ref','-','')), v::json->>'code') is not null) from t.v where k='r1';
reset role;

set role authenticated; set request.jwt.claims='{"sub":"00000000-0000-0000-0000-00000000000d"}';
select t.ok('urgent is first in the queue', (xray_queue()->0->>'ai_urgency')='urgent');
select t.ok('reviewer gets draft but not code hash', j ? 'ai_result' and not j ? 'code_hash') from (select xray_get(1)::jsonb j) s;
select t.fails('release needs the examined-original confirmation', 'select xray_release(1, t.final(), false)');
select t.fails('release needs confirmation not null', 'select xray_release(1, t.final(), null)');
select t.fails('release rejects an incomplete report', $q$select xray_release(1, '{"impression":"x"}', true)$q$);
select t.fails('release rejects missing findings', $q$select xray_release(1, t.final() - 'findings', true)$q$);
select xray_release(1, t.final(), true);
select t.fails('cannot release twice', 'select xray_release(1, t.final(), true)');
select t.fails('cannot reject after release', $q$select xray_reject(1,'changed mind')$q$);
select t.fails('reject needs a reason', $q$select xray_reject(2,'')$q$);
select xray_reject(2,'blurred film');
select t.fails('cannot release a rejected report', 'select xray_release(2, t.final(), true)');
select t.fails('reviewer cannot update table directly', $q$update xray_reports set status='released'$q$);
reset role; reset request.jwt.claims;

set role anon;
select t.ok('patient sees doctor version only', j->'report'->>'impression'='Doctor impression' and j->>'reviewer_reg_no'='NMC-1' and j::text !~ 'SECRET-DRAFT|drop me|ai_result')
  from (select xray_lookup(v::json->>'ref', v::json->>'code')::jsonb j from t.v where k='r1') s;
select t.ok('rejected shows no findings or reason', j->>'status'='rejected' and not j ? 'report' and j::text !~ 'blurred|SECRET')
  from (select xray_lookup(v::json->>'ref', v::json->>'code')::jsonb j from t.v where k='r2') s;
select xray_lookup(v::json->>'ref','x') from t.v, generate_series(1,5) where k='r1';
select t.ok('locked after 5 wrong codes, even with the right one', (xray_lookup(v::json->>'ref', v::json->>'code')->>'locked')='true') from t.v where k='r1';
reset role;

select t.fails('locked report cannot be edited even by table owner', $q$update xray_reports set final_report='{}' where id=1$q$);
update xray_reports set visit_id=7 where id=1;
select t.ok('HMS link can still be added later', (select visit_id=7 from xray_reports where id=1));
select t.fails('cannot insert an already released row', $q$insert into xray_reports(ref,code_hash,patient_name,phone,age,sex,body_part,side,file_sha256,consent_version,ai_result,ai_model,prompt_version,ai_urgency,status,final_report) values('XR-1','x','a','1',1,'male','chest','na',repeat('a',64),'v','{}','m','p','routine','released','{}')$q$);
insert into t.v select 'r3', xray_save_report(t.payload('soon'))::text;
select t.fails('AI draft is immutable while pending', $q$update xray_reports set ai_result='{}' where status='pending_review'$q$);
select t.fails('event log cannot be deleted', 'delete from xray_events');
select t.ok('events recorded', (select count(distinct action)>=5 from xray_events));

set role service_role;
select t.ok('per-connection limit: 5 then blocked', (select string_agg(xray_reserve_scan('ipA'), ',') from generate_series(1,6)) = 'ok,ok,ok,ok,ok,ip_limit');
reset role; update xray_limits set per_day=6; set role service_role;
select t.ok('daily limit applies across connections', xray_reserve_scan('ipB')='ok' and xray_reserve_scan('ipC')='day_limit');
reset role;
\pset tuples_only on
select case when ok then 'pass ' else 'FAIL ' end || name from t.res order by n;
select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' from t.res;
