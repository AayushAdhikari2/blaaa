const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
if (SUPABASE_URL.includes('YOUR-PROJECT')) document.body.prepend(Object.assign(document.createElement('div'),{className:'note setupbar',style:'margin:0;text-align:center',textContent:'Setup needed: open app/config.js and paste your Supabase URL and anon key, then run app/setup.sql. Open check.html to test.'}));
const $ = s => document.querySelector(s);
const TZ = 'Asia/Kathmandu';
const today = () => new Date().toLocaleDateString('en-CA', {timeZone: TZ});
const hm = t => new Date(t).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
const rs = n => 'Rs ' + Number(n).toLocaleString();
const tk = n => 'T-' + String(n).padStart(2, '0');
const LBL = {waiting:'Waiting', in_room:'With doctor', report_pending:'Report pending', review:'Waiting for review', done:'Completed'};
// Reports are private. Every click asks for a fresh link that expires in 5 minutes.
// The tab is opened first (inside the click) so pop-up blockers allow it.
async function openReport(getUrl, btn){
  const w = window.open('', '_blank'); const old = btn.textContent; btn.textContent = 'Opening…';
  try {
    const url = await getUrl();
    if (w) { w.opener = null; w.location = url; } else location.href = url;
  } catch (e) { if (w) w.close(); toast(e.message || 'Could not open the report.', true); }
  finally { btn.textContent = old; }
}
const staffReportUrl = (p, vid) => async () => {
  if (vid) sb.rpc('log_report_open', {p_visit: vid}).then(() => {}, () => {});   // audit: who opened which report
  const {data, error} = await sb.storage.from('reports').createSignedUrl(p, 300);
  if (error) throw new Error('Could not open the report: ' + error.message);
  return data.signedUrl;
};
const patientReportUrl = (b, c) => async () => {
  const {data, error} = await sb.functions.invoke('report-link', {body:{bill:b, code:c}});
  if (error) { let m = 'Could not open the report. Please ask reception.'; try { m = (await error.context.json()).error || m; } catch(_) {} throw new Error(m); }
  return data.url;
};
function h(t, a, ...k){const e=document.createElement(t);for(const x in a||{}){if(a[x]==null||a[x]===false)continue;if(x==='onclick')e.onclick=a[x];else if(x==='class')e.className=a[x];else e.setAttribute(x,a[x])}k.flat().filter(c=>c!=null&&c!==false).forEach(c=>e.append(c instanceof Node?c:document.createTextNode(c)));return e}
const empty = t => [h('p',{class:'muted empty'},t)];
const st = s => h('span',{class:'st '+s}, LBL[s]);

const HASH = location.hash.slice(1);
let SET = {}, DOCS = [], session = null, me = null, view = ['pat','book','staff','board','xray'].includes(HASH) ? HASH : 'pat', cur = null, apptId = null, VT = [];
const can = r => me && (me.role === 'admin' || me.role === r);
const QP = new URLSearchParams(location.search); let AUTO = false;
if (QP.get('b') && QP.get('c')) {
  cur = {b:QP.get('b').trim(), c:QP.get('c').trim()}; view = 'pat'; AUTO = true;
  $('#pb').value = cur.b; $('#pc').value = cur.c;
  history.replaceState(null, '', location.pathname + '#pat');   // keep the code out of the address bar
} else if (QP.get('b')) { $('#pb').value = QP.get('b').trim(); view = 'pat'; history.replaceState(null, '', location.pathname + '#pat'); }
const doc = id => DOCS.find(d => d.id === id) || {name:'—'};

/* ---------- navigation ---------- */
const TITLES = {pat:['Patient status','Know exactly where you are in the queue.','Enter your bill number and code to see your waiting number, report status and bill.'],
  book:['Appointments','Book your appointment online.','Send a request and reception will confirm by phone.'],
  staff:['Staff','Staff login.','Sign in to continue.'],
  board:['Queue board','Now serving.','Token numbers only. Names are never shown here.'],
  rec:['Reception','Reception desk.','Register patients, handle online requests and billing.'],
  doc:['Doctor','Consultation queue.','Call patients in, order reports, prescribe and review results.'],
  lab:['Lab','Reports to prepare.','Upload results and mark reports ready.'],
  pha:['Pharmacy','Prescriptions and stock.','Dispense medicines safely: allergy and interaction checks run on every prescription.'],
  wrd:['Wards','Beds and admissions.','Admit, transfer and discharge patients. Bed charges go to the bill.'],
  clm:['Claims','Insurance claims.','Track each claim from draft to paid.'],
  adm:['Admin','Manage your clinic.','Team, settings, reports, messages, privacy and audit log.'],
  sec:['Security','Your login security.','Protect your account with an authenticator app.'],
  xray:['AI X-ray','Upload an X-ray for an AI draft report.','A doctor checks every report before you can read it. This is not an emergency service.'],
  xrv:['X-ray review','Check AI X-ray drafts.','Look at the original X-ray, correct the draft, then approve it under your name.']};
