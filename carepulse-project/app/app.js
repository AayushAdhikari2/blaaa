const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
if (SUPABASE_URL.includes('YOUR-PROJECT')) document.body.prepend(Object.assign(document.createElement('div'),{className:'note',style:'margin:0;text-align:center',textContent:'Setup needed: open app/config.js and paste your Supabase URL and anon key, then run app/setup.sql. Open check.html to test.'}));
const $ = s => document.querySelector(s);
const TZ = 'Asia/Kathmandu';
const today = () => new Date().toLocaleDateString('en-CA', {timeZone: TZ});
const hm = t => new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const rs = n => 'Rs ' + Number(n).toLocaleString();
const tk = n => 'T-' + String(n).padStart(2, '0');
const LBL = {waiting:'Waiting', in_room:'With doctor', report_pending:'Report pending', review:'Waiting for review', done:'Completed'};
const rurl = p => sb.storage.from('reports').getPublicUrl(p).data.publicUrl;
function h(t, a, ...k){const e=document.createElement(t);for(const x in a||{}){if(x==='onclick')e.onclick=a[x];else if(x==='class')e.className=a[x];else e.setAttribute(x,a[x])}k.flat().filter(c=>c!=null&&c!==false).forEach(c=>e.append(c instanceof Node?c:document.createTextNode(c)));return e}
const empty = t => [h('p',{class:'muted'},t)];
const st = s => h('span',{class:'st '+s}, LBL[s]);

const HASH = location.hash.slice(1);
let DOCS = [], session = null, me = null, view = ['pat','book','staff'].includes(HASH) ? HASH : 'pat', cur = null, apptId = null, VT = [];
const can = r => me && (me.role === 'admin' || me.role === r);
const QP = new URLSearchParams(location.search); let AUTO = false;
if (QP.get('b') && QP.get('c')) {
  cur = {b:QP.get('b').trim(), c:QP.get('c').trim()}; view = 'pat'; AUTO = true;
  $('#pb').value = cur.b; $('#pc').value = cur.c;
  history.replaceState(null, '', location.pathname + '#pat');   // keep the code out of the address bar
}
const doc = id => DOCS.find(d => d.id === id) || {name:'—'};

/* ---------- navigation ---------- */
const TITLES = {pat:['Patient status','Know exactly where you are in the queue.','Enter your bill number and code to see your waiting number, report status and bill.'],
  book:['Appointments','Book your appointment online.','Send a request and reception will confirm by phone.'],
  staff:['Staff','Staff login.','Sign in to continue.'],
  rec:['Reception','Reception desk.','Register patients, handle online requests and billing.'],
  doc:['Doctor','Consultation queue.','Call patients in, order reports and review results.'],
  lab:['Lab','Reports to prepare.','Upload results and mark reports ready.']};
function tabs(){
  if (!me) return [['pat','Patient Portal'],['book','Book Appointment'],['staff','Staff login']];
  return [can('reception')&&['rec','Reception'], can('doctor')&&['doc','Doctor'], can('lab')&&['lab','Lab'], ['pat','Patient Portal']].filter(Boolean);
}
function go(v){
  const ok = tabs().map(t => t[0]);
  if (session && !me) v = 'staff';
  else if (!ok.includes(v)) v = ok[0];
  view = v;
  ['rec','doc','lab','pat','book'].forEach(s => $('#'+s).hidden = s !== v);
  $('#login').hidden = v !== 'staff';
  $('#nav').replaceChildren(...tabs().map(([k,l]) => h('button',{class:k===view?'on':'',onclick:()=>go(k)},l)));
  const t = TITLES[v]; $('#ptitle').textContent = t[0]; $('#h1').textContent = t[1]; $('#sub').textContent = t[2];
  $('#who').textContent = me ? me.full_name + ' · ' + me.role : '';
  $('#out').hidden = !session;
  if (v === 'doc' && me.role === 'doctor') { $('#dsel').value = me.doctor_id; $('#dpick').hidden = true; } else $('#dpick').hidden = false;
  render();
}
$('#out').onclick = () => sb.auth.signOut();
$('#lgo').onclick = async () => {
  $('#lerr').textContent = 'Logging in…';
  const {error} = await sb.auth.signInWithPassword({email:$('#le').value.trim(), password:$('#lp').value});
  if (error) $('#lerr').textContent = error.message === 'Email not confirmed' ? 'Email not confirmed: in Supabase > Authentication > Users, open this user and confirm it (or delete and re-add with Auto Confirm User ticked).' : error.message;
  else $('#lerr').textContent = '';
};

