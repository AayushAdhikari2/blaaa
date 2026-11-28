# Notification system checks. Usage (fresh DB): psql -f stub.sql; psql -f ../../supabase/sql/setup.sql;
#   python3 gen_notify_test.py > notify_test.sql; psql -f notify_test.sql; then: select * from nt.res where not ok;
U = {'admin':'00000000-0000-0000-0000-0000000000a1','rec':'00000000-0000-0000-0000-0000000000a2','doc':'00000000-0000-0000-0000-0000000000a3',
     'doc2':'00000000-0000-0000-0000-0000000000a4','lab':'00000000-0000-0000-0000-0000000000a5','pha':'00000000-0000-0000-0000-0000000000a6'}
out = []
def sql(s): out.append(s)
def as_(who, aal='aal2'):
    if who == 'anon': sql("reset role; select set_config('request.jwt.claims','{}',false); set role anon;")
    elif who == 'pg': sql("reset role; select set_config('request.jwt.claims','{}',false);")
    else: sql(f"reset role; select set_config('request.jwt.claims','{{\"sub\":\"{U[who]}\",\"aal\":\"{aal}\"}}',false); set role authenticated;")
def ex(label, stmt, ok=True, has=None):
    h = "null" if has is None else "$q$" + has + "$q$"
    sql(f"select nt.expect($q${label}$q$, $q${stmt}$q$, {str(ok).lower()}, {h});")
def check(label, cond):
    sql(f"select nt.expect($q${label}$q$, $q$do $x$ begin if not coalesce(({cond}),false) then raise exception 'assertion false'; end if; end $x$$q$, true, null);")
def lst(kind, where='true'):   # number of notifications of this kind in the CURRENT user's list (pending + recent)
    return (f"(select count(*) from (select x from json_array_elements((notif_list(100))->'pending') x union all select x from json_array_elements((notif_list(100))->'recent') x) q "
            f"where x->>'kind'='{kind}' and ({where.replace('title','(x->>$$title$$)')}))")
def pend(kind): return f"(select count(*) from json_array_elements((notif_list(100))->'pending') x where x->>'kind'='{kind}')"

sql("""create schema nt; create table nt.res(n serial, label text, ok boolean, msg text);
grant usage on schema nt to public; grant all on nt.res to public; grant usage,select on all sequences in schema nt to public;
create function nt.expect(label text, q text, should_work boolean default true, must_contain text default null) returns void language plpgsql as $$
declare m text;
begin
  begin execute q; insert into nt.res(label,ok,msg) values(label, should_work, case when should_work then 'worked' else 'WORKED BUT SHOULD HAVE FAILED' end);
  exception when others then get stacked diagnostics m = message_text;
    insert into nt.res(label,ok,msg) values(label, (not should_work) and (must_contain is null or m ilike '%'||must_contain||'%'), m);
  end;
end $$;""")
for k, v in U.items(): sql(f"insert into auth.users(id,email) values('{v}','{k}@x.test');")
sql(f"""insert into profiles(id,full_name,role,doctor_id) values ('{U['admin']}','Admin','admin',null),('{U['rec']}','Rita Reception','reception',null),
 ('{U['doc']}','Dr Sharma','doctor','d1'),('{U['doc2']}','Dr Thapa','doctor','d2'),('{U['lab']}','Lab','lab',null),('{U['pha']}','Pharm','pharmacy',null);""")
sql("update drugs set active=true; delete from drug_stock;")

# ---- staff changes -> admin only
as_('admin'); check("admin sees 'staff account created' alerts", f"{lst('admin.staff')} >= 6")
as_('rec'); check("reception does NOT see admin alerts", f"{lst('admin.staff')} = 0")

# ---- reception registers -> that doctor only; no patient data in text
as_('rec'); ex("reception registers patient for Dr Sharma", "select register_visit('Zed Patient','9811122233',40,'cough','d1',null,false,'v1')")
as_('doc'); check("Dr Sharma is told about the new patient", f"{lst('queue.new')} = 1")
as_('doc2'); check("Dr Thapa is NOT told (other doctor)", f"{lst('queue.new')} = 0")
as_('lab'); check("lab is NOT told", f"{lst('queue.new')} = 0")
as_('rec'); check("reception is not notified of its own action", f"{lst('queue.new')} = 0")
as_('pg'); check("no notification text contains patient name or phone", "not exists (select 1 from notifications where title||' '||coalesce(body,'') ilike any(array['%zed%','%patient%9811%','%9811122233%']))")

