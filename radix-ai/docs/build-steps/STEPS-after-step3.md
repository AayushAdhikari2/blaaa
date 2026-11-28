# Radix / Carepulse: build steps

Each step is a self-contained set of NEW files (a `schema_vNN.sql` + `app-<name>.js`) that you drop into `app/`.
Steps are ordered by dependency. Mark them off as you go.

| # | Step | Depends on | Status |
|---|------|-----------|--------|
| 1 | **Patient master record + search**: patients table, permanent PT number, search by phone/name, autofill, history, edit, merge, erase | none | **DONE (this zip)** |
| 2 | Queue board UI (doctor + reception): Now seeing / Next up / Waiting / Back from lab, one-tap "Call next", realtime instead of 5 s re-render | 1 | **DONE (this zip)** |
| 3 | Token race fix (per-doctor-per-day counter) + print-ready slip with QR | none | **DONE (this zip)** |
| 4 | Notifications: booking confirmed, "2 patients ahead", report ready, day-before reminder (extends existing outbox/send-messages) | 1 | next |
| 5 | Clinical notes + vitals + printable prescription + follow-up date | 1 | |
| 6 | Real appointments: doctor schedules, slots, confirm/reschedule/cancel, no-show | 1 | |
| 7 | Triage and queue control: priority flag, skip/recall, not present, per-doctor pause | 2, 3 | |
| 8 | Lab test catalogue with prices feeding billing | none | |
| 9 | Billing depth: partial payments, method (cash/eSewa/Khalti/card), discount reason, refunds, receipt no. | 8 | |
| 10 | Patient portal UX: "your turn" hero, remember last bill no., QR scan, calm status states | 2 | |
| 11 | System-wide UX: modal dialogs + undo toast, skeletons/empty states, mobile cards, 44 px tap targets, accessibility | any | |
| 12 | Admin dashboard (today's patients, avg wait, revenue, unpaid) + CSV | 9 | |
| 13 | Compliance extras: consent record per patient, "who viewed this report" screen (data already logged) | 1 | |
| 14 | Nepal touches: Nepali toggle, Bikram Sambat dates, NPR comma style (phone check is already in step 1) | any | |
| 15 | Later modules: referrals, doctor mobile view | | |

Pharmacy, wards/beds, insurance claims and 2FA already exist in your v10 code, so they are not repeated here.