// every screen is listed here once: [id, label, who can see it]
// line icons (24x24, stroke). Constant markup only, never user data.
const ICONS = {
  adm:'<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  rec:'<circle cx="9" cy="7" r="4"/><path d="M3 21v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1M19 8v6M22 11h-6"/>',
  doc:'<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  lab:'<path d="M9 3h6M10 3v6l-5.5 10a1.6 1.6 0 0 0 1.4 2.3h12.2a1.6 1.6 0 0 0 1.4-2.3L14 9V3M7.5 14h9"/>',
  pha:'<path d="m10.5 20.5-7-7a4.95 4.95 0 0 1 7-7l7 7a4.95 4.95 0 0 1-7 7zM8.5 8.5l7 7"/>',
  wrd:'<path d="M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8M2 17h20M6 10V7a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3"/>',
  clm:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6"/>',
  board:'<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  pat:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  book:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  staff:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  sec:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  more:'<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
  xray:'<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 12h8M12 8v8"/>',
  xrv:'<path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"/>',
  fb:'<path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l1.9-5.7A8.4 8.4 0 1 1 21 11.5z"/>'};
const SHORT = {adm:'Admin',rec:'Reception',doc:'Doctor',lab:'Lab',pha:'Pharmacy',wrd:'Wards',clm:'Claims',board:'Board',pat:'Status',book:'Book',staff:'Staff',sec:'Security',xray:'X-ray',xrv:'Review'};
const icon = k => { const e = document.createElement('span'); e.className = 'ico'; e.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[k] || ICONS.more) + '</svg>'; return e; };
const isPhone = () => !!(window.matchMedia && window.matchMedia('(max-width: 899px)').matches);
function closeSheet(){ $('#sheet').hidden = true; $('#sheetbg').hidden = true; }
function openSheet(more){
  const sh = $('#sheet');
  sh.replaceChildren(h('div',{class:'grab'}), me ? h('div',{class:'who2'},'Signed in as '+me.full_name+' · '+me.role) : null,
    ...more.map(([k,l]) => h('button',{class:'item'+(k===view?' on':''),onclick:()=>{closeSheet();go(k)}}, icon(k), l)),
    me ? h('hr') : null,
    me ? h('button',{class:'item',onclick:()=>{closeSheet();$('#fbbtn')?.click()}}, icon('fb'), 'Send feedback') : null);
  sh.hidden = false; $('#sheetbg').hidden = false;
}
$('#sheetbg').onclick = closeSheet;
function renderNav(){
  const all = tabs(), MAX = 5, split = isPhone() && all.length > MAX;
  const main = split ? all.slice(0, MAX-1) : all, more = split ? all.slice(MAX-1) : [];
  const tab = ([k,l]) => h('button',{class:'tab'+(k===view?' on':''),'aria-current':k===view?'page':false,onclick:()=>{closeSheet();go(k)}},
    icon(k), h('span',{class:'lb s'},SHORT[k]||l), h('span',{class:'lb l'},l));
  const nodes = main.map(tab);
  if (more.length) nodes.push(h('button',{class:'tab'+(more.some(t=>t[0]===view)?' on':''),'aria-haspopup':'dialog',onclick:()=>openSheet(more)},
    icon('more'), h('span',{class:'lb s'},'More'), h('span',{class:'lb l'},'More')));
  $('#nav').replaceChildren(...nodes);
}
if (window.matchMedia) window.matchMedia('(max-width: 899px)').addEventListener?.('change', () => { closeSheet(); if (session ? me : true) renderNav(); });
const TABDEF = [
  ['adm','Admin', () => me.role==='admin'], ['rec','Reception', () => can('reception')], ['doc','Doctor', () => can('doctor')],
  ['lab','Lab', () => can('lab')], ['pha','Pharmacy', () => can('pharmacy')],
  ['wrd','Wards', () => ['reception','doctor','admin'].includes(me.role)], ['clm','Claims', () => ['reception','admin'].includes(me.role)],
  ['xrv','X-ray review', () => ['doctor','admin'].includes(me.role)],
  ['board','Queue board', () => true], ['pat','Patient Portal', () => true], ['xray','AI X-ray', () => true], ['sec','Security', () => true]];
const RENDER = {adm:() => renderAdm(), rec:() => renderRec(), doc:() => renderDoc(), lab:() => renderLab(), pha:() => renderPha(),
  wrd:() => renderWrd(), clm:() => renderClm(), board:() => renderBoard(), sec:() => renderSec(), xray:() => renderXray(), xrv:() => renderXrv(), book:() => loadTerms(),
  pat:() => {const f=AUTO;AUTO=false;return renderPat(f)}};
