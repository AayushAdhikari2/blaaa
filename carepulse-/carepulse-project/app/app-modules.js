/* ===== step 10 modules: pharmacy + prescribing, wards and beds, insurance claims ===== */

const dayDiff = d => Math.round((new Date(d + 'T12:00:00') - Date.now()) / 864e5);
const dname = d => d.name + (d.strength ? ' ' + d.strength : '');
const errText = e => (e && e.message) || 'Something went wrong.';

/* ---------- drugs (shared by doctor + pharmacy) ---------- */
let DRUGS = [];
window.loadDrugs = async () => { DRUGS = (await sb.from('drugs').select('*').order('name')).data || []; };

/* ---------- doctor: prescribing panel inside the consultation card ---------- */
window.rxPanel = v => {
  const kl = 'rx:' + v.id, ka = 'allergy:' + v.id;
  const list = DRAFT[kl] || (DRAFT[kl] = []);
  const al = h('input', {id: 'al' + v.id, maxlength: '300', placeholder: 'none known', value: dr(ka, v.allergies || '')});
  al.oninput = () => DRAFT[ka] = al.value;
  const saveAl = h('button', {class: 'btn ghost sm', onclick: e => busy(e.target, 'Saving…', async () => {
    const {error} = await sb.from('visits').update({allergies: al.value.trim() || null}).eq('id', v.id);
    if (error) toast(error.message, true); else { delete DRAFT[ka]; toast('Allergies saved.'); }
  })}, 'Save allergies');
  const drug = h('select', {id: 'rd' + v.id}, ...DRUGS.filter(d => d.active).map(d => h('option', {value: d.id}, dname(d) + (d.rx_class === 'OTC' ? '' : ' · ' + d.rx_class))));
  const dose = h('input', {placeholder: 'Dose, e.g. 1 tablet 3 times a day', maxlength: '80'});
  const days = h('input', {type: 'number', min: '1', max: '365', placeholder: 'Days', style: 'max-width:80px'});
  const qty = h('input', {type: 'number', min: '1', max: '1000', placeholder: 'Qty', style: 'max-width:80px'});
  const err = h('div', {class: 'err', style: 'margin-top:6px'}), shown = h('div'), past = h('div');
  const draw = () => shown.replaceChildren(...list.map((it, i) => h('div', {class: 'row', style: 'padding:6px 0'},
    h('span', null, h('b', null, it.label), ' · ' + it.dose + (it.days ? ' · ' + it.days + ' days' : '') + ' · qty ' + it.qty),
    h('a', {href: '#', class: 'muted', onclick: e => { e.preventDefault(); list.splice(i, 1); draw(); }}, '✕'))));
  const add = h('button', {class: 'btn ghost sm', onclick: () => {
    const d = DRUGS.find(x => String(x.id) === drug.value);
    if (!d || !dose.value.trim() || !(+qty.value >= 1)) { err.textContent = 'Pick a medicine and enter the dose and quantity.'; return; }
    list.push({drug_id: d.id, label: dname(d), dose: dose.value.trim(), days: days.value ? +days.value : null, qty: +qty.value});
    dose.value = ''; days.value = ''; qty.value = ''; err.textContent = ''; draw();
  }}, 'Add');
  const send = h('button', {class: 'btn', onclick: e => busy(e.target, 'Checking…', async () => {
    if (!list.length) { err.textContent = 'Add at least one medicine.'; return; }
    const items = list.map(({drug_id, dose, days, qty}) => ({drug_id, dose, days, qty}));
    let r = await sb.rpc('create_rx', {p_visit: v.id, p_items: items});
    if (r.error && /MAJOR INTERACTION/.test(r.error.message)) {
      const why = prompt(r.error.message.replace(/^MAJOR INTERACTION\.\s*/, 'Major interaction: ') + '\n\nType your reason to continue, or Cancel to change the medicines:');
      if (!why || !why.trim()) { err.textContent = r.error.message; return; }
      r = await sb.rpc('create_rx', {p_visit: v.id, p_items: items, p_ack: why.trim()});
    }
    if (r.error) { err.textContent = errText(r.error); return; }
    err.textContent = ''; DRAFT[kl].length = 0; draw(); toast('Prescription sent to the pharmacy for ' + v.name + '.'); loadPast();
  })}, 'Send to pharmacy');
  const loadPast = async () => {
    const {data} = await sb.rpc('visit_rx', {p_visit: v.id});
    past.replaceChildren(...(data || []).map(p => h('div', {class: 'muted', style: 'font-size:12px;margin-top:4px'},
      'Prescription #' + p.id + ' (' + p.status + '): ' + (p.items || []).map(i => i.drug + ' ×' + i.qty).join(', '),
      p.status === 'pending' && [' ', h('a', {href: '#', onclick: async e => { e.preventDefault(); const {error} = await sb.rpc('cancel_rx', {p_rx: p.id}); if (error) toast(error.message, true); else { toast('Cancelled.'); loadPast(); } }}, 'Cancel')])));
  };
  draw(); loadPast();
  return h('div', {class: 'panel'}, h('h3', null, 'Allergies and prescription'),
    h('label', {for: 'al' + v.id}, 'Allergies'), h('div', {class: 'inl', style: 'margin-top:0'}, al, saveAl),
    h('label', {for: 'rd' + v.id}, 'Medicine'), drug, h('div', {class: 'inl'}, dose, days, qty, add), shown, err, past,
    h('div', {class: 'inl'}, send, h('button', {class: 'btn ghost sm', onclick: () => { DRAFT['admit:visit'] = v.id; go('wrd'); }}, 'Admit to ward'),
      h('span', {class: 'muted', style: 'font-size:12px'}, 'Allergy and interaction checks run on send.')));
};

