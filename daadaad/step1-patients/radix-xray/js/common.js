const $ = (s) => document.querySelector(s);
const TZ = 'Asia/Kathmandu';
const DEMO = XRAY_SUPABASE_URL.includes('YOUR-PROJECT');
const CONSENT_VERSION = 'xray-consent-2026-11-v1';   // must match core.js
const PARTS = { chest: 'Chest', hand_wrist: 'Hand / wrist', arm_elbow: 'Arm / elbow', shoulder: 'Shoulder', leg_knee: 'Leg / knee', ankle_foot: 'Ankle / foot', hip_pelvis: 'Hip / pelvis', spine: 'Spine', abdomen: 'Abdomen', skull_face: 'Skull / face', dental: 'Dental', other: 'Other' };
const SIDE = { left: 'left', right: 'right', both: 'both sides', na: '' };
const URG = { routine: 'Routine', soon: 'Follow up soon', urgent: 'Urgent' };
const partName = (r) => PARTS[r.body_part] + (SIDE[r.side] ? ' (' + SIDE[r.side] + ')' : '');
const when = (t) => new Date(t).toLocaleString('en-GB', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });

// Builds elements with text nodes only, so patient or AI text can never run as HTML.
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (k === 'class') e.className = v; else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((c) => c != null && c !== false));
  return e;
}

async function sha256Hex(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------- real backend ---------- */
function liveApi() {
  const sb = supabase.createClient(XRAY_SUPABASE_URL, XRAY_SUPABASE_ANON_KEY);
  const rpc = async (name, args) => { const { data, error } = await sb.rpc(name, args); if (error) throw new Error(error.message); return data; };
  return {
    async analyze(body) {
      const { data, error } = await sb.functions.invoke('xray-analyze', { body });
      if (error) {
        let m = 'The scan could not be completed. Check your connection and try again.';
        try { m = (await error.context.json()).error || m; } catch (_) { /* no JSON body */ }
        throw new Error(m);
      }
      return data;
    },
    lookup: (ref, code) => rpc('xray_lookup', { p_ref: ref, p_code: code }),
    async signIn(email, password) { const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw new Error(error.message); },
    async signOut() { await sb.auth.signOut(); },
    async me() { const { data } = await sb.auth.getSession(); return data.session ? rpc('xray_me') : null; },
    queue: (s) => rpc('xray_queue', { p_status: s }),
    get: (id) => rpc('xray_get', { p_id: id }),
    release: (id, report, examined) => rpc('xray_release', { p_id: id, p_final: report, p_examined_original: examined }),
    reject: (id, reason) => rpc('xray_reject', { p_id: id, p_reason: reason }),
  };
}

/* ---------- demo backend: fixed sample text, kept in this browser only, never any image ---------- */
function demoApi() {
  const KEY = 'xray_demo_v1';
  let mem = [];
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || mem; } catch (_) { return mem; } };
  const save = (a) => { mem = a; try { localStorage.setItem(KEY, JSON.stringify(a)); } catch (_) { /* private window */ } };
  const change = (id, patch) => { const a = load(); const r = a.find((x) => x.id === id && x.status === 'pending_review'); if (!r) throw new Error('This report was already reviewed.'); Object.assign(r, patch, { reviewed_at: new Date().toISOString() }); save(a); };
  const sample = () => ({ is_xray: true, rejection_reason: '', detected_body_part: 'sample', matches_selected_body_part: true, view: 'Sample view',
    image_quality: { rating: 'limited', issues: ['DEMO: the image was not examined.'] },
    findings: [{ region: 'Sample region', observation: 'DEMO SAMPLE TEXT. No image was analysed.', significance: 'uncertain', confidence: 'low' }],
    impression: 'DEMO SAMPLE. This is not a result.', urgency: 'routine', urgency_reason: 'Demo value.',
    recommendations: ['DEMO: sample next step.'], limitations: ['DEMO: this text is the same for every upload.'],
    patient_summary: 'DEMO SAMPLE. Your image was not analysed and this says nothing about your health.' });
  let doctor = false;
  try { doctor = sessionStorage.getItem('xray_demo_doc') === '1'; } catch (_) {}
  const setDoc = (v) => { doctor = v; try { sessionStorage.setItem('xray_demo_doc', v ? '1' : '0'); } catch (_) {} };
  return {
    async analyze(body) {
      await new Promise((r) => setTimeout(r, 3500));
      const a = load(), n = new Uint32Array(2); crypto.getRandomValues(n);
      const ref = 'XR-' + n[0].toString(16).toUpperCase().padStart(8, '0'), code = String(n[1] % 1e8).padStart(8, '0');
      const p = body.patient;
      a.push({ id: Date.now(), ref, code, patient_name: p.name, phone: p.phone, age: Number(p.age), sex: p.sex, body_part: p.body_part, side: p.side, symptoms: p.symptoms,
        file_sha256: body.file_sha256, ai_result: sample(), ai_model: 'demo (no AI)', ai_urgency: 'routine', status: 'pending_review', created_at: new Date().toISOString() });
      save(a);
      return { ref, code, status: 'pending_review' };
    },
    async lookup(ref, code) {
      const r = load().find((x) => x.ref === ref.trim().toUpperCase() && x.code === code.trim());
      if (!r) return null;
      const base = { ref: r.ref, status: r.status, created_at: r.created_at, body_part: r.body_part, side: r.side };
      return r.status === 'released' ? { ...base, patient_name: r.patient_name, age: r.age, sex: r.sex, report: r.final_report, reviewer_name: r.reviewer_name, reviewer_reg_no: r.reviewer_reg_no, reviewed_at: r.reviewed_at } : base;
    },
    async signIn() { setDoc(true); },
    async signOut() { setDoc(false); },
    async me() { return doctor ? { full_name: 'Demo Doctor', registration_no: 'DEMO-000' } : null; },
    async queue(s) { return load().filter((r) => r.status === s); },
    async get(id) { return load().find((r) => r.id === id); },
    async release(id, report, examined) { if (!examined) throw new Error('Confirm that you examined the original X-ray.'); change(id, { status: 'released', final_report: report, reviewer_name: 'Demo Doctor', reviewer_reg_no: 'DEMO-000' }); },
    async reject(id, reason) { change(id, { status: 'rejected', reject_reason: reason }); },
  };
}

const api = DEMO ? demoApi() : liveApi();
if (DEMO) $('#demo').hidden = false;