function tabs(){
  if (!me) return [['pat','Patient Portal'],['book','Book Appointment'],['xray','AI X-ray'],['board','Queue board'],['staff','Staff login']];
  return TABDEF.filter(t => t[2]()).map(t => [t[0], t[1]]);
}
function go(v){
  const ok = tabs().map(t => t[0]);
  if (session && !me) v = 'staff';
  else if (!ok.includes(v)) v = ok[0];
  view = v;
  document.querySelectorAll('main > section').forEach(x => x.hidden = x.id !== (v === 'staff' ? 'login' : v));
  closeSheet(); renderNav(); scrollTo({top:0});
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
// The booking terms and conditions are written by the clinic (Admin > Settings) and read from the database, so patients always see the current text.
let TERMS_OK = false;
async function loadTerms(){
  const box = $('#bterms'); if (!box) return;
  const {data, error} = await sb.rpc('public_terms');
  const text = data && data.text && data.text.trim();
  TERMS_OK = !error && !!text;
  box.replaceChildren(...(TERMS_OK ? text.split(/\n\s*\n/).map(t => h('p', null, t.trim())) : [h('p', {class:'err'}, 'The terms and conditions could not be loaded. Check your connection and try again.')]));
}
$('#bgo').onclick = async () => {
  if (!TERMS_OK) { await loadTerms(); if (!TERMS_OK) { $('#berr').textContent = 'The terms and conditions could not be loaded, so the request cannot be sent. Try again.'; return; } }
  if (!$('#bcons').checked) { $('#berr').textContent = 'Please read the terms and conditions and tick the box to agree.'; $('#bok').hidden = true; $('#bcons').focus(); return; }
  const {error} = await sb.rpc('request_appointment', {p_name:$('#bn').value, p_phone:$('#bp').value, p_doctor:$('#bdoc').value, p_date:$('#bdt').value || null, p_reason:$('#br').value, p_consent:true, p_sms:$('#bsms').checked});
  const m = error && error.message || '';
  $('#berr').textContent = !error ? '' : /too many/i.test(m) ? 'Too many requests from this number. Please call the clinic.' : /busy/i.test(m) ? 'The system is busy. Please try again later.' : 'Please enter your name and phone.';
  $('#bok').hidden = !!error;
  if (!error) { ['#bn','#bp','#br','#bdt'].forEach(x => $(x).value = ''); $('#bcons').checked = false; $('#bsms').checked = false; UI.toast('Request sent. Reception will confirm by phone.', 'success'); }
  else UI.toast($('#berr').textContent, 'error');
};

/* ---------- reception ---------- */
$('#rgo').onclick = async () => {
  const name = $('#rn').value.trim(), phone = $('#rp').value.trim();
  if (!name || !phone) { $('#rerr').textContent = 'Name and phone are required.'; return; }
  if (!$('#rcons').checked) { $('#rerr').textContent = 'Tick “Privacy notice explained to the patient” first.'; return; }
  const {data:v, error} = await sb.rpc('register_visit', {p_name:name, p_phone:phone, p_age:$('#ra').value ? +$('#ra').value : null, p_reason:$('#rr').value.trim(), p_doctor:$('#rd').value,
    p_allergies:$('#ral').value.trim() || null, p_consent_sms:$('#rsms').checked, p_consent_version:PRIVACY_VERSION});
  if (error) { $('#rerr').textContent = error.message; return; }
  $('#rerr').textContent = '';
  if (apptId) { await sb.from('appointments').update({status:'converted'}).eq('id', apptId); apptId = null; }
  ['#rn','#rp','#ra','#rr','#ral'].forEach(s => $(s).value = ''); $('#rsms').checked = false; $('#rcons').checked = false; $('#rdup').hidden = true;
  const s = $('#slip'); s.hidden = false;
  s.replaceChildren(h('div',{class:'muted'},'Give this slip to the patient'),
    h('div',null,'Bill no: ',h('b',null,v.bill)), h('div',null,'Access code: ',h('b',null,v.code)),
    h('div',{class:'muted'}, v.name+' · '+tk(v.token)+' · '+doc(v.doctor_id).name+(v.consent_sms?' · SMS on':'')),
    h('div',{class:'inl'},h('button',{class:'btn sm',onclick:()=>printSlip(v)},'Print slip')));
  kick(); renderRec();
};
const todays = async () => (await sb.from('visits').select('*').eq('visit_date', today()).order('created_at')).data || [];
async function renderRec(){
  VT = await todays();
  $('#rlist').replaceChildren(...(VT.length ? [...VT].reverse().map(v => h('div',{class:'row'},
    h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.bill+' · code '+v.code+' · '+doc(v.doctor_id).name+' · '+tk(v.token))),
    h('div',null,st(v.status),' ',h('span',{class:v.paid_at?'paid':'due'},v.paid_at?'Paid':'Unpaid'),' ',h('button',{class:'btn ghost sm',onclick:()=>printSlip(v)},'Slip')))) : empty('No visits yet today.')));
  const reqs = (await sb.from('appointments').select('*').eq('status','requested').order('created_at')).data || [];
  $('#reqs').replaceChildren(...(reqs.length ? reqs.map(a => h('div',{class:'row'},
    h('div',null,h('b',null,a.name),h('div',{class:'muted'},a.phone+' · '+doc(a.doctor_id).name+(a.preferred_date?' · '+a.preferred_date:'')+(a.reason?' · '+a.reason:''))),
    h('div',{class:'inl',style:'margin:0'},
      h('button',{class:'btn sm',onclick:()=>{apptId=a.id;$('#rn').value=a.name;$('#rp').value=a.phone;$('#rd').value=a.doctor_id;$('#rr').value=a.reason||'';$('#rsms').checked=!!a.consent_sms;checkDup();scrollTo({top:0,behavior:'smooth'})}},'Register'),
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
      h('span',null,rs(i.amount),' ',h('a',{class:'muted',href:'#',role:'button','aria-label':'Remove charge '+i.description,title:'Remove this charge',onclick:async e=>{e.preventDefault();if(!await ask({title:'Remove this charge?',message:i.description+' · '+rs(i.amount)+' will be taken off the bill.',confirm:'Remove charge',danger:true}))return;const {error}=await sb.from('bill_items').delete().eq('id',i.id);if(error)toast('Could not remove the charge: '+error.message,true);else toast('Charge removed.');renderBill()}},'✕')))),
    h('div',{class:'row'},h('b',null,'Total'),h('b',null,rs(tot))));
  $('#bpaid').textContent = v.paid_at ? 'Mark as unpaid' : 'Mark paid';
}
$('#bsel').onchange = renderBill;
$('#badd').onclick = async () => {
  const id = +$('#bsel').value, d = $('#bd').value.trim(), a = parseFloat($('#ba').value);
  if (!id || !d || !(a >= 0)) { UI.toast('Choose a visit and enter the charge name and amount.', 'warning'); return; }
  const {error} = await sb.from('bill_items').insert({visit_id:id, description:d, amount:a});
  if (error) { toast('Could not add the charge: ' + error.message, true); return; }
  toast('Added ' + d + ' · ' + rs(a) + '.');
  $('#bd').value = ''; $('#ba').value = ''; renderBill();
};
$('#bpaid').onclick = async e => {
  const v = VT.find(x => String(x.id) === $('#bsel').value); if (!v) return;
  const btn = e.currentTarget;
  const items = (await sb.from('bill_items').select('amount').eq('visit_id', v.id)).data || [], tot = items.reduce((s,i) => s + Number(i.amount), 0);
  const undo = !!v.paid_at;
  if (!await ask({title: undo ? 'Mark this bill as unpaid?' : 'Record payment?', message: v.bill+' · '+tk(v.token)+' · total '+rs(tot)+(undo ? '. Use this only to correct a mistake. The change is recorded in the audit log.' : '. Confirm that the money has been received.'), confirm: undo ? 'Mark unpaid' : 'Payment received', danger: undo})) return;
  await busy(btn, 'Saving…', async () => {
    const {error} = await sb.from('visits').update({paid_at: undo ? null : new Date().toISOString()}).eq('id', v.id);
    if (error) toast('Could not save the payment: ' + error.message, true); else toast(undo ? 'Marked as unpaid.' : 'Payment recorded for ' + v.bill + '.');
    renderRec();
  });
};

/* ---------- small UI helpers (busy buttons, drafts) ---------- */
// toast() now lives in ui.js (one toast + dialog system for the whole app)
async function busy(btn, label, fn){
  if (btn.disabled) return;
  const old = btn.textContent; btn.disabled = true; btn.textContent = label;
  try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
}
// What staff have typed / picked but not sent yet. Survives the 5-second auto-refresh.
const DRAFT = {};
const dr = (k, d) => (k in DRAFT ? DRAFT[k] : d);

/* ---------- doctor ---------- */
$('#dsel').onchange = renderDoc;
async function act(id, patch){
  const {error} = await sb.from('visits').update(patch).eq('id', id);
  if (error) { toast('Could not save: ' + error.message, true); return false; }
  kick(); renderDoc(); return true;
}
const TESTS = ['Blood test','Urine test','X-ray','ECG','Ultrasound'];
const WAITS = [[15,'15 min'],[30,'30 min'],[60,'1 hour'],[120,'2 hours'],[240,'4 hours'],[1440,'Next day']];
async function renderDoc(){
  const did = $('#dsel').value;
  await window.loadDrugs?.();
  const mine = (await todays()).filter(v => v.doctor_id === did);
  const q = mine.filter(v => v.status==='waiting'||v.status==='review').sort((a,b) => new Date(a.q_at)-new Date(b.q_at));
  const inRoom = mine.filter(v => v.status==='in_room'), pend = mine.filter(v => v.status==='report_pending');
  $('#dview').replaceChildren(
    h('div',{class:'card'},h('h2',null,'In consultation'),...(inRoom.length ? inRoom.map(roomRow) : empty('Nobody in the room.'))),
    h('div',{class:'card'},h('h2',null,'Waiting queue ('+q.length+')'),...(q.length ? q.map((v,i) => h('div',{class:'row'},
      h('div',null,h('b',null,'#'+(i+1)+' '+v.name),h('div',{class:'muted'},tk(v.token)+(v.status==='review'?' · returning with report':'')+(v.reason?' · '+v.reason:''))),
      h('button',{class:'btn sm',onclick:e=>busy(e.target,'Calling…',()=>act(v.id,{status:'in_room'}))},'Call in'))) : empty('Queue is empty.'))),
    h('div',{class:'card'},h('h2',null,'Reports pending (lab)'),...(pend.length ? pend.map(v => h('div',{class:'row'},
      h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.test_name+' · expected '+hm(v.test_due))),st('report_pending'))) : empty('No pending reports.'))));
}
function roomRow(v){
  const kt = 'test:'+v.id, km = 'mins:'+v.id;
  const t = h('input',{id:'t'+v.id,placeholder:'e.g. Blood test',maxlength:'80',value:dr(kt,'')});
  const err = h('div',{class:'err',style:'margin-top:6px'});
  const m = h('select',{id:'m'+v.id},...WAITS.map(([x,l]) => h('option',{value:x},l)));
  m.value = dr(km, 30);
  t.oninput = () => { DRAFT[kt] = t.value; err.textContent = ''; };
  m.onchange = () => DRAFT[km] = m.value;
  const chips = h('div',{class:'chips'},...TESTS.map(n => h('button',{type:'button',class:'chip',onclick:()=>{t.value = n; DRAFT[kt] = n; err.textContent=''; t.focus();}},n)));
  const send = h('button',{class:'btn',onclick:e => {
    const name = t.value.trim();
    if (!name) { err.textContent = 'Type or pick which test is needed.'; t.focus(); return; }
    return busy(e.target,'Sending…',async()=>{
      const ok = await act(v.id,{status:'report_pending',test_name:name,test_due:new Date(Date.now()+m.value*60000).toISOString(),report_path:null});
      if (ok) { delete DRAFT[kt]; delete DRAFT[km]; toast('Sent to lab: '+name+' for '+v.name+'. Patient is notified on their status page.'); }
    });
  }},'Send to lab');
  const done = h('button',{class:'btn ghost sm',onclick:async e => {
    const btn = e.target;
    if (!await ask({title:'Complete this visit?', message:tk(v.token)+' · '+v.name+' will be removed from your list. Order a test first if one is still needed.', confirm:'Complete visit'})) return;
    return busy(btn,'Saving…',async()=>{ if (await act(v.id,{status:'done'})) toast('Visit completed: '+v.name); });
  }},'Complete visit');
  return h('div',{class:'room'},
    h('div',{class:'row',style:'border:0;padding:0'},
      h('div',null,h('b',null,v.name),h('div',{class:'muted'},(v.age?v.age+' yrs · ':'')+(v.reason||'No reason noted')+(v.test_name?' · earlier report: '+v.test_name:'')),
        v.report_path && h('a',{class:'paid',href:'#',onclick:e=>{e.preventDefault();openReport(staffReportUrl(v.report_path, v.id),e.target)}},'Open uploaded report')),
      done),
    h('div',{class:'panel'},h('h3',null,'Order a report / test'),
      h('label',{for:'t'+v.id},'Test needed'),t,chips,
      h('label',{for:'m'+v.id},'Report ready in (estimate shown to patient)'),m,err,
      h('div',{class:'inl'},send,h('span',{class:'muted',style:'font-size:12px'},'The patient goes back to the queue when the lab uploads the result.'))),
    window.rxPanel ? window.rxPanel(v) : null);
}