/* ---------- pharmacy ---------- */
async function renderPha() {
  await loadDrugs();
  const {data, error} = await sb.rpc('pharmacy_queue');
  if (error) { $('#phq').replaceChildren(...empty('Could not load: ' + error.message + ' (did you run schema_v10.sql?)')); return; }
  $('#phq').replaceChildren(...(data.length ? data.map(rxRow) : empty('No prescriptions waiting.')));
  renderStock();
}
function rxRow(p) {
  const ko = 'ovr:' + p.id, allergic = p.checks.allergy.length > 0, majors = p.checks.interactions.filter(i => i.severity === 'major');
  const short = p.items.filter(i => i.stock < i.qty);
  const why = h('input', {placeholder: 'Reason to continue (major interaction)', value: dr(ko, ''), maxlength: '200'}); why.oninput = () => DRAFT[ko] = why.value;
  const err = h('div', {class: 'err', style: 'margin-top:6px'});
  const btn = h('button', {class: 'btn', disabled: allergic ? 'disabled' : null, onclick: e => busy(e.target, 'Dispensing…', async () => {
    if (majors.length && !p.ack_reason && !why.value.trim()) { err.textContent = 'Enter a reason to continue despite the major interaction, or ask the doctor.'; why.focus(); return; }
    const {data: r, error: er} = await sb.rpc('dispense_rx', {p_rx: p.id, p_override: why.value.trim() || null});
    if (er) { err.textContent = errText(er); return; }
    delete DRAFT[ko]; toast('Dispensed for ' + p.name + (r.billed ? '. ' + rs(r.billed) + ' added to the bill.' : '.')); renderPha();
  })}, 'Dispense');
  return h('div', {class: 'room'},
    h('div', {class: 'row', style: 'border:0;padding:0'}, h('div', null, h('b', null, p.name + (p.age ? ' · ' + p.age + ' yrs' : '')), h('div', {class: 'muted'}, p.bill + ' · ' + p.doctor + ' · ' + hm(p.created_at))),
      h('div', null, p.allergies ? h('span', {class: 'due'}, 'Allergies: ' + p.allergies) : h('span', {class: 'muted'}, 'No allergies recorded'))),
    ...p.items.map(i => h('div', {class: 'row', style: 'padding:6px 0'}, h('span', null, h('b', null, i.drug), ' · ' + i.dose + (i.days ? ' · ' + i.days + ' days' : '') + ' · qty ' + i.qty + (i.rx_class !== 'OTC' ? ' · ' + i.rx_class : '')),
      h('span', {class: i.stock < i.qty ? 'due' : 'muted'}, 'In stock: ' + i.stock))),
    ...p.checks.allergy.map(a => h('div', {class: 'err'}, '⚠ ALLERGY: ' + a.drug + ' (patient allergic to ' + a.allergen + '). Do not dispense. Ask the doctor.')),
    ...p.checks.interactions.map(i => h('div', {class: i.severity === 'major' ? 'err' : 'due', style: 'margin-top:6px'}, '⚠ ' + i.severity.toUpperCase() + ' interaction: ' + i.a + ' + ' + i.b + (i.note ? ' — ' + i.note : ''))),
    p.ack_reason && h('div', {class: 'muted', style: 'margin-top:6px'}, 'Doctor’s reason to continue: ' + p.ack_reason),
    short.length ? h('div', {class: 'due', style: 'margin-top:6px'}, 'Not enough in-date stock for: ' + short.map(i => i.drug).join(', ')) : null,
    majors.length && !p.ack_reason ? why : null, err,
    h('div', {class: 'inl'}, btn, h('button', {class: 'btn ghost sm', onclick: async e => { if (!confirm('Cancel this prescription?')) return; const {error: er} = await sb.rpc('cancel_rx', {p_rx: p.id}); if (er) toast(er.message, true); else renderPha(); }}, 'Cancel prescription')));
}
async function renderStock() {
  const {data: st} = await sb.from('drug_stock').select('*');
  const per = id => { const b = (st || []).filter(s => s.drug_id === id), t = today();
    const ok = b.filter(s => s.expiry >= t && s.qty > 0); return {qty: ok.reduce((a, s) => a + s.qty, 0), soon: ok.filter(s => dayDiff(s.expiry) <= 90), expired: b.filter(s => s.expiry < t && s.qty > 0), next: ok.sort((a, c) => a.expiry < c.expiry ? -1 : 1)[0]}; };
  const sel = h('select', null, ...DRUGS.filter(d => d.active).map(d => h('option', {value: d.id}, dname(d))));
  const bt = h('input', {placeholder: 'Batch no.', maxlength: '40'}), ex = h('input', {type: 'date'}), q = h('input', {type: 'number', min: '1', placeholder: 'Qty'});
  const nd = {name: h('input', {placeholder: 'Brand name'}), gen: h('input', {placeholder: 'Generic (e.g. amoxicillin)'}), cls: h('input', {placeholder: 'Class (e.g. penicillin, nsaid)'}), str: h('input', {placeholder: 'Strength'}),
    form: h('input', {placeholder: 'Form (tablet…)'}), rx: h('select', null, ...['OTC', 'Rx', 'Controlled'].map(x => h('option', null, x))), price: h('input', {type: 'number', min: '0', step: '0.01', placeholder: 'Price per unit (Rs)'})};
  $('#phs').replaceChildren(
    h('div', {class: 'card'}, h('h2', null, 'Stock'),
      h('div', {class: 'inl'}, sel, bt, ex, q, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Adding…', async () => {
        const {error} = await sb.rpc('add_stock', {p_drug: +sel.value, p_batch: bt.value, p_expiry: ex.value || null, p_qty: +q.value});
        if (error) toast(error.message, true); else { toast('Stock added.'); bt.value = ''; q.value = ''; renderStock(); }
      })}, 'Add stock')),
      ...DRUGS.map(d => { const p = per(d.id);
        const price = h('input', {type: 'number', min: '0', step: '0.01', value: d.unit_price, style: 'max-width:90px', 'aria-label': 'Price'});
        return h('div', {class: 'row', style: d.active ? '' : 'opacity:.55'}, h('div', null, h('b', null, dname(d)), h('div', {class: 'muted'}, d.generic + (d.drug_class ? ' · ' + d.drug_class : '') + ' · ' + d.rx_class + (d.active ? '' : ' · hidden'))),
          h('div', {class: 'inl', style: 'margin:0'}, h('span', {class: p.qty === 0 ? 'due' : 'paid'}, p.qty + ' in stock'),
            p.soon.length ? h('span', {class: 'due', title: p.soon.map(s => s.batch + ' ' + s.expiry).join(', ')}, '⚠ ' + p.soon.reduce((a, s) => a + s.qty, 0) + ' expire within 90 days') : null,
            p.expired.length ? h('span', {class: 'err', style: 'margin:0'}, p.expired.reduce((a, s) => a + s.qty, 0) + ' EXPIRED (not dispensed)') : null,
            price, h('button', {class: 'btn ghost sm', onclick: async () => { const {error} = await sb.from('drugs').update({unit_price: +price.value || 0}).eq('id', d.id); toast(error ? error.message : 'Price saved.', !!error); }}, 'Save price'),
            h('button', {class: 'btn ghost sm', onclick: async () => { await sb.from('drugs').update({active: !d.active}).eq('id', d.id); renderPha(); }}, d.active ? 'Hide' : 'Show'))); }),
      h('p', {class: 'muted', style: 'font-size:12px;margin-top:10px'}, 'Stock is taken from the batch that expires first. Expired batches are never dispensed. The sample medicines and interactions are placeholders: a pharmacist must review them.')),
    h('div', {class: 'card'}, h('h2', null, 'Add a medicine'), h('div', {class: 'inl'}, nd.name, nd.gen, nd.cls), h('div', {class: 'inl'}, nd.str, nd.form, nd.rx, nd.price,
      h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Adding…', async () => {
        if (!nd.name.value.trim() || !nd.gen.value.trim()) { toast('Brand name and generic name are required.', true); return; }
        const {error} = await sb.from('drugs').insert({name: nd.name.value.trim(), generic: nd.gen.value.trim().toLowerCase(), drug_class: nd.cls.value.trim().toLowerCase() || null, strength: nd.str.value.trim() || null, form: nd.form.value.trim() || null, rx_class: nd.rx.value, unit_price: +nd.price.value || 0});
        if (error) toast(error.message, true); else { toast('Medicine added.'); renderPha(); }
      })}, 'Add medicine')),
      h('p', {class: 'muted', style: 'font-size:12px'}, 'The generic name and class drive the allergy check (e.g. class “penicillin” on amoxicillin). Interaction pairs are managed by an admin in the database table drug_interactions.')));
}

