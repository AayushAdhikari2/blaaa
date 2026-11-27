/**
 * Local dashboard server (npm run dashboard). Serves standalone HTML/CSS/vanilla-JS dashboard
 * + a same-origin JSON API backed by the REAL local engine + mock adapters + persistent
 * demo store inside automation-module/.local/. NO Supabase. NO privileged credentials.
 * DEMO MODE — NOT CONNECTED TO SUPABASE. Every control performs a real demo-mode action.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DASHBOARD_DIR, LOCAL_STATE_DIR } from '../src/paths.js';
import { MockStore } from '../src/adapters/mock/mock-store.js';
import { MockRecipientProvider } from '../src/adapters/mock/mock-recipient-provider.js';
import { MockNotificationSink } from '../src/adapters/mock/mock-notification-sink.js';
import { EventSimulator } from '../src/adapters/mock/event-simulator.js';
import { createEngine } from '../src/core/event-ingestion.js';
import { getMetrics } from '../src/monitoring/metrics.js';
import { checkHealth } from '../src/monitoring/health.js';
import { resolveRecipients } from '../src/notifications/recipient-resolver.js';

const PORT = Number(process.env.AUTOMATION_DASHBOARD_PORT ?? 4177);
const HOST = process.env.AUTOMATION_DASHBOARD_HOST ?? '127.0.0.1';
// Runtime state always inside automation-module/.local/ (overridable to a subdir; never outside module).
const STATE_ROOT = process.env.AUTOMATION_STATE_DIR ?? LOCAL_STATE_DIR;

const store = new MockStore({ filePath: path.join(STATE_ROOT, 'dashboard', 'store.json') });
const recipients = new MockRecipientProvider();
const sink = new MockNotificationSink();
const engine = createEngine({ store, recipients, sink });
const simulator = new EventSimulator();
const startedAtMs = Date.now();

// last generated synthetic event per session (server-side; never exposes patient data)
let lastGenerated = null;

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Simulated-failure injection for demo controls (deterministic; not a security feature).
function applyFailureInjection(simulate) {
  sink.clearFailures();
  if (simulate === 'temporary' || simulate === 'transient') {
    // fail first recipient once with a transient error → retry scheduled; others succeed (partial success)
    sink.failNext('transient', 'simulated temporary downstream failure');
  } else if (simulate === 'permanent') {
    sink.failNext('permanent', 'simulated permanent rejection');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;

    // ---------- static dashboard ----------
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.join(DASHBOARD_DIR, rel);
      if (!filePath.startsWith(DASHBOARD_DIR)) return json(res, 403, { error: 'forbidden' });
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(body);
      } catch {
        json(res, 404, { error: 'not found' });
      }
      return;
    }

    // ---------- API ----------
    if (req.method === 'GET' && pathname === '/api/health') {
      return json(res, 200, await checkHealth(store, { startedAtMs }));
    }
    if (req.method === 'GET' && pathname === '/api/metrics') {
      return json(res, 200, await getMetrics(store));
    }
    if (req.method === 'GET' && pathname === '/api/recipients') {
      // synthetic staff, safe fields only; filtered to eligible roles view is separate
      const all = await recipients.listStaff();
      const eligible = await resolveRecipients(recipients, {});
      return json(res, 200, {
        synthetic: true,
        directory: all.map((s) => ({ id: s.id, role: s.role, active: s.active !== false })),
        eligible_reception_admin: eligible,
      });
    }
    if (req.method === 'GET' && pathname === '/api/events') {
      const state = await store.read();
      const events = Object.values(state.events).sort((a, b) => (a.received_at < b.received_at ? 1 : -1));
      return json(res, 200, { events });
    }
    if (req.method === 'GET' && pathname.startsWith('/api/events/')) {
      const id = decodeURIComponent(pathname.slice('/api/events/'.length));
      const state = await store.read();
      const event = state.events[id] ?? null;
      if (!event) return json(res, 404, { error: 'event not found' });
      const per_recipient = await engine.perRecipientResults(id);
      return json(res, 200, { event, per_recipient });
    }
    if (req.method === 'GET' && pathname === '/api/notifications') {
      return json(res, 200, { notifications: await engine.notifications.list({}) });
    }
    if (req.method === 'GET' && pathname === '/api/audit') {
      const type = url.searchParams.get('type') ?? undefined;
      return json(res, 200, { audit: await engine.audit.list({ type, limit: Number(url.searchParams.get('limit') ?? 500) }) });
    }
    if (req.method === 'GET' && pathname === '/api/retries') {
      const state = await store.read();
      const retries = Object.values(state.deliveries).filter((d) =>
        ['pending', 'processing', 'retry_scheduled'].includes(d.status));
      return json(res, 200, { retries });
    }
    if (req.method === 'GET' && pathname === '/api/dead-letter') {
      const state = await store.read();
      const dead = Object.values(state.deliveries).filter((d) => d.status === 'dead_letter' || d.status === 'failed');
      return json(res, 200, { dead_letter: dead });
    }
    if (req.method === 'GET' && pathname === '/api/executions') {
      // execution history = audit + per-event processing records
      const state = await store.read();
      return json(res, 200, { executions: await engine.audit.list({}), events: Object.values(state.events) });
    }

    // ---------- actions (real demo-mode) ----------
    if (req.method === 'POST' && pathname === '/api/simulate/generate') {
      const body = await readBody(req);
      const generated = simulator.generateAppointmentRequested({
        appointmentId: body.appointmentId ? String(body.appointmentId) : undefined,
      });
      lastGenerated = generated;
      return json(res, 200, { synthetic: true, event: generated.event, syntheticAppointment: generated.syntheticAppointment });
    }

    if (req.method === 'POST' && pathname === '/api/process') {
      const body = await readBody(req);
      const event = body.event ?? lastGenerated?.event;
      if (!event) return json(res, 400, { error: 'no event provided; generate one first' });
      const simulate = body.simulate ?? null; // null | 'temporary' | 'permanent'
      applyFailureInjection(simulate);
      const result = await engine.ingest(event, { dryRun: body.dryRun === true });
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/dry-run') {
      const body = await readBody(req);
      const event = body.event ?? lastGenerated?.event;
      if (!event) return json(res, 400, { error: 'no event provided; generate one first' });
      const result = await engine.ingest(event, { dryRun: true });
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/simulate/temporary-failure') {
      const body = await readBody(req);
      const event = body.event ?? lastGenerated?.event;
      if (!event) return json(res, 400, { error: 'no event provided; generate one first' });
      applyFailureInjection('temporary');
      const result = await engine.ingest(event);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/simulate/permanent-failure') {
      const body = await readBody(req);
      const event = body.event ?? lastGenerated?.event;
      if (!event) return json(res, 400, { error: 'no event provided; generate one first' });
      applyFailureInjection('permanent');
      const result = await engine.ingest(event);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname === '/api/retry/process-due') {
      const results = await engine.processRetries();
      return json(res, 200, { processed: results.length, results });
    }

    if (req.method === 'POST' && pathname.startsWith('/api/retry/')) {
      const id = decodeURIComponent(pathname.slice('/api/retry/'.length));
      sink.clearFailures(); // retry in a healthy downstream for demo
      const result = await engine.retryDelivery(id);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname.startsWith('/api/replay/delivery/')) {
      const id = decodeURIComponent(pathname.slice('/api/replay/delivery/'.length));
      sink.clearFailures();
      const result = await engine.replayDelivery(id);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && pathname.startsWith('/api/replay/event/')) {
      const id = decodeURIComponent(pathname.slice('/api/replay/event/'.length));
      sink.clearFailures();
      const result = await engine.replayEvent(id);
      return json(res, 200, result);
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    // sanitized: never leak secrets/PII; no stack in response
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: message.slice(0, 200) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Carepulse Automation dashboard (DEMO MODE — NOT CONNECTED TO SUPABASE)`);
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  demo state: ${path.join(STATE_ROOT, 'dashboard')}`);
});