/* ---------- lab ---------- */
const MAXMB = 10;
async function renderLab(){
  const l = (await todays()).filter(v => v.status === 'report_pending').sort((a,b) => new Date(a.test_due)-new Date(b.test_due));
  $('#lview').replaceChildren(...(l.length ? l.map(labRow) : empty('No reports waiting.')));
}
function labRow(v){
  const kf = 'file:'+v.id;
  const late = new Date(v.test_due) < Date.now();
  const err = h('div',{class:'err',style:'margin-top:6px'});
  const input = h('input',{type:'file',accept:'.pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp',hidden:'hidden'});
  const name = h('span',{class:'fname'}, DRAFT[kf] ? DRAFT[kf].name + ' (' + (DRAFT[kf].size/1048576).toFixed(1) + ' MB)' : 'No file chosen');
  const pick = h('button',{type:'button',class:'btn ghost sm',onclick:()=>input.click()}, DRAFT[kf] ? 'Change file' : 'Choose PDF / photo');
  input.onchange = () => {
    const f = input.files[0]; err.textContent = '';
    if (!f) return;
    if (f.size > MAXMB*1048576) { err.textContent = 'File is larger than '+MAXMB+' MB. Please compress it or choose another.'; return; }
    if (!['application/pdf','image/jpeg','image/png','image/webp'].includes(f.type)) { err.textContent = 'Only PDF, JPG, PNG or WebP files are allowed.'; return; }
    DRAFT[kf] = f; name.textContent = f.name + ' (' + (f.size/1048576).toFixed(1) + ' MB)'; pick.textContent = 'Change file';
  };
  const finish = async (path) => {
    const {error} = await sb.from('visits').update({status:'review', q_at:new Date().toISOString(), report_path:path}).eq('id', v.id);
    if (error) { err.textContent = 'Could not mark ready: ' + error.message; return; }
    delete DRAFT[kf]; toast('Report ready for '+v.name+'. Patient is back in the doctor’s queue.'); kick(); renderLab();
  };
  const go = h('button',{class:'btn',onclick:e => {
    const file = DRAFT[kf];
    if (!file) { err.textContent = 'Choose the report file first (or use “Mark ready without a file”).'; return; }
    return busy(e.target,'Uploading…',async()=>{
      const path = crypto.randomUUID()+'/'+file.name.replace(/[^\w.\-]/g,'_');
      const {error} = await sb.storage.from('reports').upload(path, file);
      if (error) { err.textContent = 'Upload failed: ' + error.message; return; }
      await finish(path);
    });
  }},'Upload & mark ready');
  const nofile = h('a',{href:'#',class:'muted',style:'font-size:12px',onclick:async e=>{
    e.preventDefault();
    if (await ask({title:'Mark ready without a file?', message:'The patient will see “Ready” but there will be nothing to download.', confirm:'Mark ready', danger:true})) busy(go,'Saving…',()=>finish(null));
  }},'Mark ready without a file');
  return h('div',{class:'room'},
    h('div',{class:'row',style:'border:0;padding:0'},
      h('div',null,h('b',null,v.name),h('div',{class:'muted'},v.test_name+' · '+doc(v.doctor_id).name)),
      h('span',{class:late?'due':'muted'},late?'Overdue · was due '+hm(v.test_due):'Due '+hm(v.test_due))),
    h('div',{class:'inl'},pick,name,input),err,
    h('div',{class:'inl'},go,nofile));
}

