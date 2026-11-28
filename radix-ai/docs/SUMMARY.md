# RADIX AI — project summary

## What we started with
`radix-ai-site.zip`: a portfolio landing page (index.html, styles.css, script.js). Static HTML/CSS/JS, green brand `#2ba67a`, Inter font. No real system behind it.

## What was built
Goal: a real hospital system, starting simple: a patient registers or books, sees the doctor, then uses **bill no + code** to open their status (waiting list no., report status, report waiting time, next waiting time).

| Version | What it added |
|---|---|
| v1 (demo page) | Reception, Doctor queue and Patient Portal in one HTML file. Data in one browser only. |
| v2 | Shared Supabase database. Staff login. Patient looks up by bill no + code through a safe database function. Nepal-time dates. |
| v3 | Roles (reception / doctor / lab / admin) enforced by the database. Lab screen with report upload. Billing (charges, paid/unpaid). Online appointment requests. Wrong-code lockout (5 tries / 15 min). Design and colours taken from the portfolio (`app/theme.css`). |
| v4 | Admin screen (staff, roles, passwords, doctors, departments). Clearer report flow: doctor "Send to lab" and lab upload keep what you typed, validate, confirm and show messages. |
| v5 | Private reports: signed 5-minute links, size/type limits. |
| v5 package | The portfolio landing page and the HMS joined in one project. |
| **v6** | Patient messages: consent-based SMS/WhatsApp queue (registered, N patients ahead, called, report ready), `send-messages` function, test mode. |
| **v7** | Printable slip and bill with QR; public queue board (token numbers only); duplicate-phone hint at registration. |
| **v8** | Admin dashboard: waits, consultation time, report turnaround, revenue, unpaid bills, CSV export. |
| **v9** | Security and privacy: hash-chained audit log, two-factor login, 15-min auto logout, rate limits, consent, privacy requests, retention, encrypted backups, content-security policy. |
| **v10.2** | Safety fixes: atomic token numbers, allergy synonym/class table (+ admin screen), interaction check against the patient’s earlier prescriptions, doctor’s “earlier visits” panel, medicine CSV import. `schema_v11.sql` (already inside `setup.sql`). |
| **v10.1** | Renamed to **RADIX AI** (new logo, app icons, install-to-home-screen manifest). Mobile-first redesign: bottom tab bar + “More” sheet on phones, sidebar on desktop, 44px+ touch targets, big patient status block, offline banner, Enter-to-submit. |
| **v10** | Pilot kit (feedback button, pilot plan) and first modules: pharmacy (allergy + interaction checks, FEFO stock, billing), wards/beds, insurance claims. Ideas from MedBrains: `docs/FROM-MEDBRAINS.md`. |

## How the landing page and the HMS are connected
- **One colour file:** `colors.css` at the project root. Both `index.html` and `app/index.html` load it, so changing the brand colour there changes both. (`styles.css` and `app/theme.css` no longer define colours.)
- **Navigation bar:** Book Appointment -> `app/#book`, Staff Login -> `app/#staff`, Check my status -> the new status section on the landing page.
- **New "For patients" section** on the landing page: patient types bill no + code, the page opens the HMS portal with the status already loaded (the code is removed from the address bar).
- **Pricing buttons** now open online booking.
- The HMS logo links back to the landing page.

## Folder
```
index.html, styles.css, script.js   original portfolio landing page (now linked to the app)
colors.css                          shared colour data for both parts
app/index.html                      the HMS (all screens)
app/app.js                          app logic
app/theme.css                       app components (colours come from ../colors.css)
app/config.js                       your Supabase URL + anon key
app/schema.sql                      database part 1 (tables, queue/bill functions)
app/schema_v3.sql                   database part 2 (roles, lab, billing, appointments, lockout)
app/schema_v4.sql                   database part 3 (admin staff list, doctor active flag)
app/schema_v5.sql                   database part 4 (private reports bucket)
app/schema_v6.sql … schema_v11.sql  messages / board / reports / security / pilot + modules
app/setup.sql                       ALL database parts in one file (run this)
app/app.js                          core: login, reception, doctor, lab, patient portal
app/app-print.js                    slip + bill + QR, queue board, duplicate hint
app/app-security.js                 2FA screens, Security tab, idle logout, feedback button
app/app-admin.js                    admin sub-screens (settings, reports, messages, privacy, audit, feedback)
app/app-modules.js                  pharmacy, prescribing, wards, claims
app/app-start.js                    boot (loads last)
privacy.html                        privacy notice template (fill in the brackets)
docs/                               backup/restore drill, MedBrains feature map
PILOT-PLAN.md                       step 10 plan
.github/workflows/backup.yml        nightly encrypted backup
supabase/functions/admin-staff/     server function that creates/edits/removes staff logins
supabase/functions/report-link/     server function that gives a patient a short-lived report link
supabase/functions/send-messages/   server function that delivers queued SMS / WhatsApp
```

## Setup in order
1. Create a Supabase project.
2. SQL Editor: run **`app/setup.sql`** (everything, steps 1–10).
3. Authentication: add staff users, turn off public sign-ups, then give each a role (SQL below).
4. Put URL and anon key into `app/config.js`.
5. Upload the whole folder to GitHub Pages / Netlify (https).

Give a role to a staff user (SQL Editor):
```sql
insert into profiles(id, full_name, role, doctor_id)
select id, 'Dr. Sharma', 'doctor', 'd1' from auth.users where email = 'sharma@example.com';
-- roles: reception, doctor (set doctor_id d1/d2/d3), lab, pharmacy, admin
```

## Not done yet
- **Not yet run against a live Supabase project.** The database layer was tested on a real PostgreSQL with Supabase-style roles (154 checks) and the screens in a simulated browser, but not on Supabase itself, with a real SMS gateway, or on a real printer. Run `TEST-CHECKLIST.md` once on your own project.
- Sample drugs, interactions and prices need a pharmacist's review.
- Real patient data needs backups, privacy review and a paid Supabase plan.

See NEXT-STEPS.md for the 10 steps to finish the project.
