# RADIX AI — the 10 steps, status

Steps 1–10 are now built. What is left for each one is a **setup action that only you can do** (accounts, keys, a real clinic).
Run `app/setup.sql` once (it contains everything, safe to re-run), then do the actions below.

| # | Step | Built | Your action |
|---|------|-------|-------------|
| 1 | Database | `setup.sql`, `staff-setup.sql` | Create the Supabase project, run both, turn off public sign-ups |
| 2 | Connect and test | `check.html`, `TEST-CHECKLIST.md` | Fill `app/config.js`, serve over http, run checklist rows 1–10 |
| 3 | Fix what the test shows | **Feedback button** for staff + Admin > Feedback | Ask testers to press “Feedback” whenever something is confusing |
| 4 | Admin screen | Admin > Team (now with Reset 2FA and the Pharmacy role) | `supabase functions deploy admin-staff` |
| 5 | Private report links | signed 5-minute links, now written to the audit log | `supabase functions deploy report-link --no-verify-jwt` |
| 6 | **Patient messages** | consent-based SMS/WhatsApp queue, triggers, `send-messages` function, Admin > Messages | `supabase functions deploy send-messages`, then set gateway secrets (below). Works in **test mode** with no gateway |
| 7 | **Print and QR** | 80 mm slip and A4/A5 bill with QR, public **Queue board** (tokens only) | Admin > Settings: set “Public address” once the site is online. Print a test slip |
| 8 | **Reports and dashboard** | Admin > Reports: visits, waits, report turnaround, revenue, unpaid bills, CSV | Nothing. Pick a date range |
| 9 | **Security and privacy** | audit log (hash-chained), 2FA, 15-min auto logout, rate limits, consent, privacy requests, retention, backups, CSP | See “Step 9 actions” below |
| 10 | **Pilot, then grow** | feedback, pilot plan, **Pharmacy**, **Wards/Beds**, **Insurance claims** | Follow `PILOT-PLAN.md` in one real clinic for two weeks |

## Step 6 — gateway secrets
```
supabase functions deploy send-messages
supabase secrets set MSG_PROVIDER=sparrow SPARROW_TOKEN=xxxx SPARROW_FROM=YourIdentity     # Nepal SMS
#  or WhatsApp / SMS through Twilio:
supabase secrets set MSG_PROVIDER=twilio TWILIO_SID=xxxx TWILIO_TOKEN=xxxx TWILIO_FROM=+1555xxxxxxx  [MSG_CHANNEL=whatsapp]
```
With no `MSG_PROVIDER` messages are marked “sent (test mode)” and nothing leaves the server. Check your provider’s documentation for the exact request format and sender registration before going live: the Sparrow call in `send-messages/index.ts` follows its public v2 format but was **not** tested against a live account.
The app asks the function to send right after each action. For sending when nobody has the app open, use the optional `pg_cron` snippet at the bottom of `schema_v6.sql`.

## Step 9 actions
1. Admin: Security tab → set up your own authenticator, then Admin > Settings → tick “Require two-factor login”. (Supabase > Authentication > Multi-Factor must allow TOTP.)
2. Add the backup secrets and run the **nightly-backup** workflow once (`.github/workflows/backup.yml`). Then do a restore drill (`docs/BACKUP-RESTORE.md`). Also turn on Supabase’s own backups (paid plan).
3. Fill in the `[brackets]` in `privacy.html` and have it checked by a lawyer. Set the retention period in Admin > Settings after checking the legal rules for medical records.
4. Edge rate limiting (DDoS, scraping) needs a service in front of your site, for example Cloudflare. The database already limits wrong-code guessing, booking spam (3/hour per phone, 100/hour overall) and privacy-request spam.
5. Write down the audit-log fingerprint (Admin > Audit log > Verify) now and then.

## What is deliberately not done
- No real hospital should run on this before the pilot, a lawyer’s review and a restore drill.
- Drug names, interaction pairs and prices in `schema_v10.sql` are **samples**. A pharmacist must review them.
- Not built: eMAR/nursing charts, operation theatre, blood bank, payroll, HL7/FHIR/DICOM, ABDM. See `docs/FROM-MEDBRAINS.md`.

## Using it on a phone
Open `…/app/` in Chrome (Android) or Safari (iPhone) → menu → **Add to Home Screen**. It opens full-screen like an app with the RADIX AI icon. Phones get a bottom tab bar (the 5th slot, “More”, opens the other screens); computers get a left sidebar. The app needs internet: when the connection drops a red banner appears. Keep paper as backup.
