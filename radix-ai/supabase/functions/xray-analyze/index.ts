// Edge Function: xray-analyze
// Deploy:  supabase functions deploy xray-analyze --no-verify-jwt      (patients are not logged in)
// Secrets: ANTHROPIC_API_KEY (required), XRAY_IP_SALT (required, any long random text),
//          XRAY_ALLOWED_ORIGIN (your website, e.g. https://example.com),
//          XRAY_AI_MODEL (default claude-opus-5-5), XRAY_AI_EFFORT (default medium)
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { analyze, InputError, MAX_BODY } from './core.js';

const env = (n: string) => Deno.env.get(n);
const headers = {
  'Access-Control-Allow-Origin': env('XRAY_ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

// Reads the body with a hard size limit (Content-Length can be missing or wrong).
async function readLimited(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new InputError('Empty request.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); throw new InputError('The image is too large.', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { throw new InputError('Invalid request.'); }
}

async function hashIp(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode((env('XRAY_IP_SALT') ?? '') + ip));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'Method not allowed.' }, 405);
  try {
    if (!env('XRAY_IP_SALT')) throw new InputError('The X-ray service is not set up yet.', 503);
    const admin = createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!);
    const out = await analyze(await readLimited(req), {
      env, fetch, ipHash: await hashIp(req),
      rpc: (name: string, args: Record<string, unknown>) => admin.rpc(name, args),
    });
    return reply(out.body, out.status);
  } catch (e) {
    if (e instanceof InputError) return reply({ error: e.message }, e.status);
    // Log only a short technical reason. Never log the request: it contains the image and patient details.
    console.error('xray-analyze failed:', e instanceof SyntaxError ? 'unreadable AI output' : String((e as Error)?.message).slice(0, 200));
    return reply({ error: 'The scan could not be completed. Nothing was saved. Please try again, or ask the clinic for help.' }, 502);
  }
});
