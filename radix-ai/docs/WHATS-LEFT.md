# RADIX AI v10.2 — report: what is done, what is left

## 1. What was built (steps 6–10 + MedBrains-inspired features)
| Step | Delivered |
|---|---|
| 6 Messages | Consent-based SMS/WhatsApp queue; messages on register / called / “N ahead” / report ready; `send-messages` function (Sparrow, Twilio, test mode); Admin > Messages; patient “Stop SMS” |
| 7 Print + QR | 80 mm slip and bill with QR; public queue board (tokens only); duplicate-phone hint |
| 8 Dashboard | Visits, avg wait, consultation time, report turnaround, revenue, unpaid, per day/doctor, CSV (audited) |
| 9 Security | Hash-chained append-only audit log (no personal data in it); TOTP 2FA (optionally required, enforced in the database); 15-min auto logout; booking/privacy rate limits; consent; patient privacy requests; retention/anonymisation; encrypted nightly backup workflow + restore drill; CSP; privacy notice template |
| 10 Pilot + modules | Feedback button + Admin > Feedback; PILOT-PLAN.md; Pharmacy (allergy + interaction checks, expiry-first stock, auto-billing); Wards/beds with bed charges; Insurance claims with enforced status order |

## 1b. Rename and redesign (v10.1)
- **Renamed everywhere to RADIX AI**: app, landing page, privacy notice, SQL defaults (an existing database’s old default clinic name is updated automatically), backup workflow, docs, folder and zip. New logo and app icons. (Written “RADIX AI” in the interface; if you want the underscore form `RADIX_AI`, it is a find-and-replace of that text.)
- **Mobile-first navigation**: phones get a bottom tab bar (4 main screens + “More” sheet when a role has more than 5), computers get a left sidebar with icons; top bar is compact; page headers are shorter.
- **Touch UX**: 44 px+ buttons and fields, 16 px inputs (no iOS zoom), safe-area support for notched phones, horizontally scrolling admin sub-tabs, bottom-sheet feedback box, prescriptions/queue shown as tiles, Enter key submits login and patient lookup, scroll-to-result after a patient lookup, large “#2 · about 16 min” status block, offline banner, installable on the home screen (manifest + icons).
- **Bug found and fixed during the redesign**: the helper that builds screens wrote `disabled="null"` for empty attributes, which would have left the pharmacy **Dispense button permanently disabled**. Fixed for the whole app and covered by a new test.

## 1c. v10.2 — Must-do safety fixes + two “Should” items (this round)
| Fix | What changed | Where |
|---|---|---|
| Duplicate tokens | Per doctor/day counter row, incremented under a row lock; plus a unique index (added only if today’s data has no duplicates). Tested with 40 simultaneous registrations: 40 different tokens. | `schema_v11.sql` §1 |
| Allergy synonyms/classes | Table `allergy_terms` (“sulfa” → cotrimoxazole…, “NSAIDs” → diclofenac…, “acetaminophen” ↔ paracetamol…); admin screen **Admin > Allergy terms**. Starting list is a **placeholder for a pharmacist to review**. | `schema_v11.sql` §2, `app-admin.js` |
| Earlier prescriptions | Interaction check also looks at the same patient’s other prescriptions that are still running (course = days, 30 if blank; pending or dispensed). Allergies typed on the patient’s earlier visits (2 years) also count. The message says “with an earlier prescription of this patient”. | `schema_v11.sql` §3, `app-modules.js` |
| Doctor sees past visits | “Earlier visits of this patient” in the consultation card (visits + prescriptions). | `patient_history()`, `app-modules.js` |
| Import medicines | Pharmacy > Stock > “Import medicines from a file” (CSV, template download, per-row error list). | `app-modules.js` |

| Short bill numbers | New bills are `BL-0012` (was `BL-20261127-0012`). Patients can type `12`, `bl12`, `BL 12` or the full number; old long numbers still work. One global sequence, so a number never repeats (it grows to `BL-10000`, it does not wrap). The 5-tries lockout is shared by every way of typing the same number. | `schema_v11.sql` §5 |
| Landing page redesign | New mobile-first page, same colours (`colors.css` untouched). Removed claims that were not true for this product (fake customer names, HIPAA/ISO/SOC 2, HL7/FHIR, 24/7 support, pricing, fitness dashboard). | `index.html`, `styles.css`, `script.js` |

**“Same patient” is still only same name + same phone (last 10 digits).** Two different people with the same name on one phone are treated as one; a patient who changes phone number is treated as two. A real patient master record is still on the list below.

Checks now: **154 database checks pass** (113 old + 41 new), the setup file runs twice without errors, the browser smoke test shows no errors.

## 2. How it was checked
- **144 database checks pass** on a real PostgreSQL 16 with Supabase-style roles: role limits, triggers, audit tamper detection, allergy/interaction blocking, stock rollback, bed charges, claim order, 2FA gate, retention, and that `setup.sql` re-runs safely.
- **Browser smoke test passes** (simulated browser, fake Supabase): every screen opens for every role; consent rules; 2FA lock screens.
- **Real-browser screenshots** (headless Chromium) of phone (390 px) and desktop (1280 px) layouts: patient page, reception, admin + “More” sheet, pharmacy, queue board, admin sidebar. No JavaScript errors. Samples in `docs/screenshots/`.
- Navigation tests: phone admin = 5 tabs with a working More sheet; desktop admin = all 10; doctor = 5 with no More; public = 4.
- Tests are in `tests/`.

## 3. NOT verified (you must do these)
1. **Not run on a real Supabase project.** Run `app/check.html`, then `TEST-CHECKLIST.md` rows 1–48.
2. **SMS gateway untested.** Sparrow call follows its public v2 format (found via search; official docs page not read). Needs your account, sender identity, and a live test. Twilio/WhatsApp also untested (WhatsApp needs approved templates for business-initiated messages).
3. **Real devices/printer:** the layout was checked in desktop Chromium only (phone-sized window with touch emulation). Test on a real Android phone and an iPhone (Safari), a tablet, a QR scan, an 80 mm thermal printer, and the Content-Security-Policy (if something fails to load, check the console).
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
- Allergy check is text matching (name, generic, class) plus the editable synonym table (v10.2). It can still miss spellings/brand names nobody has added. Interactions are now also checked against the patient’s still-running earlier prescriptions (matched by name + phone), but not against medicines taken outside this clinic.
- No patient master record: allergies and details live on each visit (duplicate hint is by phone only).
- No OTC counter sales, controlled-drug register, returns, or purchase/re-order screens.

**Operations**
- “N patients ahead” fires once per visit when first within the limit; it is only evaluated when a status changes. No email, no appointment reminders, patients cannot cancel online.
- Messages are triggered by clicks in the app; for sending while nobody is logged in, set up the optional `pg_cron` job.
- Bed charge is at least one day per bed segment; discharge may be done by reception as well as doctors; claims can only be created from today’s visits; no insurance document upload.
- Timezone is fixed to Asia/Kathmandu; English only (no Nepali interface).
- UI: no dark mode; no offline mode (a banner warns when the connection drops, but nothing works offline and there is no service worker); screens between 600 and 899 px wide use the phone layout; the Fonts load from Google Fonts (falls back to the system font if blocked).

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
