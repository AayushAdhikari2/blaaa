// Edge Function: send-messages — delivers queued patient messages (table "outbox") through your SMS / WhatsApp gateway.
//
// Who may call it:  (a) any logged-in staff member (the app calls it after each action), or
//                   (b) a scheduler that sends the header  x-cron-secret: <CRON_SECRET>.
// Deploy:   supabase functions deploy send-messages
// Secrets:  supabase secrets set MSG_PROVIDER=sparrow SPARROW_TOKEN=... SPARROW_FROM=...        (Nepal SMS)
//       or  supabase secrets set MSG_PROVIDER=twilio TWILIO_SID=... TWILIO_TOKEN=... TWILIO_FROM=+1555...
//           (for WhatsApp add MSG_CHANNEL=whatsapp and use a WhatsApp-enabled TWILIO_FROM)
//           supabase secrets set CRON_SECRET=<long random text>       (only if you use the scheduler)
// With no MSG_PROVIDER the function runs in TEST MODE: messages are marked "sent (test mode)" and nothing leaves the server.
//
// Sparrow SMS: this uses the v2 endpoint (token, from, to, text). Check your Sparrow account documentation
// for your sender identity and for the exact response format before going live.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Nepal mobile numbers: 10 digits starting with 9 (97/98), with or without +977.
function phone(raw: string): { national: string; e164: string } | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length === 10 && d.startsWith('9')) return { national: d, e164: '+977' + d };
  if (d.length === 13 && d.startsWith('977')) return { national: d.slice(3), e164: '+' + d };
  if ((raw ?? '').trim().startsWith('+') && d.length >= 8 && d.length <= 15) return { national: d, e164: '+' + d };
  return null;
}

async function deliver(to: { national: string; e164: string }, text: string): Promise<string> {
  const provider = (Deno.env.get('MSG_PROVIDER') ?? '').toLowerCase();
  if (!provider) return 'test-mode';
  if (provider === 'sparrow') {
    const r = await fetch('https://api.sparrowsms.com/v2/sms/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: Deno.env.get('SPARROW_TOKEN') ?? '', from: Deno.env.get('SPARROW_FROM') ?? '', to: to.national, text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || (j.response_code && j.response_code !== 200)) throw new Error('Sparrow: ' + (j.response ?? r.status));
    return 'sparrow';
  }
  if (provider === 'twilio') {
    const sid = Deno.env.get('TWILIO_SID') ?? '', wa = (Deno.env.get('MSG_CHANNEL') ?? '') === 'whatsapp';
    const from = Deno.env.get('TWILIO_FROM') ?? '';
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(sid + ':' + (Deno.env.get('TWILIO_TOKEN') ?? '')) },
      body: new URLSearchParams({ To: (wa ? 'whatsapp:' : '') + to.e164, From: wa && !from.startsWith('whatsapp:') ? 'whatsapp:' + from : from, Body: text }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Twilio: ' + (j.message ?? r.status));
    return String(j.sid ?? 'twilio');
  }
  throw new Error('Unknown MSG_PROVIDER: ' + provider);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const secret = Deno.env.get('CRON_SECRET');
    const byCron = !!secret && req.headers.get('x-cron-secret') === secret;
    if (!byCron) {
      const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
      const { data: { user } } = await caller.auth.getUser();
      if (!user) return json({ error: 'Not allowed.' }, 401);
      const { data: p } = await admin.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (!p) return json({ error: 'Not allowed.' }, 403);
    }

    const { data: rows, error } = await admin.rpc('claim_outbox', { p_limit: 25 });
    if (error) return json({ error: error.message }, 500);
    let sent = 0, failed = 0;
    for (const m of rows ?? []) {
      const to = phone(m.phone);
      if (!to) {
        await admin.from('outbox').update({ status: 'failed', error: 'not a valid mobile number' }).eq('id', m.id); failed++; continue;
      }
      try {
        const id = await deliver(to, m.body);
        await admin.from('outbox').update({ status: 'sent', sent_at: new Date().toISOString(), provider_id: id, error: null }).eq('id', m.id); sent++;
      } catch (e) {
        // after 3 attempts claim_outbox stops picking it up; show it as failed so staff can see it
        await admin.from('outbox').update({ status: m.attempts >= 3 ? 'failed' : 'queued', error: String(e?.message ?? e).slice(0, 200) }).eq('id', m.id); failed++;
      }
    }
    return json({ ok: true, sent, failed, test_mode: !Deno.env.get('MSG_PROVIDER') });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});
