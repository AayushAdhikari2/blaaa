> **STATUS (v10.2, done by AI in this chat):** Phase 7 "Must" items are finished and tested (tokens, allergy synonyms, earlier-prescription check), plus two "Should" items (doctor's earlier-visits panel, medicine CSV import).
> **Still open — only you can do these:** Phases 0–6 and 8–9 (accounts, going online, real-device tests, SMS gateway, lawyer, pharmacist, backups, pilot).
> **Still open — AI can build when you ask:** patient master record, 2FA recovery codes, cancel/reschedule + reminder SMS, dark mode, Nepali language, offline shell, OTC sales/returns, landing-page redesign, CI tests.

# RADIX AI — step-by-step plan to finish everything in WHATS-LEFT.md

Times are **estimates**, not guarantees. "AI time" is how long I (Claude) need to write, fix and re-test code in this chat once I have what I need from you. The slow part is almost never the AI: it is accounts, real devices, laws and waiting for real clinic staff.

## What AI can and cannot do
| AI can | AI cannot |
|---|---|
| Write and fix code, SQL, screens, docs; re-run my tests | Log in to your Supabase, GitHub, SMS or hosting accounts |
| Read an error message / screenshot / log you paste and fix the cause | See your real phone, printer or clinic |
| Draft the privacy notice, training sheets, checklists | Be your lawyer, or a pharmacist/doctor who signs off medicine data |
| Adapt the SMS code to your provider’s docs when you paste them | Send a real SMS or test a real payment/claim |

**How to work with me:** do one step, then send me (a) what you did, (b) the exact error text or a screenshot, (c) which file/screen. I answer with a fixed file. Keep each message to one problem.

## Summary
| Phase | What | Who | Your time | AI time |
|---|---|---|---|---|
| 0 | Create accounts | You | 1–2 h | 10 min (guidance) |
| 1 | Put it online (database + site) | You + AI | 1–2 h | 10–30 min per error |
| 2 | Run the test checklist (rows 1–48) | You + AI | 3–5 h | 5–20 min per bug found |
| 3 | Deploy 3 server functions + SMS | You + AI | 1–2 h | 15–40 min (SMS adapter) |
| 4 | Test on real phones, tablet, printer, QR | You + AI | 1–2 h | 10–30 min per layout fix |
| 5 | Legal text + pharmacist review | You + experts | 2–4 h of yours, 1–3 weeks waiting | 15–30 min to update texts/data |
| 6 | Backups + restore drill | You | 1–2 h | 10 min |
| 7 | Code improvements from the “known limits” list | AI | 15 min review each | 15–90 min each (table below) |
| 8 | Two-week pilot | You + clinic staff | 5 min/day + staff time | 5–20 min/day to fix feedback |
| 9 | Go / no-go | You | 1 h | 15 min |

**Rough totals:** your hands-on effort ≈ 15–25 hours; calendar time ≈ 4–6 weeks (mostly the lawyer, pharmacist and the 2-week pilot); AI generation time ≈ 6–10 hours in total if every optional improvement in Phase 7 is done, or about 2–3 hours for only the must-do fixes.

---

## Phase 0 — Accounts (you, 1–2 h)
1. **Supabase**: create a free account and a new project (choose the region closest to you; save the database password). Paid plan advised before real patients (daily backups).
2. **GitHub**: create a **private** repository (backups contain patient data).
3. **Hosting** for the website: Netlify, Cloudflare Pages or GitHub Pages (any static host; all free tiers are enough to start).
4. **SMS**: open an account with a Nepal gateway (e.g. Sparrow SMS) or Twilio. Get: API token, sender identity, a small credit. Ask them how sender names are approved and how long it takes (can be days).
5. **Authenticator app** on your phone (Google/Microsoft Authenticator).
6. Install on your computer: Node.js and the Supabase CLI (`npm i -g supabase`).

## Phase 1 — Go online (you + AI, 1–2 h)
1. Supabase → **Project Settings → API**: copy the Project URL and the `anon` public key.
2. Open `app/config.js`, paste them. (Never paste the `service_role` key anywhere in the website files.)
3. Supabase → **SQL Editor** → paste all of `app/setup.sql` → Run. Run it a second time: it must say success again.
4. Supabase → **Authentication → Providers/Settings**: turn **off** “Allow new users to sign up”. Turn on Multi-Factor (TOTP).
5. Authentication → Users → **Add user** (with “Auto confirm”) for: admin, reception, doctor, lab, pharmacy. Then edit `app/staff-setup.sql` with those emails and run it.
6. Upload the whole project folder to your host. Open `…/app/check.html`: every line should be green.
7. **If anything is red or errors:** send me the line and the error text. *AI: 10–30 min each.*

## Phase 2 — Test checklist (you + AI, 3–5 h)
1. Open `TEST-CHECKLIST.md`. Do rows 1–21 (core flow), then 22–48 (messages, print, dashboard, security, modules). Tick each row.
2. For each row that fails, send me: the row number, what you saw, a screenshot. *AI: 5–20 min per bug, usually one file changed.*
3. Re-test only the failed rows after my fix.

## Phase 3 — Server functions and SMS (you + AI, 1–2 h)
1. In a terminal in the project folder: `supabase login`, `supabase link --project-ref YOUR_REF`.
2. Deploy: `supabase functions deploy admin-staff`, `supabase functions deploy report-link --no-verify-jwt`, `supabase functions deploy send-messages`.
3. Set secrets (see `NEXT-STEPS.md`, Step 6). Leave `MSG_PROVIDER` **unset** first: messages go through in *test mode*. Check Admin → Messages shows “sent (test mode)”.
4. Then set your real provider secrets and register one patient **with your own phone number** and SMS consent. Do you get the SMS?
5. If not, copy the provider’s API page (send-SMS section) and the error shown in Admin → Messages and send them to me. *AI: 15–40 min to adapt `send-messages/index.ts`.*
6. Optional: schedule sending every minute (`pg_cron` snippet at the end of `schema_v6.sql`).

## Phase 4 — Real devices (you + AI, 1–2 h)
1. Android phone (Chrome) and iPhone (Safari): open the site, log in as each role, use the bottom tabs and the **More** sheet. Add to Home Screen.
2. Print a slip and a bill on the real printer (80 mm thermal for slips). Scan the slip’s QR with another phone.
3. Put the Queue board on the waiting-room TV (press “Full screen”).
4. Send me photos/screenshots of anything cut off, too small, or misaligned. *AI: 10–30 min per layout fix.*

## Phase 5 — Law, medicine, privacy (you + experts)
1. **Lawyer** (Nepal): give them `privacy.html`, the consent wording on the booking and registration forms, and the retention period. Ask: (a) is this notice enough, (b) how many years must medical records be kept, (c) rules on SMS to patients. Send me their changes and I update the texts and the retention default. *AI: 15–30 min.*
2. **Pharmacist**: review/replace the sample medicines, classes (e.g. “penicillin”), prices and interaction pairs in the Pharmacy screen. If they give you a list (Excel), send it to me and I turn it into an import file. *AI: 20–40 min.*
3. **Doctor**: confirm the prescription screen wording and the “major interaction” rule are acceptable.
4. Fill the `[brackets]` in `privacy.html` (clinic name, address, privacy contact, SMS provider).
5. Only after the lawyer answers: set the retention days in Admin → Settings.

## Phase 6 — Backups and restore drill (you, 1–2 h)
1. GitHub repo → Settings → Secrets → add `SUPABASE_DB_URL` and `BACKUP_GPG_PUBLIC` (create a gpg key; keep the private key offline).
2. Actions → **nightly-backup** → Run workflow. Download the artifact.
3. Do the restore drill in `docs/BACKUP-RESTORE.md` into a **new empty** Supabase project. Check Admin → Audit log → Verify chain.
4. Download the `reports` storage files once (they are not in the SQL backup).
5. Write down the audit-log fingerprint (Verify chain) and keep it somewhere safe.

## Phase 7 — Code improvements AI can build (pick what matters)
Do the **must-do** ones before the pilot. The rest can wait until after it.

| Priority | Improvement (from “known limits”) | AI time |
|---|---|---|
| Must | Fix duplicate token numbers when two desks register at the same instant | 10–15 min |
| Must | Allergy matching: synonym/class table (e.g. “sulfa”, “NSAIDs”) + screen to edit it | 30–45 min |
| Must | Prescription check against the patient’s *earlier* prescriptions, not just the same one | 30–40 min |
| Should | Patient master record (one patient, many visits; allergies saved once) | 60–90 min |
| Should | Doctor sees a patient’s past visits and prescriptions | 45–60 min |
| Should | 2FA recovery codes | 30 min |
| Should | Import medicines/stock from an Excel/CSV file | 30–45 min |
| Should | Patient can cancel/reschedule an online booking; appointment reminder SMS | 45–60 min |
| Could | Dark mode | 30–45 min |
| Could | Nepali language option | 60–90 min |
| Could | Offline-tolerant app shell (service worker) so screens open without internet | 30–45 min (reads work; saving still needs internet) |
| Could | OTC counter sales + returns, stock re-order alerts | 60–90 min |
| Could | Landing page redesign (DONE in v10.2) | done |
| Could | Automatic tests run on every change (GitHub Actions) | 30 min |
| Later | Anything from MedBrains’ “not taken” list (nursing charts, OT, blood bank…) | each is its own project: 1–3 days of AI time |

## Phase 8 — Two-week pilot (you + clinic)
1. Do Phases 1–6 first. Train each role for 30 minutes. **Keep paper as backup the whole time.**
2. Follow `PILOT-PLAN.md`: every day spend 5 minutes on Admin → Feedback, Reports, Messages, Privacy.
3. Send me the feedback list every 2–3 days. *AI: 5–20 min per day of feedback.*
4. Stop rules: wrong patient data shown, wrong or missed-allergy dispense, system down > 30 minutes.

## Phase 9 — Go / no-go (day 14)
Go only if: no safety incidents, staff want to keep using it, backups restore, no open “broken” feedback. Then grow one thing at a time: more doctors → live SMS → pharmacy stock counts → wards → claims.

---

## Suggested order for the next 6 weeks
| Week | Do |
|---|---|
| 1 | Phases 0–2. Start the lawyer and pharmacist conversations (they are the slowest). Ask me for the Phase 7 “Must” fixes. |
| 2 | Phases 3–4. Phase 6 backups. Receive lawyer/pharmacist answers → send them to me. |
| 3 | Finish Phase 5 changes; re-run the checklist rows 22–48; staff training. |
| 4–5 | Phase 8 pilot. |
| 6 | Phase 9 decision; pick Phase 7 “Should/Could” items for the next round. |
