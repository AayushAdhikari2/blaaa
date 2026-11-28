// Edge Function: report-link — gives a patient a 5-minute signed link to THEIR report.
// Checks bill no + code through patient_status() (same 5-tries/15-min lockout as the status page).
// Deploy:  supabase functions deploy report-link --no-verify-jwt     (patients are not logged in)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const { bill, code } = await req.json();
    if (typeof bill !== 'string' || typeof code !== 'string') return json({ error: 'Bill number and code are required.' }, 400);
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!);
    const { data: v } = await anon.rpc('patient_status', { p_bill: bill, p_code: code });
    if (!v) return json({ error: 'Bill number or code is incorrect.' }, 403);
    if (v.locked) return json({ error: 'Too many wrong tries. Please wait 15 minutes.' }, 429);
    if (!v.report_path) return json({ error: 'No report file is available for this visit.' }, 404);
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await admin.storage.from('reports').createSignedUrl(v.report_path, 300);
    if (error) return json({ error: 'Could not open the report. Please ask reception.' }, 500);
    await admin.rpc('audit_event', { p_actor: null, p_action: 'REPORT_LINK', p_row: String(v.bill), p_detail: { by: 'patient' } });
    return json({ url: data.signedUrl });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