/* ---------- admin ---------- */
const ROLES = ['admin','reception','doctor','lab','pharmacy'];
const activeDocs = () => DOCS.filter(d => d.active !== false);
async function loadDocs(){ DOCS = (await sb.from('doctors').select('*').order('id')).data || []; fillDocSelects(); }
function fillDocSelects(){
  ['#rd','#dsel','#bdoc'].forEach(s => { const el = $(s), keep = el.value;
    el.replaceChildren(...activeDocs().map(d => h('option',{value:d.id},d.name+' — '+d.dept)));
    if (activeDocs().some(d => d.id === keep)) el.value = keep; });
}
async function callStaff(body){
  const {data, error} = await sb.functions.invoke('admin-staff', {body});
  if (error) {
    let m = error.message;
    try { const j = await error.context.json(); if (j.error) m = j.error; } catch(_) {}
    if (/Failed to send|not found|404/i.test(m)) m = 'The admin-staff function is not deployed yet (see NEXT-STEPS.md, step 4).';
    throw new Error(m);
  }
  return data;
}
let EDIT = null;   // null = add form, otherwise the staff row being edited
async function renderTeam(){
  const {data, error} = await sb.rpc('admin_list_staff');
  if (error) { $('#astaff').replaceChildren(...empty('Could not load staff: '+error.message+' (did you run schema_v4.sql?)')); return; }
  $('#astaff').replaceChildren(...data.map(u => h('div',{class:'row'},
    h('div',null,h('b',null,u.full_name),h('div',{class:'muted'},u.email+' · last login '+(u.last_sign_in_at?new Date(u.last_sign_in_at).toLocaleDateString():'never'))),
    h('div',{class:'inl',style:'margin:0'},h('span',{class:'st'},u.role+(u.doctor_id?' · '+doc(u.doctor_id).name:'')),
      h('button',{class:'btn ghost sm',onclick:()=>{EDIT=u;fillStaffForm();scrollTo({top:0,behavior:'smooth'})}},'Edit'),
      h('button',{class:'btn ghost sm',title:'Use when someone lost their phone',onclick:async e=>{
        const btn = e.target;
        if (!await ask({title:'Reset two-factor login?', message:'Remove the authenticator from '+u.full_name+'. They will set up a new one at their next login.', confirm:'Reset 2FA', danger:true})) return;
        await busy(btn,'Resetting…',async()=>{ try { await callStaff({action:'reset_mfa',id:u.id}); toast('2FA reset for '+u.full_name); } catch(x){ toast(x.message,true); } });
      }},'Reset 2FA'),
      h('button',{class:'btn ghost sm',onclick:async e=>{
        if (u.id === session.user.id) { toast('You cannot remove your own account.', true); return; }
        const btn = e.target;
        if (!await ask({title:'Remove this staff account?', message:u.full_name+' ('+u.email+') will no longer be able to log in. This cannot be undone.', confirm:'Remove account', danger:true})) return;
        await busy(btn,'Removing…',async()=>{ try { await callStaff({action:'delete',id:u.id}); toast('Removed '+u.full_name); renderTeam(); } catch(x){ toast(x.message,true); } });
      }},'Remove')))));
  renderDocAdmin();
}
function fillStaffForm(){
  const u = EDIT;
  $('#sh').textContent = u ? 'Edit staff' : 'Add staff';
  $('#sn').value = u ? u.full_name : ''; $('#se').value = u ? u.email : ''; $('#se').disabled = !!u;
  $('#sp').value = ''; $('#sp').placeholder = u ? 'Leave empty to keep current password' : 'At least 8 characters';
  $('#sr').value = u ? u.role : 'reception';
  $('#sd').replaceChildren(...activeDocs().map(d => h('option',{value:d.id},d.name+' — '+d.dept)));
  $('#sd').value = u?.doctor_id || ($('#sd').options[0]?.value || '');
  $('#sdw').hidden = $('#sr').value !== 'doctor';
  $('#sgo').textContent = u ? 'Save changes' : 'Create account'; $('#scancel').hidden = !u; $('#serr').textContent = '';
}
$('#sr').onchange = () => $('#sdw').hidden = $('#sr').value !== 'doctor';
$('#scancel').onclick = () => { EDIT = null; fillStaffForm(); };
$('#sgo').onclick = e => {
  const f = {full_name:$('#sn').value.trim(), email:$('#se').value.trim(), password:$('#sp').value, role:$('#sr').value, doctor_id:$('#sr').value==='doctor' ? $('#sd').value : null};
  const bad = !f.full_name ? 'Enter the staff member’s name.' : (!EDIT && !/^\S+@\S+\.\S+$/.test(f.email)) ? 'Enter a valid email.'
    : (!EDIT && f.password.length < 8) || (EDIT && f.password && f.password.length < 8) ? 'Password must be at least 8 characters.'
    : (f.role==='doctor' && !f.doctor_id) ? 'Pick which doctor this login belongs to.' : '';
  if (bad) { $('#serr').textContent = bad; return; }
  $('#serr').textContent = '';
  return busy(e.target, 'Saving…', async () => {
    try {
      if (EDIT) { const b = {action:'update', id:EDIT.id, full_name:f.full_name, role:f.role, doctor_id:f.doctor_id}; if (f.password) b.password = f.password; await callStaff(b); toast('Saved '+f.full_name); }
      else { await callStaff({action:'create', ...f}); toast('Account created for '+f.email+'. Give them the password; they can log in now.'); }
      EDIT = null; fillStaffForm(); renderTeam();
    } catch (x) { $('#serr').textContent = x.message; }
  });
};

