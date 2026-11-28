false=False; true=True
import sys
U = {'admin':'00000000-0000-0000-0000-000000000001','rec':'00000000-0000-0000-0000-000000000002','doc':'00000000-0000-0000-0000-000000000003',
     'doc2':'00000000-0000-0000-0000-000000000004','lab':'00000000-0000-0000-0000-000000000005','pha':'00000000-0000-0000-0000-000000000006'}
out=[]
def sql(s): out.append(s)
def as_(who, aal='aal1'):
    if who=='anon': sql("reset role; select set_config('request.jwt.claims','{}',false); set role anon;")
    elif who=='service': sql("reset role; select set_config('request.jwt.claims','{}',false); set role service_role;")
    elif who=='pg': sql("reset role; select set_config('request.jwt.claims','{}',false);")
    else: sql(f"reset role; select set_config('request.jwt.claims','{{\"sub\":\"{U[who]}\",\"aal\":\"{aal}\"}}',false); set role authenticated;")
def ex(label, stmt, ok=True, has=None):
    h = "null" if has is None else "$q$"+has+"$q$"
    sql(f"select tt.expect($q${label}$q$, $q${stmt}$q$, {str(ok).lower()}, {h});")
def check(label, cond_sql):
    sql(f"select tt.expect($q${label}$q$, $q$do $x$ begin if not coalesce(({cond_sql}),false) then raise exception 'assertion false'; end if; end $x$$q$, true, null);")

sql("""
create schema tt; create table tt.res(n serial, label text, ok boolean, msg text);
create function tt.rxid(n text) returns bigint language sql security definer as $f$ select max(p.id) from prescriptions p join visits v on v.id=p.visit_id where v.name=n $f$;
grant usage on schema tt to public; grant all on tt.res to public; grant usage,select on all sequences in schema tt to public;
create function tt.expect(label text, q text, should_work boolean default true, must_contain text default null) returns void language plpgsql as $$
declare m text;
begin
  begin execute q;
    insert into tt.res(label,ok,msg) values(label, should_work, case when should_work then 'worked' else 'WORKED BUT SHOULD HAVE FAILED' end);
  exception when others then get stacked diagnostics m = message_text;
    insert into tt.res(label,ok,msg) values(label, (not should_work) and (must_contain is null or m ilike '%'||must_contain||'%'), m);
  end;
end $$;
""")
# users
for k,v in U.items(): sql(f"insert into auth.users(id,email) values('{v}','{k}@x.test');")
sql(f"""insert into profiles(id,full_name,role,doctor_id) values
 ('{U['admin']}','Admin','admin',null),('{U['rec']}','Rita Reception','reception',null),('{U['doc']}','Dr Sharma','doctor','d1'),
 ('{U['doc2']}','Dr Thapa','doctor','d2'),('{U['lab']}','Lab','lab',null),('{U['pha']}','Pharm','pharmacy',null);""")
sql("update doctors set avg_min=10;")