/* ---------- public: book appointment ---------- */
$('#bgo').onclick = async () => {
  const {error} = await sb.rpc('request_appointment', {p_name:$('#bn').value, p_phone:$('#bp').value, p_doctor:$('#bdoc').value, p_date:$('#bdt').value || null, p_reason:$('#br').value});
  $('#berr').textContent = error ? 'Please enter your name and phone.' : '';
  $('#bok').hidden = !!error;
  if (!error) ['#bn','#bp','#br','#bdt'].forEach(s => $(s).value = '');
};

/* ---------- reception ---------- */
$('#rgo').onclick = async () => {
  const name = $('#rn').value.trim(), phone = $('#rp').value.trim();
  if (!name || !phone) { $('#rerr').textContent = 'Name and phone are required.'; return; }
  const {data:v, error} = await sb.rpc('register_visit', {p_name:name, p_phone:phone, p_age:$('#ra').value ? +$('#ra').value : null, p_reason:$('#rr').value.trim(), p_doctor:$('#rd').value});
  if (error) { $('#rerr').textContent = error.message; return; }
  $('#rerr').textContent = '';
  if (apptId) { await sb.from('appointments').update({status:'converted'}).eq('id', apptId); apptId = null; }
  ['#rn','#rp','#ra','#rr'].forEach(s => $(s).value = '');
  const s = $('#slip'); s.hidden = false;
  s.replaceChildren(h('div',{class:'muted'},'Give this slip to the patient'),
    h('div',null,'Bill no: ',h('b',null,v.bill)), h('div',null,'Access code: ',h('b',null,v.code)),
    h('div',{class:'muted'}, v.name+' · '+tk(v.token)+' · '+doc(v.doctor_id).name));
  renderRec();
};
const todays = async () => (await sb.from('visits').select('*').eq('visit_date', today()).order('created_at')).data || [];
async function renderRec(){
  VT = await todays();
  $('#rlist').replaceChildren(...(VT.length ? [...VT].reverse().map(v => h('div',{class:'row'},
    h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.bill+' · code '+v.code+' · '+doc(v.doctor_id).name+' · '+tk(v.token))),
    h('div',null,st(v.status),' ',h('span',{class:v.paid_at?'paid':'due'},v.paid_at?'Paid':'Unpaid')))) : empty('No visits yet today.')));
  const reqs = (await sb.from('appointments').select('*').eq('status','requested').order('created_at')).data || [];
  $('#reqs').replaceChildren(...(reqs.length ? reqs.map(a => h('div',{class:'row'},
    h('div',null,h('b',null,a.name),h('div',{class:'muted'},a.phone+' · '+doc(a.doctor_id).name+(a.preferred_date?' · '+a.preferred_date:'')+(a.reason?' · '+a.reason:''))),
    h('div',{class:'inl',style:'margin:0'},
      h('button',{class:'btn sm',onclick:()=>{apptId=a.id;$('#rn').value=a.name;$('#rp').value=a.phone;$('#rd').value=a.doctor_id;$('#rr').value=a.reason||'';scrollTo({top:0,behavior:'smooth'})}},'Register'),
      h('button',{class:'btn ghost sm',onclick:async()=>{await sb.from('appointments').update({status:'cancelled'}).eq('id',a.id);renderRec()}},'Dismiss')))) : empty('No pending requests.')));
  const keep = $('#bsel').value;
  $('#bsel').replaceChildren(...VT.map(v => h('option',{value:v.id},v.bill+' — '+v.name)));
  if (VT.some(v => String(v.id) === keep)) $('#bsel').value = keep;
  renderBill();
}
async function renderBill(){
  const v = VT.find(x => String(x.id) === $('#bsel').value);
  if (!v) { $('#bitems').replaceChildren(...empty('Register a patient first.')); return; }
  const items = (await sb.from('bill_items').select('*').eq('visit_id', v.id).order('id')).data || [];
  const tot = items.reduce((s,i) => s + Number(i.amount), 0);
  $('#bitems').replaceChildren(...items.map(i => h('div',{class:'row'},h('span',null,i.description),
      h('span',null,rs(i.amount),' ',h('a',{class:'muted',href:'#',onclick:async e=>{e.preventDefault();await sb.from('bill_items').delete().eq('id',i.id);renderBill()}},'✕')))),
    h('div',{class:'row'},h('b',null,'Total'),h('b',null,rs(tot))));
  $('#bpaid').textContent = v.paid_at ? 'Mark as unpaid' : 'Mark paid';
}
$('#bsel').onchange = renderBill;
$('#badd').onclick = async () => {
  const id = +$('#bsel').value, d = $('#bd').value.trim(), a = parseFloat($('#ba').value);
  if (!id || !d || !(a >= 0)) return;
  await sb.from('bill_items').insert({visit_id:id, description:d, amount:a});
  $('#bd').value = ''; $('#ba').value = ''; renderBill();
};
$('#bpaid').onclick = async () => {
  const v = VT.find(x => String(x.id) === $('#bsel').value); if (!v) return;
  await sb.from('visits').update({paid_at: v.paid_at ? null : new Date().toISOString()}).eq('id', v.id); renderRec();
};