/* ---------- wards ---------- */
async function renderWrd() {
  const {data, error} = await sb.rpc('bed_board');
  if (error) { $('#wbody').replaceChildren(h('div', {class: 'card'}, ...empty('Could not load: ' + error.message + ' (did you run schema_v10.sql?)'))); return; }
  const admitted = new Set(data.flatMap(w => w.beds).filter(b => b.adm).map(b => b.adm.visit_id));
  const free = data.flatMap(w => w.beds.filter(b => b.active && !b.adm).map(b => [b, w]));
  const vis = (await todays()).filter(v => !admitted.has(v.id));
  const vs = h('select', null, ...vis.map(v => h('option', {value: v.id}, v.bill + ' — ' + v.name))), bs = h('select', null, ...free.map(([b, w]) => h('option', {value: b.id}, w.name + ' · ' + b.label)));
  if (DRAFT['admit:visit'] && vis.some(v => v.id === DRAFT['admit:visit'])) vs.value = DRAFT['admit:visit'];
  const note = h('input', {placeholder: 'Reason for admission', maxlength: '300'}), aerr = h('div', {class: 'err'});
  const card = (b, w) => {
    if (!b.adm) return h('div', {class: 'bed free'}, h('b', null, b.label), h('div', {class: 'muted'}, b.active ? 'Free' : 'Out of service'), b.rate > 0 ? h('div', {class: 'muted', style: 'font-size:12px'}, rs(b.rate) + ' / day') : null);
    const a = b.adm, ks = 'dis:' + a.id, sum = h('textarea', {rows: '3', placeholder: 'Discharge summary: diagnosis, treatment, advice', maxlength: '2000'}); sum.value = dr(ks, ''); sum.oninput = () => DRAFT[ks] = sum.value;
    const tgt = h('select', null, h('option', {value: ''}, 'Move to…'), ...free.map(([x, ww]) => h('option', {value: x.id}, ww.name + ' · ' + x.label)));
    return h('div', {class: 'bed busy'}, h('b', null, b.label + ' · ' + a.name), h('div', {class: 'muted'}, a.bill + ' · ' + a.doctor + ' · since ' + new Date(a.since).toLocaleString([], {dateStyle: 'short', timeStyle: 'short'})), a.note ? h('div', {class: 'muted'}, a.note) : null,
      h('div', {class: 'inl'}, tgt, h('button', {class: 'btn ghost sm', onclick: e => tgt.value && busy(e.target, 'Moving…', async () => { const {error: er} = await sb.rpc('transfer_bed', {p_adm: a.id, p_bed: tgt.value}); if (er) toast(er.message, true); else { toast('Moved.'); renderWrd(); } })}, 'Transfer')),
      sum, h('div', {class: 'inl'}, h('button', {class: 'btn sm', onclick: e => { if (!confirm('Discharge ' + a.name + '? Bed charges will be added to the bill.')) return; busy(e.target, 'Discharging…', async () => {
        const {error: er} = await sb.rpc('discharge_patient', {p_adm: a.id, p_summary: sum.value}); if (er) toast(er.message, true); else { delete DRAFT[ks]; toast('Discharged ' + a.name + '.'); renderWrd(); } }); }}, 'Discharge')));
  };
  const nw = h('input', {placeholder: 'New ward name'}), wsel = h('select', null, ...data.map(w => h('option', {value: w.id}, w.name))), bl = h('input', {placeholder: 'Bed label (e.g. G-5)', style: 'max-width:150px'}), br = h('input', {type: 'number', min: '0', placeholder: 'Rs per day', style: 'max-width:110px'});
  $('#wbody').replaceChildren(
    h('div', {class: 'card'}, h('h2', null, 'Admit a patient'), vis.length && free.length ? h('div', {class: 'inl'}, vs, bs, note, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Admitting…', async () => {
      const {error: er} = await sb.rpc('admit_patient', {p_visit: +vs.value, p_bed: bs.value, p_note: note.value.trim() || null}); if (er) { aerr.textContent = errText(er); return; }
      delete DRAFT['admit:visit']; aerr.textContent = ''; toast('Admitted.'); renderWrd(); })}, 'Admit')) : h('p', {class: 'muted'}, !vis.length ? 'No visits today to admit.' : 'No free beds.'), aerr),
    ...data.map(w => h('div', {class: 'card'}, h('h2', null, w.name), h('div', {class: 'beds'}, ...w.beds.map(b => card(b, w))))),
    h('div', {class: 'inl'}, h('button', {class: 'btn ghost sm', onclick: renderWrd}, 'Refresh')),
    me.role === 'admin' ? h('div', {class: 'card'}, h('h2', null, 'Set up wards and beds'), h('div', {class: 'inl'}, nw, h('button', {class: 'btn sm', onclick: async e => { if (!nw.value.trim()) return; const {error: er} = await sb.from('wards').insert({id: 'w' + Date.now().toString(36), name: nw.value.trim()}); if (er) toast(er.message, true); else renderWrd(); }}, 'Add ward')),
      h('div', {class: 'inl'}, wsel, bl, br, h('button', {class: 'btn sm', onclick: async e => { if (!bl.value.trim() || !wsel.value) return; const {error: er} = await sb.from('beds').insert({id: wsel.value + '-' + bl.value.trim().toLowerCase().replace(/\W+/g, ''), ward_id: wsel.value, label: bl.value.trim(), rate: +br.value || 0}); if (er) toast(er.message, true); else renderWrd(); }}, 'Add bed')),
      h('p', {class: 'muted', style: 'font-size:12px'}, 'The daily rate is added to the patient’s bill at transfer and discharge (at least one day).')) : null);
}