# ---- registration + messages
as_('rec')
ex("reception registers with sms consent", "select register_visit('Ram Shrestha','9801111111',30,'fever','d1','penicillin, dust',true,'v1')")
ex("reception registers without consent", "select register_visit('Sita Rai','9802222222',25,'cough','d1',null,false,'v1')")
ex("reception registers 3rd/4th/5th", "select register_visit('Hari Karki','9803333333',40,'pain','d1',null,true,'v1'); select register_visit('Gita Lama','9804444444',22,'x','d1',null,true,'v1'); select register_visit('Mina Gurung','9805555555',50,'y','d2',null,true,'v1')")
as_('admin')
check("outbox: 'registered' queued only for consenting patients", "(select count(*) from outbox where kind='registered')=4")
check("outbox bodies have no access code", "not exists(select 1 from outbox o join visits v on v.id=o.visit_id where o.body like '%'||v.code||'%')")
as_('rec')
ex("reception cannot read outbox (admin only)", "do $x$ begin if (select count(*) from outbox)>0 then raise exception 'saw rows'; end if; end $x$")
ex("reception cannot change status", "update visits set status='in_room' where bill like 'BL-%' and name='Ram Shrestha'", false, "only change payment")
as_('doc')
ex("doctor calls in Ram", "update visits set status='in_room' where name='Ram Shrestha'")
as_('admin')
check("called message queued + first_called_at stamped", "(select count(*) from outbox where kind='called')=1 and (select first_called_at from visits where name='Ram Shrestha') is not null")
check("ahead messages: Hari/Gita within threshold (consenting waiting)", "(select count(*) from outbox where kind='ahead')=1")
check("no ahead message for Sita (no consent)", "not exists(select 1 from outbox o join visits v on v.id=o.visit_id where v.name='Sita Rai' and o.kind<>'x')")
as_('doc')
ex("doctor cannot mark paid", "update visits set paid_at=now() where name='Ram Shrestha'", false, "cannot change payment")
ex("doctor cannot edit patient name", "update visits set name='Zed' where name='Ram Shrestha'", false, "only admin")
ex("doctor cannot touch consent", "update visits set consent_sms=false where name='Ram Shrestha'", false, "message consent")
as_('doc2')
ex("doctor 2 cannot see d1 patients", "do $x$ begin if (select count(*) from visits where doctor_id='d1')>0 then raise exception 'leak'; end if; end $x$")
as_('doc')
ex("doctor sends to lab", "update visits set status='report_pending', test_name='Blood test', test_due=now()+interval '30 minutes' where name='Ram Shrestha'")
as_('lab')
ex("lab marks report ready", "update visits set status='review', q_at=now(), report_path='abc/r.pdf' where name='Ram Shrestha'")
ex("lab cannot edit allergies", "update visits set allergies='none' where name='Ram Shrestha'", false, "lab can only")
as_('admin')
check("report_ready queued + TAT stamps", "(select count(*) from outbox where kind='report_ready')=1 and (select report_ready_at is not null and test_ordered_at is not null from visits where name='Ram Shrestha')")

as_('service')
ex("service claims outbox once", "do $x$ declare n int; begin select count(*) into n from claim_outbox(10); if n < 3 then raise exception 'claimed %', n; end if; if (select count(*) from claim_outbox(10))<>0 then raise exception 'double claim'; end if; end $x$")
as_('rec'); ex("reception cannot claim outbox", "select * from claim_outbox(5)", false)
# ---- patient portal
as_('anon')
ex("anon cannot read visits", "do $x$ begin if (select count(*) from visits)>0 then raise exception 'leak'; end if; end $x$")
ex("anon sees no outbox rows (RLS)", "do $x$ begin if (select count(*) from outbox)>0 then raise exception 'leak'; end if; end $x$")
ex("anon sees no audit rows (RLS)", "do $x$ begin if (select count(*) from audit_log)>0 then raise exception 'leak'; end if; end $x$")
ex("anon cannot call audit_write", "select audit_write(null,'x','y','z','{}')", false)
ex("anon cannot call report_summary", "select report_summary(current_date,current_date)", false)
as_('pg')
sql("create temp table cd as select bill, code from visits where name='Ram Shrestha'; grant all on cd to public;")
as_('anon')
check("patient_status ok with rx+sms fields", "(select (patient_status((select bill from cd),(select code from cd))->>'rx')='none' and (patient_status((select bill from cd),(select code from cd))->>'sms')='true')")
ex("wrong code x5 then locked", "do $x$ declare i int; begin for i in 1..5 loop perform patient_status((select bill from cd),'000000'); end loop; if (patient_status((select bill from cd),(select code from cd))->>'locked') is null then raise exception 'not locked'; end if; end $x$")
as_('pg'); sql("delete from lookup_attempts;")
as_('anon')
ex("patient withdraws sms", "do $x$ begin if not patient_withdraw_sms((select bill from cd),(select code from cd)) then raise exception 'failed'; end if; end $x$")
ex("wrong code can't withdraw", "do $x$ begin if patient_withdraw_sms((select bill from cd),'111111') then raise exception 'should fail'; end if; end $x$")
as_('admin')
check("consent now off", "(select consent_sms from visits where name='Ram Shrestha')=false")
as_('anon')
ex("queue board public", "do $x$ declare j json; begin j := queue_board(); if json_array_length(j->'doctors')<3 then raise exception 'few'; end if; if j::text ilike '%Ram%' then raise exception 'name leaked'; end if; end $x$")
ex("booking needs consent", "select request_appointment('Test Person','9809999999','d1',null,'x',false,false)", false, "consent")
ex("booking ok", "select request_appointment('Test Person','9809999999','d1',null,'x',true,true)")
ex("booking rate-limit per phone", "select request_appointment('Test Person','9809999999','d1',null,'x',true,true); select request_appointment('Test Person','9809999999','d1',null,'x',true,true); select request_appointment('Test Person','9809999999','d1',null,'x',true,true)", false, "too many")
ex("booking unknown doctor", "select request_appointment('Test Person','9808888888','zzz',null,'x',true,false)", false, "unknown doctor")
ex("privacy request ok", "select submit_privacy_request('erasure','Ram Shrestha','9801111111','','please delete')")
ex("privacy bad kind", "select submit_privacy_request('hack','Ram','9801111111','','')", false, "unknown request")

