# Carepulse v10 — report: what is done, what is left

## 1. What was built (steps 6–10 + MedBrains-inspired features)
| Step | Delivered |
|---|---|
| 6 Messages | Consent-based SMS/WhatsApp queue; messages on register / called / “N ahead” / report ready; `send-messages` function (Sparrow, Twilio, test mode); Admin > Messages; patient “Stop SMS” |
| 7 Print + QR | 80 mm slip and bill with QR; public queue board (tokens only); duplicate-phone hint |
| 8 Dashboard | Visits, avg wait, consultation time, report turnaround, revenue, unpaid, per day/doctor, CSV (audited) |
| 9 Security | Hash-chained append-only audit log (no personal data in it); TOTP 2FA (optionally required, enforced in the database); 15-min auto logout; booking/privacy rate limits; consent; patient privacy requests; retention/anonymisation; encrypted nightly backup workflow + restore drill; CSP; privacy notice template |
| 10 Pilot + modules | Feedback button + Admin > Feedback; PILOT-PLAN.md; Pharmacy (allergy + interaction checks, expiry-first stock, auto-billing); Wards/beds with bed charges; Insurance claims with enforced status order |

## 2. How it was checked
- **113 database checks pass** on a real PostgreSQL 16 with Supabase-style roles: role limits, triggers, audit tamper detection, allergy/interaction blocking, stock rollback, bed charges, claim order, 2FA gate, retention, and that `setup.sql` re-runs safely.
- **Browser smoke test passes** (simulated browser, fake Supabase): every screen opens for every role; consent rules; 2FA lock screens.
- Both are in `tests/`.

## 3. NOT verified (you must do these)
1. **Not run on a real Supabase project.** Run `app/check.html`, then `TEST-CHECKLIST.md` rows 1–48.
2. **SMS gateway untested.** Sparrow call follows its public v2 format (found via search; official docs page not read). Needs your account, sender identity, and a live test. Twilio/WhatsApp also untested (WhatsApp needs approved templates for business-initiated messages).
3. **Real browser/printer:** QR scan on a phone, 80 mm thermal printing, and the Content-Security-Policy in real browsers (if something fails to load, check the console).
4. **2FA on real Supabase:** TOTP must be enabled under Authentication > MFA. Test lost-phone reset.
5. **Edge functions not executed** (no Deno here): `admin-staff` (changed), `report-link` (changed), `send-messages` (new). Deploy and test each.
6. **Backups:** add the two GitHub secrets, run the workflow, do the restore drill. Report files are not in the SQL dump.

## 4. Things only you can decide or supply
- **Law:** fill the `[brackets]` in `privacy.html`; have a lawyer check it, the consent wording, and the **retention period** (default 1095 days is a placeholder). Medical-record retention rules in Nepal must be checked before turning retention on.
- **Medicine data:** the sample drugs, interaction pairs, classes and prices are placeholders. A pharmacist must review or replace them.
- **Accounts:** Supabase (paid plan advised for backups), SMS gateway, a domain/https host, optional Cloudflare for edge rate limiting.
- **Pilot:** run PILOT-PLAN.md for two weeks with paper as backup.

## 5. Known limits in the code (honest list)
**Clinical**
- Allergy check is text matching (name, generic, class). It misses synonyms and class names not typed into the drug’s “class” field (e.g. “sulfa”). Interactions are checked only inside one prescription, not against earlier ones or other drugs the patient takes.
- No patient master record: allergies and details live on each visit (duplicate hint is by phone only).
- No OTC counter sales, controlled-drug register, returns, or purchase/re-order screens.
- Doctor cannot see a patient’s past visits or prescriptions on a later day.

**Operations**
- Token numbers are counted at registration (small chance of duplicates if two desks register at the same instant). Existing since v2.
- “N patients ahead” fires once per visit when first within the limit; it is only evaluated when a status changes. No email, no appointment reminders, patients cannot cancel online.
- Messages are triggered by clicks in the app; for sending while nobody is logged in, set up the optional `pg_cron` job.
- Bed charge is at least one day per bed segment; discharge may be done by reception as well as doctors; claims can only be created from today’s visits; no insurance document upload.
- Timezone is fixed to Asia/Kathmandu; English only (no Nepali interface).

**Security**
- The audit chain proves tampering only if you keep the head fingerprint somewhere safe; someone with full database control could rebuild the whole chain. Write the fingerprint down regularly.
- The QR on the slip contains bill no. + code (anyone holding the slip can see status). Do not post photos of slips.
- No 2FA recovery codes (an admin resets 2FA instead). No edge rate limiting or CAPTCHA on the public pages (the database limits abuse, not traffic).
- The audit log keeps staff names forever (by design); patient fields are masked.
- Retention anonymises by visit date only; privacy-request rows and feedback are not auto-deleted.

## 6. Not taken from MedBrains
ABDM/FHIR/HL7/DICOM, eMAR/nursing charts, emergency/medico-legal, operation theatre, blood bank, radiology, payroll/HR, procurement, native apps, AI dictation, multi-hospital tenancy. Licence note (AGPL; no code copied): `docs/FROM-MEDBRAINS.md`.

## 7. Suggested order from here
1) Supabase project + `setup.sql` + deploy 3 functions → 2) checklist rows 1–21 (old features) → 3) rows 22–48 → 4) privacy/lawyer + pharmacist review → 5) backups + restore drill → 6) SMS gateway live test → 7) 2-week pilot.