/* ---------- doctor ---------- */
$('#dsel').onchange = renderDoc;
async function act(id, patch){ await sb.from('visits').update(patch).eq('id', id); renderDoc(); }
async function renderDoc(){
  const did = $('#dsel').value;
  const mine = (await todays()).filter(v => v.doctor_id === did);
  const q = mine.filter(v => v.status==='waiting'||v.status==='review').sort((a,b) => new Date(a.q_at)-new Date(b.q_at));
  const inRoom = mine.filter(v => v.status==='in_room'), pend = mine.filter(v => v.status==='report_pending');
  $('#dview').replaceChildren(
    h('div',{class:'card'},h('h2',null,'In consultation'),...(inRoom.length ? inRoom.map(v => {
      const t = h('input',{placeholder:'Test / report (e.g. Blood test)'});
      const m = h('select',null,...[15,30,60,120,240].map(x => h('option',{value:x}, x<60 ? x+' min' : x/60+' hr')));
      return h('div',{class:'row'},
        h('div',null,h('b',null,v.name),h('div',{class:'muted'},(v.age?v.age+' yrs · ':'')+(v.reason||'No reason noted')+(v.test_name?' · report: '+v.test_name:'')),
          v.report_path && h('a',{class:'paid',href:rurl(v.report_path),target:'_blank',rel:'noopener'},'Open uploaded report')),
        h('div',{style:'flex-basis:100%'},h('div',{class:'inl'},t,m,
          h('button',{class:'btn sm',onclick:()=>{ if(!t.value.trim()) return; act(v.id,{status:'report_pending',test_name:t.value.trim(),test_due:new Date(Date.now()+m.value*60000).toISOString(),report_path:null}); }},'Send for report'),
          h('button',{class:'btn ghost sm',onclick:()=>act(v.id,{status:'done'})},'Complete visit'))));
    }) : empty('Nobody in the room.'))),
    h('div',{class:'card'},h('h2',null,'Waiting queue ('+q.length+')'),...(q.length ? q.map((v,i) => h('div',{class:'row'},
      h('div',null,h('b',null,'#'+(i+1)+' '+v.name),h('div',{class:'muted'},tk(v.token)+(v.status==='review'?' · returning with report':'')+(v.reason?' · '+v.reason:''))),
      h('button',{class:'btn sm',onclick:()=>act(v.id,{status:'in_room'})},'Call in'))) : empty('Queue is empty.'))),
    h('div',{class:'card'},h('h2',null,'Reports pending (lab)'),...(pend.length ? pend.map(v => h('div',{class:'row'},
      h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.test_name+' · due '+hm(v.test_due))),st('report_pending'))) : empty('No pending reports.'))));
}

/* ---------- lab ---------- */
async function renderLab(){
  const l = (await todays()).filter(v => v.status === 'report_pending').sort((a,b) => new Date(a.test_due)-new Date(b.test_due));
  $('#lview').replaceChildren(...(l.length ? l.map(v => {
    const f = h('input',{type:'file',accept:'.pdf,image/*'});
    return h('div',{class:'row'},
      h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.test_name+' · '+doc(v.doctor_id).name+' · due '+hm(v.test_due))),
      h('div',{class:'inl',style:'margin:0;flex:1;justify-content:flex-end'},f,h('button',{class:'btn sm',onclick:async()=>{
        let path = null; const file = f.files[0];
        if (file) { path = crypto.randomUUID()+'/'+file.name.replace(/[^\w.\-]/g,'_'); const {error} = await sb.storage.from('reports').upload(path,file); if (error) { alert(error.message); return; } }
        await sb.from('visits').update({status:'review', q_at:new Date().toISOString(), report_path:path}).eq('id', v.id); renderLab();
      }},'Upload & mark ready')));
  }) : empty('No reports waiting.')));
}