# ---- audit log
as_('admin')
check("audit has rows, hides personal data", "(select count(*) from audit_log)>10 and not exists(select 1 from audit_log where detail::text ilike '%Shrestha%' or detail::text like '%9801111111%' or detail::text ilike '%dust%')")
check("audit chain verifies", "(audit_verify()->>'ok')='true'")
ex("admin cannot edit audit", "update audit_log set action='x'", false)
ex("admin cannot delete audit", "delete from audit_log", false)
as_('rec')
ex("reception cannot read audit", "do $x$ begin if (select count(*) from audit_log)>0 then raise exception 'leak'; end if; end $x$")
as_('pg')
ex("owner cannot edit audit either (trigger)", "update audit_log set action='x' where seq=1", false, "append-only")
sql("create temp table orig as select seq, detail from audit_log where seq=3; grant all on orig to public; alter table audit_log disable trigger audit_log_noedit; update audit_log set detail='{\"tampered\":1}' where seq=3; alter table audit_log enable trigger audit_log_noedit;")
as_('admin')
check("tampering is detected", "(audit_verify()->>'ok')='false' and (audit_verify()->>'bad_seq')='3'")
as_('pg')
sql("alter table audit_log disable trigger audit_log_noedit; update audit_log set detail=(select detail from orig) where seq=3; alter table audit_log enable trigger audit_log_noedit;")

# ---- reports
as_('rec')
ex("reception adds charges", "insert into bill_items(visit_id,description,amount) select id,'Consultation',500 from visits where name='Ram Shrestha'; update visits set paid_at=now() where name='Ram Shrestha'")
ex("reception cannot run report_summary", "select report_summary(current_date-7,current_date)", false, "admins only")
as_('admin')
ex("admin report_summary", "do $x$ declare j json; begin j:=report_summary(current_date-7,current_date+1); if (j->'totals'->>'visits')::int<5 then raise exception 'visits'; end if; if (j->'totals'->>'collected')::numeric<>500 then raise exception 'collected %', j->'totals'->>'collected'; end if; if json_array_length(j->'per_day')<>9 then raise exception 'perday'; end if; end $x$")
ex("admin report_rows (no names)", "do $x$ begin if exists(select 1 from report_rows((now() at time zone 'Asia/Kathmandu')::date,(now() at time zone 'Asia/Kathmandu')::date) where patient is not null) then raise exception 'pii'; end if; if (select count(*) from report_rows((now() at time zone 'Asia/Kathmandu')::date,(now() at time zone 'Asia/Kathmandu')::date))<5 then raise exception 'rows'; end if; end $x$")
ex("report range limit", "select report_summary(current_date-400,current_date)", false, "one year")
check("export was audited", "exists(select 1 from audit_log where action='EXPORT')")

