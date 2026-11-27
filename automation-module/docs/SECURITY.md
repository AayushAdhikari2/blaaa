# Security

## File boundary
Everything inside `automation-module/`. Never modify teammates' app/auth/schema/Edge Functions.
No live Supabase in V1. No DB migrations applied. No commits/pushes without approval.

## Trust model (Carepulse)
- **Patients are NOT Supabase Auth.** Patient portal = bill number + six-digit access code.
  Never create patient Auth identities. Never expose access codes. Never invent `patient_id`.
- **Staff** = Supabase Auth linked via `profiles.id`. Roles reception/doctor/lab/admin.
- Process 01 recipients: **reception + admin only**.
- Appointments RLS: reception+admin; `request_appointment` SECURITY DEFINER for anon+authenticated
  writes only; anonymous users cannot read appointments. We don't change any of that.

## Recipient safety
Recipients come ONLY from trusted server-side queries (`profiles` / injected provider). Never
trust client/browser recipient ids; reject any `recipients`/`recipient_id` in input. Re-check
role + active at processing time. Doctor/lab never recipients.

## Service-role key
Trusted server only. Never in browser JS. Never in logs/audit. Production adapters require an
injected server-side client. **Not used in V1.** No secrets in repo; `.local/` gitignored.
Env-based config on server only. We do not read/require real keys in V1.

## Not reusing admin-staff
`supabase/functions/admin-staff` (staff account administration, admin-only, service-role) is NOT
reused as an automation processor. Future worker is a separate trusted function/service.

## SECURITY DEFINER
Not used in V1 (no SQL applied). Proposal uses it only where justified + reviewed: pinned
`search_path`, EXECUTE revoked from public/anon/authenticated, minimal rights, no PII returned
(see `db/proposals/0001`, `0006`). Existing `request_appointment`/`my_role` are already
SECURITY DEFINER in Carepulse; we do not alter them.

## Sanitization (defense in depth)
Never persist/log patient name, phone, six-digit access code, password, token, secret, credential,
or appointment name/phone. Events carry only appointment id. Notifications fixed copy. Audit +
errors sanitized (`src/core/sanitize.js`, `sanitizeErrorSummary`), bounded length, single-line.
`assertNoSensitiveMaterial` test hook. No raw payload dumps in audit.

## Dry-run
No mutation; nothing persisted.

## Replay / idempotency
Replay can't create duplicate notifications; can't repeat successful deliveries; append-only history.

## Append-only audit
No update/delete API locally; production proposal adds triggers + revoked privileges + RLS.

## Known Carepulse issues we do NOT silently fix (see supabase-architecture.md "Integration risks")
Conversion not atomic; no appointment_id on visits; unchecked conversion errors; no event
history/outbox; no notification tables; no retry; no general audit; public reports bucket;
inconsistent setup docs. Documented only.

## Reports bucket
Carepulse `schema_v3.sql` creates `reports` bucket `public=true` despite private-signed-link
roadmap + private-upload policy. Documented as integration risk; not modified.