# ---- doctor orders lab -> lab (persistent); report ready -> doctor
as_('doc'); ex("doctor calls patient in", "update visits set status='in_room' where name='Zed Patient'")
ex("doctor orders a test", "update visits set status='report_pending', test_name='Blood test', test_due=now()+interval '30 min' where name='Zed Patient'")
as_('lab'); check("lab sees a pinned lab request", f"{pend('lab.request')} = 1")
as_('pha'); check("pharmacy does not see lab requests", f"{lst('lab.request')} = 0")
as_('lab'); ex("lab marks report ready", "update visits set status='review', q_at=now() where name='Zed Patient'")
check("lab request is resolved (no longer pinned)", f"{pend('lab.request')} = 0")
as_('doc'); check("doctor gets a pinned 'report ready'", f"{pend('lab.report')} = 1")
as_('doc2'); check("other doctor does not", f"{lst('lab.report')} = 0")
as_('doc'); ex("doctor takes patient back in", "update visits set status='in_room' where name='Zed Patient'")
check("'report ready' resolved after doctor acts", f"{pend('lab.report')} = 0")

# ---- billing: unpaid after completion; paid resolves; reversal warns
as_('rec'); ex("reception adds a bill item", "insert into bill_items(visit_id,description,amount) select id,'Consultation',500 from visits where name='Zed Patient'")
as_('doc'); ex("doctor completes visit", "update visits set status='done' where name='Zed Patient'")
as_('rec'); check("reception sees pinned unpaid bill", f"{pend('billing.unpaid')} = 1")
ex("reception marks paid", "update visits set paid_at=now() where name='Zed Patient'")
check("unpaid reminder resolved", f"{pend('billing.unpaid')} = 0"); check("payment recorded notification", f"{lst('billing.paid')} = 1")
as_('admin'); check("admin sees payment too", f"{lst('billing.paid')} = 1")
as_('rec'); ex("reception reverses payment", "update visits set paid_at=null where name='Zed Patient'")
check("payment reversal creates a warning", f"{lst('billing.reversed')} = 1")

# ---- pharmacy: rx, dispense, stock
as_('rec'); ex("register second patient", "select register_visit('Amy Test','9822233344',30,'pain','d1',null,false,'v1')")
as_('doc'); ex("doctor calls in", "update visits set status='in_room' where name='Amy Test'")
as_('pha'); ex("pharmacy adds low stock", "select add_stock(1,'B1',current_date+200,5)")
check("pharmacy sees low-stock (pinned)", f"{pend('pharmacy.low_stock')} = 1")
as_('admin'); check("admin sees low-stock", f"{pend('pharmacy.low_stock')} = 1")
as_('rec'); check("reception does not see stock alerts", f"{lst('pharmacy.low_stock')} = 0")
as_('doc'); ex("doctor prescribes", "select create_rx((select id from visits where name='Amy Test'), '[{\"drug_id\":1,\"dose\":\"1\",\"days\":2,\"qty\":2}]')")
as_('pha'); check("pharmacy sees pinned prescription", f"{pend('pharmacy.rx')} = 1")
ex("pharmacy dispenses", "do $x$ begin perform dispense_rx((select max(id) from prescriptions)); end $x$")
check("prescription resolved after dispensing", f"{pend('pharmacy.rx')} = 0")
as_('rec'); check("reception told medicines dispensed", f"{lst('billing.dispensed')} = 1")
as_('pha'); ex("pharmacy restocks", "select add_stock(1,'B2',current_date+300,100)")
check("low stock resolved when restocked", f"{pend('pharmacy.low_stock')} = 0")
ex("batch expiring in 10 days", "select add_stock(2,'EXP1',current_date+10,40)")
check("expiring-soon alert", f"{pend('pharmacy.expiry')} = 1")
as_('pg'); sql("insert into drug_stock(drug_id,batch,expiry,qty) values (3,'OLD1',current_date-5,12);")
check("expired stock alert is critical", "exists (select 1 from notifications where kind='pharmacy.expiry' and severity='critical' and resolved_at is null)")
as_('pha'); ex("batch used up", "update drug_stock set qty=0 where batch='EXP1'")
check("expiring alert resolved when batch is used up", f"{pend('pharmacy.expiry')} = 1")   # only the expired one is left

# ---- appointments
as_('anon'); ex("patient requests appointment", "select request_appointment('Ann Online','9855566677','d2',current_date+3,'checkup',true,false)")
as_('rec'); check("reception sees pinned request", f"{pend('appt.request')} = 1")
as_('doc2'); check("doctor does not see the raw request", f"{lst('appt.request')} = 0")
as_('rec'); ex("reception confirms", "update appointments set status='confirmed', confirmed_at=now() where id=(select max(id) from appointments)")
check("request resolved after confirm", f"{pend('appt.request')} = 0")
as_('doc2'); check("Dr Thapa told about booked appointment", f"{lst('appt.booked')} >= 1")
as_('doc'); check("Dr Sharma not told", f"{lst('appt.booked')} = 0")