# ---- pharmacy
as_('doc')
ex("doctor prescribes amoxicillin to penicillin-allergic -> blocked", "select create_rx((select id from visits where name='Ram Shrestha'), '[{\"drug_id\":4,\"dose\":\"1 cap 3x\",\"days\":5,\"qty\":15}]')", false, "ALLERGY")
ex("doctor prescribes ibuprofen + warfarin -> needs reason", "select create_rx((select id from visits where name='Hari Karki'), '[{\"drug_id\":2,\"dose\":\"1\",\"days\":3,\"qty\":9},{\"drug_id\":6,\"dose\":\"1\",\"days\":3,\"qty\":3}]')", false, "MAJOR")
ex("doctor 1 cannot prescribe for other doctor's patient", "select create_rx((select id from visits where name='Mina Gurung'), '[{\"drug_id\":1,\"dose\":\"1\",\"days\":3,\"qty\":9}]')", false)
ex("doctor prescribes paracetamol", "select create_rx((select id from visits where name='Hari Karki'), '[{\"drug_id\":1,\"dose\":\"1 tab 3x\",\"days\":3,\"qty\":9}]')")
ex("doctor prescribes ibuprofen with ack", "select create_rx((select id from visits where name='Gita Lama'), '[{\"drug_id\":2,\"dose\":\"1\",\"days\":3,\"qty\":6},{\"drug_id\":6,\"dose\":\"1\",\"days\":3,\"qty\":3}]', null, 'INR monitored')")
ex("doctor cannot insert prescriptions directly", "insert into prescriptions(visit_id) select id from visits limit 1", false)
as_('pha')
ex("pharmacy cannot read visits", "do $x$ begin if (select count(*) from visits)>0 then raise exception 'leak'; end if; end $x$")
ex("pharmacy adds stock (expired batch rejected)", "select add_stock(1,'OLD','2020-01-01',50)", false, "future")
ex("pharmacy adds stock", "select add_stock(1,'B1',current_date+200,5); select add_stock(1,'B2',current_date+100,50); select add_stock(2,'I1',current_date+300,20); select add_stock(6,'W1',current_date+300,20)")
as_('pg')
sql("insert into drug_stock(drug_id,batch,expiry,qty) values(1,'EXPIRED',current_date-5,500);")
as_('pha')
check("pharmacy queue shows 2 pending with checks", "json_array_length(pharmacy_queue())=2")
ex("dispense paracetamol FEFO, skip expired", "do $x$ begin perform dispense_rx(tt.rxid('Hari Karki')); end $x$")
check("FEFO: B2 (earlier expiry) used first; expired untouched; B1 intact", "(select qty from drug_stock where batch='B2')=41 and (select qty from drug_stock where batch='EXPIRED')=500 and (select qty from drug_stock where batch='B1')=5")
as_('rec')
check("pharmacy charge on bill", "exists(select 1 from bill_items b join visits v on v.id=b.visit_id where v.name='Hari Karki' and b.description like 'Pharmacy: Paracetamol%' and b.amount=18)")
as_('pha')
ex("dispense twice refused", "do $x$ begin perform dispense_rx(tt.rxid('Hari Karki')); end $x$", false, "not pending")
ex("dispense interaction rx (doctor ack on file)", "do $x$ begin perform dispense_rx(tt.rxid('Gita Lama')); end $x$")
as_('doc')
ex("doctor adds allergy after the fact", "update visits set allergies='paracetamol' where name='Hari Karki'")
ex("new rx for allergic patient blocked", "select create_rx((select id from visits where name='Hari Karki'), '[{\"drug_id\":1,\"dose\":\"1\",\"days\":3,\"qty\":9}]')", false, "ALLERGY")
as_('pg')
sql("insert into prescriptions(id,visit_id) overriding system value select 9001,id from visits where name='Hari Karki'; insert into prescription_items(rx_id,drug_id,dose,qty) values(9001,1,'1',3);")
as_('pha')
ex("dispense blocks allergy at counter (server side)", "select dispense_rx(9001)", false, "ALLERGY")
as_('pg'); sql("update drug_stock set qty=0 where batch in ('B1','B2'); update prescriptions set status='cancelled' where id=9001; delete from prescriptions where id=9001;")
sql("update visits set allergies=null where name='Hari Karki';")
as_('doc')
ex("create rx while stock empty is fine (stock is checked at counter)", "select create_rx((select id from visits where name='Hari Karki'), '[{\"drug_id\":1,\"dose\":\"1\",\"days\":3,\"qty\":9}]')")
as_('pha')
ex("not enough stock -> all rolled back", "do $x$ begin perform dispense_rx(tt.rxid('Hari Karki')); end $x$", false, "Not enough")
check("stock unchanged after failed dispense", "(select sum(qty) from drug_stock where drug_id=1 and expiry>current_date)=0 and (select status from prescriptions where id=(select max(id) from prescriptions))='pending'")
as_('anon')
as_('admin')
check("dispense is audited with batches", "exists(select 1 from audit_log where action='DISPENSE' and detail ? 'batches')")