function renderDocAdmin(){
  $('#dlist').replaceChildren(...DOCS.map(d => {
    const n = h('input',{value:d.name,'aria-label':'Doctor name'}), dp = h('input',{value:d.dept,list:'depts','aria-label':'Department'}),
      av = h('input',{type:'number',min:'1',max:'120',value:d.avg_min,'aria-label':'Average minutes per patient'}),
      ac = h('input',{type:'checkbox',id:'ac'+d.id}); ac.checked = d.active !== false;
    return h('div',{class:'drow'},n,dp,av,
      h('label',{class:'chk',for:'ac'+d.id},ac,'Active'),
      h('button',{class:'btn sm',onclick:e=>{
        if (!n.value.trim() || !dp.value.trim() || !(+av.value >= 1)) { toast('Name, department and minutes are required.', true); return; }
        return busy(e.target,'Saving…',async()=>{
          const {error} = await sb.from('doctors').update({name:n.value.trim(), dept:dp.value.trim(), avg_min:+av.value, active:ac.checked}).eq('id',d.id);
          if (error) toast(error.message,true); else { toast('Saved '+n.value.trim()); await loadDocs(); renderDocAdmin(); }
        });}},'Save'));
  }));
  $('#depts').replaceChildren(...[...new Set(DOCS.map(d => d.dept))].map(x => h('option',{value:x})));
}
$('#dadd').onclick = e => {
  const name = $('#dn').value.trim(), dept = $('#dd').value.trim(), avg = +$('#dm').value || 10;
  if (!name || !dept) { $('#derr').textContent = 'Enter the doctor’s name and department.'; return; }
  $('#derr').textContent = '';
  return busy(e.target,'Adding…',async()=>{
    const next = Math.max(0, ...DOCS.map(d => parseInt(d.id.slice(1)) || 0)) + 1;
    const {error} = await sb.from('doctors').insert({id:'d'+next, name, dept, avg_min:avg});
    if (error) { $('#derr').textContent = error.message; return; }
    ['#dn','#dd','#dm'].forEach(s => $(s).value = ''); toast('Added '+name); await loadDocs(); renderDocAdmin();
  });
};

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
  if (v.rx==='pending') msg += ' Your prescription has been sent to the pharmacy.';
  if (v.rx==='dispensed') msg += ' Your medicines have been dispensed.';
  $('#pres').replaceChildren(h('div',{class:'card'},
    h('div',{class:'row',style:'border:0;padding:0'},h('div',null,h('h3',null,v.name),h('div',{class:'muted'},v.bill+' · '+v.doctor+' · '+v.dept+' · '+tk(v.token))),st(v.status)),
    h('div',{class:'bighero'},h('div',{class:'bigno'},inQ?'#'+v.pos:v.status==='done'?'✓':v.status==='in_room'?'▶':'•'),
      h('div',null,h('div',{class:'bigh'},{waiting:'You are in the queue',in_room:'You are with the doctor',report_pending:'Waiting for your report',review:'Report ready. Please wait to be called',done:'Visit complete'}[v.status]||''),
        h('div',{class:'muted'},inQ?(ahead===0?'You are next':ahead+' ahead of you · about '+(ahead*v.avg_min)+' min'):''))),
    h('div',{class:'steps'},...['Registered','Waiting','Consultation','Report','Review','Done'].map((s,i) => h('span',{class:i<idx?'d':i===idx?'on':''},s))),
    h('div',{class:'tiles'},
      h('div',{class:'tile'},h('small',null,'Waiting list no.'),h('strong',null,inQ?'#'+v.pos:'—')),
      h('div',{class:'tile'},h('small',null,'Estimated wait'),h('strong',null,inQ?(ahead*v.avg_min)+' min':'—')),
      h('div',{class:'tile'},h('small',null,'Report status'),h('strong',{style:'font-size:18px;margin-top:6px'},rStat)),
      h('div',{class:'tile'},h('small',null,'Report waiting time'),h('strong',null,rWait)),
      h('div',{class:'tile'},h('small',null,'Bill'),h('strong',null,rs(v.total)),h('span',{class:v.paid?'paid':'due'},v.total>0?(v.paid?'Paid':'Due'):'No charges yet'))),
    v.report_path && h('p',null,h('button',{class:'btn sm',onclick:e=>openReport(patientReportUrl(cur.b,cur.c),e.target)},'Open my report')),
    v.sms && h('p',null,h('button',{class:'btn ghost sm',onclick:e=>busy(e.target,'Stopping…',async()=>{ const {data} = await sb.rpc('patient_withdraw_sms',{p_bill:cur.b,p_code:cur.c}); toast(data?'SMS updates stopped.':'Could not stop SMS. Please ask reception.',!data); renderPat(false); })},'Stop SMS updates')),
    h('div',{class:'note'},msg),h('p',{class:'muted',style:'margin-top:10px;font-size:12px'},'Updated '+hm(Date.now())+' · refreshes automatically')));
  if (first) $('#pres').scrollIntoView({behavior:'smooth',block:'start'});
}

/* ---------- patient privacy request ---------- */
$('#prgo').onclick = async e => {
  const {error} = await sb.rpc('submit_privacy_request', {p_kind:$('#prk').value, p_name:$('#prn').value, p_phone:$('#prp').value, p_bill:$('#prb').value, p_details:$('#prd').value});
  $('#prerr').textContent = error ? (/too many/i.test(error.message) ? 'Too many requests today. Please call the clinic.' : 'Please enter your name and phone.') : '';
  $('#prok').hidden = !!error;
  if (!error) ['#prn','#prp','#prb','#prd'].forEach(x => $(x).value = '');
};

/* ---------- render + messages ---------- */
function render(){ RENDER[view]?.(); }
// Ask the server to send any queued SMS right now (staff only, ignored if it fails).
let kickT; function kick(){ if (!session) return; clearTimeout(kickT); kickT = setTimeout(() => sb.functions.invoke('send-messages', {body:{}}).then(() => {}, () => {}), 800); }
