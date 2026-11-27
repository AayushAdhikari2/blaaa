# AGENTS.md — Carepulse Automation Module (independent V1)

## Scope / file boundary
- Everything lives in `automation-module/`. **Never** modify anything outside it.
- Do NOT touch `carepulse-project/`, `carepulse-site/`, `files/`, existing JS/HTML/CSS/SQL,
  existing Supabase Edge Functions, auth, patient/doctor/lab/billing workflows.
- **No DB migrations. No live Supabase. No production connections. No commits/pushes** without explicit approval.
- SQL in `db/proposals/` is **proposal only**.

## What this module is
Independent automation engine. **Only** Process 01: `appointment.requested`.
No Process 02. No AI. No real patient notifications. No email/SMS/WhatsApp. V1 notification
delivery is mock/local. No patient Auth identities. No invented `patient_id`.

## Carepulse realities (verified against schema.sql + schema_v3.sql + schema_v4.sql)
- `appointments`: id bigint identity pk; name/phone NOT NULL; doctor_id text NOT NULL → doctors(id);
  preferred_date date nullable; reason nullable; status default 'requested' check requested|converted|cancelled;
  created_at timestamptz. No patient_id. No event hooks. No outbox.
- `profiles`: id uuid → auth.users; full_name; role check reception|doctor|lab|admin; doctor_id → doctors.
- `request_appointment(...)` SECURITY DEFINER, anon+authenticated, returns void, **no event emission**.
- Appointment RLS: reception+admin only. Patient portal = bill number + six-digit code (not auth).
- `my_role()` security definer. V4: doctors.active; admin_list_staff(). Roles: reception/doctor/lab/admin.
- Do NOT reuse `supabase/functions/admin-staff` as automation processor.
- Reports bucket is currently **public** (see integration risks); not touched.

## Event contract
appointment.requested v1; envelope in `contracts/`. appointment_id = correlation. No patient_id.
No scheduled_start. preferred_date not carried. Recipients server-side only. Validate everything.
Never copy patient name/phone into events/logs. Local V1 uses deterministic event ids + synthetic data.

## Reliability
At-least-once + idempotency; NOT exactly-once (not even for production; see docs). Unique key
event_id|recipient_id|channel|notification_type. Per-recipient partial success. Bounded exponential
backoff; max attempts; transient/permanent; retry timestamps; sanitized errors; manual replay;
append-only audit; injectable clock; dry-run. Safe replay never repeats successful deliveries.

## Security
Service-role key trusted-server-only; never browser; never log secrets/PII. Sanitize. No new
SECURITY DEFINER without justified reviewed design (proposal documents it). Recipients re-checked.

## Recipients (Process 01)
profiles.role in ('reception','admin') ONLY. No doctor/lab/anonymous/patient. Never trust input.

## Testing / run
Node ES modules; zero deps; `node --test`. `npm test`, `npm run dev`, `npm run dashboard`.
State in `.local/` (gitignored). Never write outside the module.