# ---- wards
as_('rec')
ex("admit Sita to G-1", "select admit_patient((select id from visits where name='Sita Rai'),'w1-1','observation')")
ex("same bed again refused", "select admit_patient((select id from visits where name='Gita Lama'),'w1-1')", false, "occupied")
ex("same patient twice refused", "select admit_patient((select id from visits where name='Sita Rai'),'w1-2')", false, "already admitted")
as_('admin'); ex("set bed rate", "update beds set rate=1000 where id in ('w1-1','w1-2')")
as_('rec')
ex("transfer to G-2", "select transfer_bed((select id from admissions limit 1),'w1-2')")
ex("discharge needs summary", "select discharge_patient((select id from admissions limit 1),'')", false, "summary")
ex("discharge", "select discharge_patient((select id from admissions limit 1),'Recovered, home care advised')")
check("bed charges on bill (2 lines x 1 day)", "(select count(*) from bill_items b join visits v on v.id=b.visit_id where v.name='Sita Rai' and b.description like 'Bed %')=2")
check("bed board json", "json_array_length(bed_board())=1")
as_('lab')
ex("lab cannot see bed board", "select bed_board()", false)

# ---- claims
as_('admin')
ex("admin adds insurer", "insert into insurers(name) values('Test Insurance')")
as_('rec')
ex("reception creates claim", "insert into claims(visit_id,insurer_id,policy_no,amount) select (select id from visits where name='Ram Shrestha'),(select id from insurers limit 1),'P-1',500")
ex("claim skip draft->paid refused", "update claims set status='paid'", false, "cannot go")
ex("claim submit", "update claims set status='submitted'")
ex("claim approve needs amount", "update claims set status='approved'", false, "approved amount")
ex("claim approve", "update claims set status='approved', approved_amount=450")
ex("claim paid", "update claims set status='paid'")
as_('doc')
ex("doctor cannot see claims", "do $x$ begin if (select count(*) from claims)>0 then raise exception 'leak'; end if; end $x$")

# ---- feedback
ex("doctor sends feedback", "insert into feedback(role,screen,kind,message) values('doctor','doc','bug','Button too small')")
ex("feedback as someone else refused", "insert into feedback(user_id,message) values('"+U['admin']+"','spoof')", false)
as_('admin')
check("admin reads feedback", "(select count(*) from feedback)=1")
as_('rec')
ex("reception cannot read feedback", "do $x$ begin if (select count(*) from feedback)>0 then raise exception 'leak'; end if; end $x$")

# ---- 2FA gate
as_('admin')
ex("admin turns on require_mfa", "update settings set value='true' where key='require_mfa'")
as_('admin','aal1')
check("aal1 session loses its role when 2FA required", "my_role() is null")
ex("aal1 admin cannot read audit", "do $x$ begin if (select count(*) from audit_log)>0 then raise exception 'leak'; end if; end $x$")
ex("aal1 can still read own profile (so UI can ask for the code)", "do $x$ begin if (select count(*) from profiles)<>1 then raise exception 'cannot read own'; end if; end $x$")
as_('admin','aal2')
check("aal2 session has role", "my_role()='admin'")
ex("aal2 admin turns it off again", "update settings set value='false' where key='require_mfa'")
as_('admin','aal1'); check("2FA off: aal1 works", "my_role()='admin'")

# ---- retention
as_('pg')
sql("update visits set visit_date=current_date-2000, report_path='old/r.pdf' where name='Ram Shrestha';")
as_('rec'); ex("reception cannot preview retention", "select retention_preview()", false, "admins only")
as_('admin')
check("preview counts the old visit", "(retention_preview()->>'visits')::int=1 and (retention_preview()->>'files')::int=1")
ex("run retention", "select retention_run()")
check("visit anonymised, files queued", "(select name from visits where bill=(select bill from cd))='[removed]' and (select phone from visits where bill=(select bill from cd))='' and (select report_path from visits where bill=(select bill from cd)) is null and (select count(*) from retention_queue)=1")
check("billing amounts kept", "exists(select 1 from bill_items b join visits v on v.id=b.visit_id where v.name='[removed]' and b.amount=500)")
check("pending files list", "retention_pending_files()=array['old/r.pdf']")
ex("files done", "select retention_files_done(array['old/r.pdf'])")
check("queue empty", "(select count(*) from retention_queue)=0")
check("final audit chain still valid", "(audit_verify()->>'ok')='true'")

# ---- service role
as_('service')
ex("service role can write audit_event", "select audit_event(null,'REPORT_LINK','1','{}')")
as_('rec'); ex("reception cannot call audit_event", "select audit_event(null,'x','1')", false)

as_('pg')
sql("select n, case when ok then 'PASS' else 'FAIL' end as r, label, case when ok then '' else msg end as why from tt.res order by n;")
sql("select count(*) filter (where ok) as passed, count(*) filter (where not ok) as failed from tt.res;")
print("\n".join(out))