/* ---------- patient portal ---------- */
$('#pgo').onclick = () => { cur = {b:$('#pb').value.trim(), c:$('#pc').value.trim()}; renderPat(true); };
async function renderPat(first){
  if (!cur) return;
  const {data:v} = await sb.rpc('patient_status', {p_bill:cur.b, p_code:cur.c});
  if (!v || v.locked) {
    if (first) { $('#perr').textContent = v ? 'Too many wrong tries. Please wait 15 minutes or ask reception.' : 'Bill number or code is incorrect.'; $('#pres').replaceChildren(); }
    cur = null; return;
  }
  $('#perr').textContent = '';
  const inQ = v.pos != null, ahead = inQ ? v.pos-1+v.in_room : 0;
  const idx = {waiting:1,in_room:v.test_name?4:2,report_pending:3,review:4,done:5}[v.status];
  let rStat = 'No report ordered', rWait = '—', msg = '';
  if (v.test_name) rStat = v.status==='report_pending' ? 'In progress' : 'Ready';
  if (v.status==='report_pending') { const r = Math.ceil((new Date(v.test_due)-Date.now())/60000); rWait = r>0 ? r+' min' : 'Due now'; }
  if (v.status==='waiting') msg = 'Please wait. You will be called to '+v.doctor+' soon.';
  if (v.status==='in_room') msg = 'You are with '+v.doctor+' now.';
  if (v.status==='report_pending') msg = 'Your '+v.test_name+' report is expected by '+hm(v.test_due)+'. After it is ready, expect about '+(v.queue_len*v.avg_min)+' min wait to see the doctor again.';
  if (v.status==='review') msg = 'Your report is ready. Please wait to be called back to '+v.doctor+'.';
  if (v.status==='done') msg = 'Your visit is complete. Thank you.';
  $('#pres').replaceChildren(h('div',{class:'card'},
    h('div',{class:'row',style:'border:0;padding:0'},h('div',null,h('h3',null,v.name),h('div',{class:'muted'},v.bill+' · '+v.doctor+' · '+v.dept+' · '+tk(v.token))),st(v.status)),
    h('div',{class:'steps'},...['Registered','Waiting','Consultation','Report','Review','Done'].map((s,i) => h('span',{class:i<idx?'d':i===idx?'on':''},s))),
    h('div',{class:'tiles'},
      h('div',{class:'tile'},h('small',null,'Waiting list no.'),h('strong',null,inQ?'#'+v.pos:'—')),
      h('div',{class:'tile'},h('small',null,'Estimated wait'),h('strong',null,inQ?(ahead*v.avg_min)+' min':'—')),
      h('div',{class:'tile'},h('small',null,'Report status'),h('strong',{style:'font-size:18px;margin-top:6px'},rStat)),
      h('div',{class:'tile'},h('small',null,'Report waiting time'),h('strong',null,rWait)),
      h('div',{class:'tile'},h('small',null,'Bill'),h('strong',null,rs(v.total)),h('span',{class:v.paid?'paid':'due'},v.total>0?(v.paid?'Paid':'Due'):'No charges yet'))),
    v.report_path && h('p',null,h('a',{class:'btn sm',href:rurl(v.report_path),target:'_blank',rel:'noopener'},'Download my report')),
    h('div',{class:'note'},msg),h('p',{class:'muted',style:'margin-top:10px;font-size:12px'},'Updated '+hm(Date.now())+' · refreshes automatically')));
}

/* ---------- boot ---------- */
function render(){ ({rec:renderRec, doc:renderDoc, lab:renderLab, pat:()=>{const f=AUTO;AUTO=false;return renderPat(f)}})[view]?.(); }
setInterval(() => { if (document.hidden) return; if (!['INPUT','SELECT'].includes(document.activeElement.tagName)) render(); }, 5000);
(async () => {
  DOCS = (await sb.from('doctors').select('*').order('id')).data || [];
  ['#rd','#dsel','#bdoc'].forEach(s => DOCS.forEach(d => $(s).append(h('option',{value:d.id},d.name+' — '+d.dept))));
  // setTimeout: calling Supabase inside this callback without it can freeze the login (known supabase-js deadlock)
  sb.auth.onAuthStateChange((_e, s) => setTimeout(async () => {
    session = s; me = null;
    if (s) {
      const r = await sb.from('profiles').select('*').eq('id', s.user.id).maybeSingle();
      me = r.data;
      if (r.error) $('#lerr').textContent = 'Could not read your role: ' + r.error.message + ' (did you run setup.sql?)';
      else if (!me) $('#lerr').textContent = 'Logged in, but this account has no role yet. Run staff-setup.sql with this email.';
    }
    go(me ? tabs()[0][0] : (['book','staff'].includes(view) ? view : 'pat'));
  }, 0));
})();
