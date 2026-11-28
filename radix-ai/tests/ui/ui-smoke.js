const {JSDOM}=require('jsdom'), fs=require('fs'), vm=require('vm'), path=require('path');
const ROOT=path.join(__dirname,'..','..')+path.sep; const APP=ROOT+'app'+path.sep;
let html=fs.readFileSync(APP+'index.html','utf8').replace(/<script[\s\S]*?<\/script>/g,'');
const dom=new JSDOM(html,{url:'http://localhost:8000/app/',runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window; const errors=[]; const log=[];
w.addEventListener('error',e=>errors.push('window error: '+e.message));
let PHONE=true; w.matchMedia=q=>({matches:PHONE,addEventListener(){},removeEventListener(){}}); w.print=()=>log.push('print'); w.URL.createObjectURL=()=>'blob:x'; w.alert=()=>{}; w.confirm=()=>true; w.prompt=()=>'reason';
w.HTMLElement.prototype.scrollIntoView=()=>{}; w.scrollTo=()=>{};
const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kathmandu'});
const V=(o)=>({id:1,bill:'BL-1',code:'123456',name:'Ram Shrestha',phone:'9801111111',age:30,reason:'fever',doctor_id:'d1',visit_date:today,token:1,status:'in_room',q_at:new Date().toISOString(),created_at:new Date().toISOString(),allergies:'penicillin',consent_sms:true,paid_at:null,report_path:'a/b.pdf',test_name:null,test_due:null,...o});
const TABLES={doctors:[{id:'d1',name:'Dr. Sharma',dept:'General',avg_min:8,active:true}],
 visits:[V({}),V({id:2,bill:'BL-2',name:'Sita',status:'waiting',token:2,report_path:null})],
 profiles:[{id:'u1',full_name:'Admin'}],settings:[{key:'clinic_name',value:'Test Clinic'},{key:'require_mfa',value:'false'},{key:'retention_days',value:'1095'},{key:'ahead_threshold',value:'2'},{key:'site_url',value:''}],
 drugs:[{id:1,name:'Paracetamol',generic:'paracetamol',drug_class:null,strength:'500 mg',form:'tablet',rx_class:'OTC',unit_price:2,active:true},{id:4,name:'Amoxicillin',generic:'amoxicillin',drug_class:'penicillin',strength:'500 mg',form:'capsule',rx_class:'Rx',unit_price:8,active:true}],
 drug_stock:[{id:1,drug_id:1,batch:'B1',expiry:'2099-01-01',qty:10},{id:2,drug_id:1,batch:'OLD',expiry:'2020-01-01',qty:5}],
 insurers:[{id:1,name:'Test Insurance',active:true}],
 claims:[{id:1,visit_id:1,insurer_id:1,policy_no:'P1',amount:500,status:'submitted',approved_amount:null,note:null}],
 outbox:[{id:1,kind:'registered',phone:'9801111111',body:'hi',status:'sent',provider_id:'test-mode',created_at:new Date().toISOString()}],
 privacy_requests:[{id:1,kind:'erasure',name:'Ram',phone:'98',bill:null,details:'x',status:'open',due_at:new Date(Date.now()+864e5).toISOString(),created_at:new Date().toISOString()}],
 audit_log:[{seq:1,at:new Date().toISOString(),actor:'u1',actor_role:'admin',action:'UPDATE',table_name:'visits',row_id:'1',detail:{status:{old:'a',new:'b'}}}],
 allergy_terms:[{term:'sulfa',expands:['cotrimoxazole'],note:'x',active:true}],
 feedback:[{id:1,at:new Date().toISOString(),user_id:'u1',role:'doctor',screen:'doc',kind:'bug',message:'help',status:'new'}],
 bill_items:[{id:1,visit_id:1,description:'Consultation',amount:500}],appointments:[]};
const sum={totals:{visits:5,completed:3,avg_wait_min:12.5,avg_consult_min:6,avg_report_min:22,billed:1500,collected:1000,unpaid:500,unpaid_count:1},per_day:[{day:today,visits:5,collected:1000}],per_doctor:[{doctor:'Dr. Sharma',dept:'General',visits:5,avg_wait_min:12,collected:1000}],unpaid:[{bill:'BL-2',name:'Sita',phone:'98',visit_date:today,billed:500}]};
const RPC={public_terms:{text:'Terms.',clinic:'Test'},queue_board:{clinic:'Test Clinic',doctors:[{name:'Dr. Sharma',dept:'General',serving:[1],next:[2,3],waiting:2}]},
 pharmacy_queue:[{id:5,created_at:new Date().toISOString(),name:'Ram',age:30,bill:'BL-1',allergies:'penicillin',doctor:'Dr. Sharma',note:null,ack_reason:null,items:[{drug:'Amoxicillin 500 mg',form:'cap',rx_class:'Rx',dose:'1',days:5,qty:15,stock:0}],checks:{allergy:[{drug:'Amoxicillin',allergen:'penicillin'}],interactions:[{a:'aspirin',b:'warfarin',severity:'major',note:'bleeding'}]}}],
 bed_board:[{id:'w1',name:'General Ward',active:true,beds:[{id:'w1-1',label:'G-1',rate:100,active:true,adm:null},{id:'w1-2',label:'G-2',rate:0,active:true,adm:{id:3,visit_id:9,name:'Hari',bill:'BL-9',since:new Date().toISOString(),doctor:'Dr. Sharma',note:'obs'}}]}],
 report_summary:sum,report_rows:[{bill:'BL-1',billed:500}],audit_verify:{ok:true,checked:1,head:'abcdef0123456789abcdef'},visit_rx:[{id:7,status:'pending',items:[{drug:'Paracetamol',qty:9}]}],
 admin_list_staff:[{id:'u1',email:'a@x',full_name:'Admin',role:'admin',doctor_id:null,last_sign_in_at:null}],retention_preview:{days:1095,cutoff:'2020-01-01',visits:1,files:1,pending_files:0,appointments:0,messages:0},
 retention_run:{visits:1},retention_pending_files:[],create_rx:{id:1,checks:{}},dispense_rx:{ok:true,billed:18},patient_status:{bill:'BL-1',name:'Ram',doctor:'Dr. Sharma',dept:'General',token:1,status:'waiting',pos:2,in_room:1,queue_len:2,avg_min:8,total:500,paid:false,rx:'pending',sms:true,report_path:null,test_name:null}};
RPC.register_visit=V({id:3,bill:'BL-3',name:'Ram',consent_sms:true});
const calls=[];
function chain(table){let rows=TABLES[table]||[];const c={};const thenable=()=>Promise.resolve({data:rows,error:null,count:rows.length});
 for(const m of ['select','eq','neq','order','limit','in','upsert','delete','insert','update','maybeSingle']) c[m]=(...a)=>{calls.push(table+'.'+m);if(m==='maybeSingle'){rows=rows[0]||null;return Promise.resolve({data:rows,error:null});}return c;};
 c.then=(res,rej)=>thenable().then(res,rej);return c;}
const sbstub={from:t=>chain(t),rpc:(n,a)=>{calls.push('rpc:'+n);return Promise.resolve({data:n in RPC?RPC[n]:null,error:null});},
 functions:{invoke:async n=>({data:{sent:2,failed:0,test_mode:true},error:null})},
 storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'http://x'}}),upload:async()=>({error:null}),remove:async()=>({error:null})})},
 auth:{onAuthStateChange:cb=>{w.__authcb=cb;},signOut:async()=>{},signInWithPassword:async()=>({}),
  mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'}}),listFactors:async()=>({data:{totp:[]}}),enroll:async()=>({data:{id:'f1',totp:{qr_code:'data:image/svg+xml;utf8,<svg/>',secret:'ABC'}},error:null}),challengeAndVerify:async()=>({error:null}),unenroll:async()=>({error:null})},
  getSession:async()=>({data:{session:null}})}};