/* ---------- claims ---------- */
const CST = ['draft', 'submitted', 'approved', 'rejected', 'paid'];
async function renderClm() {
  const [{data: ins}, {data: cl, error}] = await Promise.all([sb.from('insurers').select('*').order('name'), sb.from('claims').select('*').order('id', {ascending: false}).limit(80)]);
  if (error) { $('#cbody').replaceChildren(h('div', {class: 'card'}, ...empty('Could not load: ' + error.message + ' (did you run schema_v10.sql?)'))); return; }
  const vis = await todays(), allIds = [...new Set(cl.map(c => c.visit_id))];
  const old = allIds.length ? (await sb.from('visits').select('id,bill,name').in('id', allIds)).data || [] : [];
  const vname = id => { const v = vis.find(x => x.id === id) || old.find(x => x.id === id); return v ? v.bill + ' — ' + v.name : '#' + id; };
  const act = (c, patch, ok) => async e => busy(e.target, '…', async () => { const {error: er} = await sb.from('claims').update(patch).eq('id', c.id); if (er) toast(er.message, true); else { toast(ok); renderClm(); } });
  const vs = h('select', null, ...vis.map(v => h('option', {value: v.id}, v.bill + ' — ' + v.name))), is = h('select', null, ...ins.filter(i => i.active).map(i => h('option', {value: i.id}, i.name)));
  const pol = h('input', {placeholder: 'Policy / member no.', maxlength: '40'}), amt = h('input', {type: 'number', min: '0', step: '0.01', placeholder: 'Claim amount (Rs)'}), cerr = h('div', {class: 'err'});
  const fillAmt = async () => { if (!vs.value) return; const {data} = await sb.from('bill_items').select('amount').eq('visit_id', +vs.value); amt.value = (data || []).reduce((s, i) => s + Number(i.amount), 0) || ''; };
  vs.onchange = fillAmt; fillAmt();
  const sum = s => cl.filter(c => c.status === s).reduce((a, c) => a + Number(s === 'approved' || s === 'paid' ? (c.approved_amount ?? c.amount) : c.amount), 0);
  const ni = h('input', {placeholder: 'Insurer name'});
  $('#cbody').replaceChildren(
    h('div', {class: 'card'}, h('h2', null, 'New claim (today’s visits)'), ins.length ? h('div', {class: 'inl'}, vs, is, pol, amt, h('button', {class: 'btn sm', onclick: e => busy(e.target, 'Saving…', async () => {
      if (!vs.value || !pol.value.trim() || !(+amt.value >= 0) || amt.value === '') { cerr.textContent = 'Pick a visit and enter the policy number and amount.'; return; }
      const {error: er} = await sb.from('claims').insert({visit_id: +vs.value, insurer_id: +is.value, policy_no: pol.value.trim(), amount: +amt.value});
      if (er) { cerr.textContent = /duplicate/i.test(er.message) ? 'There is already a claim for this visit and insurer.' : er.message; return; }
      cerr.textContent = ''; pol.value = ''; toast('Claim saved as draft.'); renderClm(); })}, 'Create')) : h('p', {class: 'muted'}, 'Add an insurer first' + (me.role === 'admin' ? ' (below).' : ' (ask an admin).')), cerr),
    h('div', {class: 'card'}, h('h2', null, 'Claims'), h('div', {class: 'tiles'}, ...['submitted', 'approved', 'rejected', 'paid'].map(s => tile(s[0].toUpperCase() + s.slice(1), rs(sum(s)), cl.filter(c => c.status === s).length + ' claims'))),
      ...(cl.length ? cl.map(c => h('div', {class: 'room'}, h('div', {class: 'row', style: 'border:0;padding:0'},
        h('div', null, h('b', null, vname(c.visit_id)), h('div', {class: 'muted'}, (ins.find(i => i.id === c.insurer_id)?.name || '') + ' · ' + c.policy_no + ' · claimed ' + rs(c.amount) + (c.approved_amount != null ? ' · approved ' + rs(c.approved_amount) : '')), c.note && h('div', {class: 'muted'}, 'Note: ' + c.note)),
        h('div', {class: 'inl', style: 'margin:0'}, h('span', {class: 'st ' + (c.status === 'paid' ? 'done' : c.status === 'submitted' ? 'report_pending' : c.status === 'rejected' ? 'review' : '')}, c.status),
          c.status === 'draft' && h('button', {class: 'btn sm', onclick: act(c, {status: 'submitted'}, 'Submitted.')}, 'Submit'),
          c.status === 'submitted' && h('button', {class: 'btn sm', onclick: e => { const a = prompt('Approved amount (Rs)?', c.amount); if (a === null || !(+a >= 0) || a === '') return; act(c, {status: 'approved', approved_amount: +a}, 'Approved.')(e); }}, 'Approve'),
          c.status === 'submitted' && h('button', {class: 'btn ghost sm', onclick: e => { const n = prompt('Reason for rejection?'); if (n === null) return; act(c, {status: 'rejected', note: n}, 'Marked rejected.')(e); }}, 'Rejected'),
          c.status === 'approved' && h('button', {class: 'btn sm', onclick: act(c, {status: 'paid'}, 'Marked paid.')}, 'Mark paid'),
          c.status === 'rejected' && h('button', {class: 'btn ghost sm', onclick: act(c, {status: 'submitted'}, 'Resubmitted.')}, 'Resubmit'),
          c.status === 'draft' && h('a', {href: '#', class: 'muted', onclick: async e => { e.preventDefault(); if (!confirm('Delete this draft claim?')) return; await sb.from('claims').delete().eq('id', c.id); renderClm(); }}, '✕'))))) : empty('No claims yet.'))),
    me.role === 'admin' ? h('div', {class: 'card'}, h('h2', null, 'Insurers'), h('div', {class: 'inl'}, ni, h('button', {class: 'btn sm', onclick: async () => { if (!ni.value.trim()) return; const {error: er} = await sb.from('insurers').insert({name: ni.value.trim()}); if (er) toast(er.message, true); else renderClm(); }}, 'Add insurer')),
      ...ins.map(i => h('div', {class: 'row'}, h('span', {style: i.active ? '' : 'opacity:.5'}, i.name), h('button', {class: 'btn ghost sm', onclick: async () => { await sb.from('insurers').update({active: !i.active}).eq('id', i.id); renderClm(); }}, i.active ? 'Hide' : 'Show')))) : null);
}
