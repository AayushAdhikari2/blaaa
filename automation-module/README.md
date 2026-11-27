# Carepulse Automation Engine V1

Independent, self-contained automation subsystem for the Carepulse Hospital Management System.
**Only** Process 01 is implemented: `appointment.requested`. Runs independently; no changes to
the main application; no live Supabase; no DB migrations applied; **demo/local mode**.

> **DEMO MODE — NOT CONNECTED TO SUPABASE.** All data is synthetic. Notifications are
> mock/local. No email, SMS, or WhatsApp. No production hospital activity.

## Requirements
Windows 11 / VS Code PowerShell; **Node.js ≥ 18** (developed on Node 26). Zero runtime dependencies.

## Run
```powershell
cd automation-module
npm test            # Node built-in test runner
npm run dev         # self-contained synthetic pipeline demo
npm run dashboard   # standalone dashboard at http://127.0.0.1:4177
```

## What it does (Process 01)
Event `appointment.requested` (`INSERT` into `public.appointments` with `status=requested` in
production; synthetic simulator in V1) → validate → normalize → idempotent event ingestion →
resolve recipients (`profiles.role in ('reception','admin')`, server-side, re-checked) →
one recipient-specific **in-app** notification per eligible staff profile → idempotent per-recipient
delivery (mock) → partial-success isolation → bounded retry + dead-letter → append-only audit +
metrics. Safe duplicate + replay. Dry-run. Synthetic local persistence in `automation-module/.local/`.

Title: **New appointment request** · Body: *A new online appointment request requires reception review.*
Payload: event ID, appointment ID, notification type, creation time. No patient name/phone.

## Architecture
- `src/core/` event validation, normalization, ingestion, routing, deterministic ids, injectable clock, errors, sanitize
- `src/workflows/appointment-requested/` Process 01
- `src/notifications/` recipient resolution, notification service, idempotency
- `src/reliability/` retry policy, error classification, delivery queue, dead-letter, replay
- `src/audit/` append-only sanitized audit
- `src/monitoring/` metrics, health
- `src/adapters/mock/` persistent JSON store, synthetic recipients, mock sink, event simulator
- `src/adapters/supabase/` production adapters (prepared; **no live calls in V1**; injected trusted-server client; service-role server-only)
- `contracts/` versioned event contract (+ JSON Schema)
- `dashboard/` standalone HTML/CSS/vanilla-JS admin dashboard + local server
- `db/proposals/` **unapplied** transactional-outbox + automation schema proposal
- `docs/` architecture, process, contract, security, Supabase proposal, integration risks

See `docs/ARCHITECTURE.md`, `docs/PROCESS-01.md`, `docs/EVENT-CONTRACT.md`, `docs/SECURITY.md`,
`docs/supabase-architecture.md`, `AGENTS.md`.

## Reliability honesty
Local V1 uses atomic claims in a single process + a JSON store. **Not exactly-once.** Not even
production-ready claiming; production requires the transactional outbox + Postgres uniqueness +
`FOR UPDATE SKIP LOCKED` in `db/proposals/`. **Local browser timers are not reliable production
workers**; retries run on a trusted server-side worker in production.