# ---- wards
as_('rec'); ex("admit patient", "select admit_patient((select id from visits where name='Amy Test'),'w1-1','obs')")
as_('doc'); check("owning doctor told of admission", f"{lst('ward.admit')} = 1")
as_('doc2'); check("other doctor not told", f"{lst('ward.admit')} = 0")
as_('rec'); ex("discharge patient", "select discharge_patient((select max(id) from admissions),'recovered')")
check("reception told of discharge + free bed", f"{lst('ward.discharge')} = 1")
as_('lab'); check("lab never sees ward alerts", f"{lst('ward.discharge')} = 0")

# ---- admin: privacy, security, sms
as_('anon'); ex("patient files privacy request", "select submit_privacy_request('access','Zed','9811122233',null,'copy please')")
as_('admin'); check("admin sees pinned privacy request", f"{pend('admin.privacy')} = 1")
as_('anon')
for i in range(6): sql("select patient_status('BL-NOPE','000000');")
as_('admin'); check("repeated wrong codes raise a critical security alert", f"{lst('security.lookup')} = 1")
check("security alert text has no bill number", "not exists (select 1 from notifications where kind='security.lookup' and body ilike '%NOPE%')")
as_('rec'); check("reception cannot see security alerts", f"{lst('security.lookup')} = 0")

# ---- read state
as_('rec'); sql("create temp table c0 as select (notif_list(100)->>'unread')::int n;")
check("unread counter matches list", "(select n from c0) = notif_unread_count() and notif_unread_count() > 0")
ex("mark one read", "select notif_mark(array[(select (x->>'id')::bigint from json_array_elements(notif_list(100)->'recent') x limit 1)], true)")
check("counter dropped by one", "notif_unread_count() = (select n from c0) - 1")
ex("mark it unread again", "select notif_mark(array[(select (x->>'id')::bigint from json_array_elements(notif_list(100)->'recent') x limit 1)], false)")
check("counter back", "notif_unread_count() = (select n from c0)")
ex("mark all read", "select notif_mark_all_read()"); check("counter is zero", "notif_unread_count() = 0")
as_('doc'); check("other users' read state is untouched", "notif_unread_count() > 0")

# ---- ownership + security
as_('lab'); ex("lab cannot mark a doctor-only notification", "select notif_mark(array[(select min(id) from notifications where kind='queue.new')], true)")
as_('pg'); check("...and nothing was written for lab", f"not exists (select 1 from notification_recipients where user_id='{U['lab']}' and notification_id=(select min(id) from notifications where kind='queue.new'))")
as_('lab'); ex("direct insert into notifications is refused", "insert into notifications(kind,title) values('x','y')", False)
ex("direct update of notifications is refused", "update notifications set title='hacked'", False)
ex("direct delete of notifications is refused", "delete from notifications", False)
ex("direct write to read-state is refused", "insert into notification_recipients values (1, '"+U['rec']+"', now())", False)
ex("cannot call internal notify()", "select notify('a','info','t','b',array['lab'],'lab')", False)
ex("cannot call stock sweep directly", "select ntf_stock_check(null)", False)
check("lab sees zero rows of other roles via direct select", "(select count(*) from notifications where kind in ('queue.new','security.lookup','ward.admit')) = 0")
as_('anon'); ex("anonymous cannot read notifications", "select count(*) from notifications", False)
ex("anonymous cannot call notif_list", "select notif_list(10)", False)
as_('pg'); sql("update settings set value='true' where key='require_mfa';")
as_('admin', 'aal1'); ex("2FA pending: notif_list refused", "select notif_list(10)", False, "not allowed"); ex("2FA pending: direct select shows nothing", "do $x$ begin if (select count(*) from notifications)>0 then raise exception 'leak'; end if; end $x$")
as_('pg'); sql("update settings set value='false' where key='require_mfa';")