w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','')}; w.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open'); this.dispatchEvent(new w.Event('close'))};   // jsdom has no <dialog> methods
w.supabase={createClient:()=>sbstub}; w.qrcode=require('qrcode-generator'); w.crypto=require('crypto').webcrypto;
const ctx=dom.getInternalVMContext();
for(const f of ['js/config.js','js/app/ui.js','js/app/app.js','js/app/print.js','js/app/security.js','js/app/admin.js','js/app/modules.js','js/app/patients.js','js/app/queue.js','js/app/slip.js','js/app/notes.js','js/app/notify.js','js/app/inbox.js','js/app/appointments.js','js/app/xray.js','js/app/start.js']){
  try{new vm.Script(fs.readFileSync(ROOT+f,'utf8'),{filename:f}).runInContext(ctx);}catch(e){errors.push(f+': '+e.message);}}
const run=c=>vm.runInContext(c,ctx); const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await sleep(100);
  // public views
  for(const v of ['pat','book','board','staff']){ try{run(`go('${v}')`);await sleep(60);}catch(e){errors.push('public '+v+': '+e.message);} }
  console.log('board text:', w.document.querySelector('#bview').textContent.slice(0,80));
  // log in as each role
  for(const role of ['admin','reception','doctor','lab','pharmacy']){
    TABLES.profiles=[{id:'u1',full_name:role+' user',role,doctor_id:role==='doctor'?'d1':null}];
    w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(120);
    const tabsNow=run('tabs().map(t=>t[0])');
    for(const t of tabsNow){ try{run(`go('${t}')`);await sleep(80);}catch(e){errors.push(role+'/'+t+': '+e.message);} }
    console.log(role.padEnd(10),'tabs:',tabsNow.join(','));
    w.__authcb('SIGNED_OUT',null); await sleep(60);
  }
  // admin panes + actions
  TABLES.profiles=[{id:'u1',full_name:'Admin',role:'admin',doctor_id:null}]; w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(120);
  run("go('adm')"); for(const p of ['team','reports','messages','privacy','audit','feedback','allergy','settings']){ try{run(`ADMPANE='${p}';renderAdm()`);await sleep(100);}catch(e){errors.push('adm pane '+p+': '+e.message);} 
    const n=w.document.querySelector('#adm-other').textContent.length; if(p!=='team'&&n<20) errors.push('pane '+p+' empty'); }
  // pharmacy renders warnings + disables dispense on allergy
  run("go('pha')"); await sleep(120);
  const dis=w.document.querySelector('#phq button.btn'); console.log('pharmacy: allergy warning shown =',/ALLERGY/.test(w.document.querySelector('#phq').textContent),'| dispense disabled =',!!dis.disabled);
  // printing
  run("go('rec')"); await sleep(100);
  await run("printSlip(VT[0])"); await sleep(120);
  const dlgEl=w.document.querySelector('dialog.slipdlg'); console.log('slip dialog open:',!!dlgEl,'| has QR:',!!dlgEl?.querySelector('img.qr'),'| shows token T-01:',/T-01/.test(dlgEl?.textContent||''));
  [...dlgEl.querySelectorAll('button')].find(b=>b.textContent==='Print slip').click(); await sleep(120); const slip=w.document.querySelector('#printarea');
  console.log('slip has QR:',!!slip.querySelector('img.qr'),'| qr src gif:',/^data:image\/gif/.test(slip.querySelector('img.qr')?.src||''),'| shows token T-01:',/T-01/.test(slip.textContent),'| print called:',log.includes('print'));
  await run("printBill(VT[0])"); await sleep(120); console.log('bill shows total:',/Rs 500/.test(w.document.querySelector('#printarea').textContent));
  console.log('status link:',run("statusLink('BL-1','123456')"));
  // doctor rx panel
  TABLES.profiles=[{id:'u1',full_name:'Dr',role:'doctor',doctor_id:'d1'}]; w.__authcb('SIGNED_OUT',null);await sleep(30); w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150);
  run("go('doc')"); await sleep(200); console.log('doctor panel has Prescription:',/Allergies and prescription/.test(w.document.querySelector('#dview').textContent));
  // feedback button
  console.log('feedback button mounted:',!!w.document.querySelector('#fbbtn'));
  // ---- behaviours
  const D=w.document, $q=x=>D.querySelector(x); const rpcLog=[]; const origRpc=sbstub.rpc; sbstub.rpc=(n,a)=>{rpcLog.push([n,a]);return origRpc(n,a);};
  const fail=(m)=>errors.push(m);
  // reception registration needs the privacy box
  TABLES.profiles=[{id:'u1',full_name:'Rita',role:'reception',doctor_id:null}]; w.__authcb('SIGNED_OUT',null);await sleep(30); w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150);
  run("go('rec')"); await sleep(100);
  $q('#rn').value='Ram'; $q('#rp').value='9801111111'; $q('#rgo').click(); await sleep(60);
  if(!/Privacy notice/.test($q('#rerr').textContent)) fail('registration allowed without privacy tick');
  if(rpcLog.some(r=>r[0]==='register_visit')) fail('register_visit called without consent');
  $q('#rcons').checked=true; $q('#rsms').checked=true; $q('#ral').value='penicillin'; $q('#rgo').click(); await sleep(100);
  const rv=rpcLog.find(r=>r[0]==='register_visit'); console.log('register_visit params:',JSON.stringify(rv&&rv[1]));
  if(!rv||rv[1].p_consent_sms!==true||rv[1].p_allergies!=='penicillin'||rv[1].p_consent_version!=='2026-11-v1') fail('register params wrong');
  // booking needs consent
  w.__authcb('SIGNED_OUT',null); await sleep(60); run("go('book')"); await sleep(30);
  $q('#bn').value='Test'; $q('#bp').value='9800000000'; $q('#bgo').click(); await sleep(60);
  if(!/terms and conditions/i.test($q('#berr').textContent)) fail('booking allowed without consent');
  $q('#bcons').checked=true; $q('#bsms').checked=true; $q('#bgo').click(); await sleep(60);
  const bk=rpcLog.find(r=>r[0]==='request_appointment'); console.log('request_appointment params:',JSON.stringify(bk&&{c:bk[1].p_consent,s:bk[1].p_sms}));
  if(!bk||bk[1].p_consent!==true) fail('booking consent not sent');
  // 2FA challenge screen
  sbstub.auth.mfa.getAuthenticatorAssuranceLevel=async()=>({data:{currentLevel:'aal1',nextLevel:'aal2'}}); sbstub.auth.mfa.listFactors=async()=>({data:{totp:[{id:'f1'}]}});
  TABLES.profiles=[{id:'u1',full_name:'Dr',role:'doctor',doctor_id:'d1'}]; w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150);
  console.log('2FA challenge shown:',!$q('#mfa').hidden && /Enter your code/.test($q('#mfah').textContent),'| app hidden:',$q('#doc').hidden&&$q('#rec').hidden,'| nav empty:',$q('#nav').children.length===0);
  if($q('#mfa').hidden||$q('#nav').children.length) fail('2FA challenge not enforced');
  // forced enrol
  sbstub.auth.mfa.getAuthenticatorAssuranceLevel=async()=>({data:{currentLevel:'aal1',nextLevel:'aal1'}}); sbstub.auth.mfa.listFactors=async()=>({data:{totp:[]}});
  TABLES.settings=TABLES.settings.map(r=>r.key==='require_mfa'?{...r,value:'true'}:r);
  w.__authcb('SIGNED_OUT',null);await sleep(40); w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(200);
  console.log('forced 2FA set-up shown:',!$q('#mfa').hidden && /Set up two-factor/.test($q('#mfah').textContent) && !!$q('#mfabody img'));
  if($q('#mfa').hidden||!$q('#mfabody img')) fail('forced enrolment not shown');
  // ---- mobile-first navigation
  TABLES.settings=TABLES.settings.map(r=>r.key==='require_mfa'?{...r,value:'false'}:r);
  const D2=w.document, q2=x=>D2.querySelector(x), tabsOf=()=>[...D2.querySelectorAll('#nav .tab')];
  TABLES.profiles=[{id:'u1',full_name:'Admin',role:'admin',doctor_id:null}]; w.__authcb('SIGNED_OUT',null);await sleep(30); w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150);
  PHONE=true; run("go('rec')"); await sleep(60);
  console.log('PHONE admin: bottom tabs =',tabsOf().length,'(expect 5: 4 + More) | last is More =',/More/.test(tabsOf().pop().textContent));
  if(tabsOf().length!==5) fail('phone admin nav should have 5 tabs');
  tabsOf().pop().click(); await sleep(20);
  console.log('More sheet open =',!q2('#sheet').hidden,'| items =',D2.querySelectorAll('#sheet .item').length,'(8 tabs + feedback = 9)');
  if(q2('#sheet').hidden||D2.querySelectorAll('#sheet .item').length!==9) fail('More sheet wrong');
  D2.querySelectorAll('#sheet .item')[2].click(); await sleep(150);
  console.log('after choosing item from sheet: sheet closed =',q2('#sheet').hidden,'| view =',run('view'));
  if(!q2('#sheet').hidden) fail('sheet did not close');
  PHONE=false; run("go('rec')"); await sleep(60);
  console.log('DESKTOP admin: sidebar tabs =',tabsOf().length,'(expect 10) | no More =',!tabsOf().some(t=>/More/.test(t.textContent)));
  if(tabsOf().length!==12) fail('desktop admin should list all 12');
  // every tab has an icon svg and a short + long label
  if(tabsOf().some(t=>!t.querySelector('svg')||!t.querySelector('.s')||!t.querySelector('.l'))) fail('tab missing icon/label');
  PHONE=true; TABLES.profiles=[{id:'u1',full_name:'Dr',role:'doctor',doctor_id:'d1'}]; w.__authcb('SIGNED_OUT',null);await sleep(30); w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150);
  console.log('PHONE doctor tabs =',tabsOf().length,'(4 + More)'); if(tabsOf().length!==5||!tabsOf().some(t=>/More/.test(t.textContent))) fail('doctor phone nav');
  w.__authcb('SIGNED_OUT',null); await sleep(60);
  console.log('PHONE public tabs =',tabsOf().map(t=>t.querySelector('.s').textContent).join(', '));
  if(tabsOf().length!==5) fail('public nav should have 5');
  // aria-current only on active
  if(D2.querySelectorAll('#nav [aria-current]').length!==1) fail('aria-current');
  // Dispense must be ENABLED when there is no allergy (regression: h() used to write disabled="null")
  RPC.pharmacy_queue=[{id:6,created_at:new Date().toISOString(),name:'Sita',age:20,bill:'BL-2',allergies:null,doctor:'Dr. Sharma',note:null,ack_reason:null,items:[{drug:'Paracetamol 500 mg',form:'tab',rx_class:'OTC',dose:'1',days:3,qty:9,stock:50}],checks:{allergy:[],interactions:[]}}];
  TABLES.profiles=[{id:'u1',full_name:'Pharm',role:'pharmacy',doctor_id:null}]; w.__authcb('SIGNED_IN',{user:{id:'u1'}}); await sleep(150); run("go('pha')"); await sleep(150);
  const db=[...D2.querySelectorAll('#phq button')].find(b=>b.textContent==='Dispense');
  console.log('Dispense enabled when no allergy =',db&&!db.disabled); if(!db||db.disabled) fail('Dispense button disabled without allergy');
  // patient portal shows big status
  run("cur={b:'BL-1',c:'123456'}; go('pat')"); await sleep(150);
  console.log('patient big block:',D2.querySelector('#pres .bigno')?.textContent,'|',D2.querySelector('#pres .bigh')?.textContent);
  if(!D2.querySelector('#pres .bigno')) fail('patient hero missing');
  // csv helper
  run("downloadCsv('t.csv',[{a:'=1+1',b:'x,y'}])");
  console.log('\nERRORS:',errors.length?errors:'none');
  process.exit(errors.length?1:0);
})();