# ---- preferences: muting hides but critical stays
as_('rec'); ex("reception mutes billing", "insert into notification_preferences(user_id,muted_categories,sound) values ('"+U['rec']+"', array['billing'], true)")
check("muted category hidden from list", f"{lst('billing.paid')} = 0")
as_('admin'); ex("admin cannot edit someone else's preferences", "update notification_preferences set sound=false where user_id='"+U['rec']+"'")
as_('pg'); check("...and it did not change", f"(select sound from notification_preferences where user_id='{U['rec']}')")
as_('admin'); ex("admin mutes admin category", "insert into notification_preferences(user_id,muted_categories) values ('"+U['admin']+"', array['admin','security'])")
check("critical security alert still visible when muted", f"{lst('security.lookup')} = 1"); check("muted admin info hidden", f"{lst('admin.staff')} = 0")

# ---- duplicates, errors, cleanup
as_('pg')
check("same dedupe_key returns null the 2nd time", "notify('t.x','info','a','b',array['admin'],'adm','dupe-1') is not null and notify('t.x','info','a','b',array['admin'],'adm','dupe-1') is null")
check("only one row exists for the key", "(select count(*) from notifications where dedupe_key='dupe-1') = 1")
check("resolved pending task re-opens as new + unread", "(select notify('t.p','warning','a','b',array['admin'],'adm','dupe-2',null,true)) is not null and (select notif_resolve('dupe-2')) is null and notify('t.p','warning','a','b',array['admin'],'adm','dupe-2',null,true) is not null")
sql("alter table notifications add constraint tmp_fail check (kind <> 'queue.new') not valid;")
as_('rec'); ex("registration still works if a notification fails", "select register_visit('Fail Safe','9800000001',20,'x','d1',null,false,'v1')")
as_('pg'); sql("alter table notifications drop constraint tmp_fail;")
check("...and the visit was saved", "exists (select 1 from visits where name='Fail Safe')")
as_('admin'); ex("error report accepted", "select notif_report_error('pharmacy','42501'); select notif_report_error('pharmacy','42501')")
as_('pg'); check("error reports are deduplicated", "(select count(*) from notifications where kind='admin.error') = 1")
check("error alert carries no free text", "not exists (select 1 from notifications where kind='admin.error' and body ~* 'patient|zed|amy')")
sql("update notifications set expires_at=now()-interval '1 day' where dedupe_key='dupe-1'; update notifications set expires_at=now()-interval '1 day' where dedupe_key='dupe-2';")
as_('admin'); ex("maintenance runs", "select notif_maintenance()")
as_('pg'); check("expired notification removed", "not exists (select 1 from notifications where dedupe_key='dupe-1')")
check("open pinned task kept even if expired", "exists (select 1 from notifications where dedupe_key='dupe-2')")
check("cleanup is audited", "exists (select 1 from audit_log where action='NOTIF_CLEANUP')")

# ---- x-ray review + booking terms
as_('pg'); sql("insert into xray_reviewers(user_id,full_name,registration_no) values ('"+U['doc']+"','Dr Sharma','NMC-1');")
sql("insert into xray_reports(ref,code_hash,patient_name,phone,age,sex,body_part,side,file_sha256,consent_version,ai_result,ai_model,prompt_version,ai_urgency) values ('XR-TEST0001',xray_code_hash('XR-TEST0001','12345678'),'Xia Ray','9800000009',33,'male','chest','na',repeat('a',64),'xray-consent-2026-11-v1','{}'::jsonb,'m','p','routine');")
as_('doc'); check("registered reviewer gets a pinned X-ray review notice", f"{pend('xray.review')} = 1")
as_('doc2'); check("a doctor who is not a reviewer does not", f"{lst('xray.review')} = 0")
as_('admin'); check("admin who is not a reviewer does not", f"{lst('xray.review')} = 0")
as_('pg'); check("X-ray notice has no patient details", "not exists (select 1 from notifications where kind='xray.review' and title||body ~* 'xia|xia ray|9800000009|chest')")
sql("update xray_reports set status='rejected', reject_reason='test', reviewer_id='"+U['doc']+"', reviewed_at=now() where ref='XR-TEST0001';")
as_('doc'); check("X-ray notice resolves when the report is reviewed", f"{pend('xray.review')} = 0")
as_('anon'); check("anyone can read the booking terms", "(public_terms()->>'text') like 'Booking is a request%'")
as_('rec'); ex("reception cannot edit the terms", "update settings set value='x' where key='booking_terms'")
as_('pg'); check("terms unchanged after refused edit", "(select value from settings where key='booking_terms') like 'Booking is a request%'")
as_('admin'); ex("admin edits the terms", "update settings set value='New terms text for the clinic booking page, long enough.' where key='booking_terms'")
as_('anon'); check("patients now see the new terms", "(public_terms()->>'text') like 'New terms%'")
as_('anon'); check("anonymous sees no rows of the settings table", "(select count(*) from settings) = 0")
print("\n".join(out))
