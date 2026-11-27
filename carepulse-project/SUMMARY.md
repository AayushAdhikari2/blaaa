# Carepulse — project summary

## What we started with
`carepulse-site.zip`: a portfolio landing page (index.html, styles.css, script.js). Static HTML/CSS/JS, green brand `#2ba67a`, Inter font. No real system behind it.

## What was built
Goal: a real hospital system, starting simple: a patient registers or books, sees the doctor, then uses **bill no + code** to open their status (waiting list no., report status, report waiting time, next waiting time).

| Version | What it added |
|---|---|
| v1 (demo page) | Reception, Doctor queue and Patient Portal in one HTML file. Data in one browser only. |
| v2 | Shared Supabase database. Staff login. Patient looks up by bill no + code through a safe database function. Nepal-time dates. |
| v3 | Roles (reception / doctor / lab / admin) enforced by the database. Lab screen with report upload. Billing (charges, paid/unpaid). Online appointment requests. Wrong-code lockout (5 tries / 15 min). Design and colours taken from the portfolio (`app/theme.css`). |
| This package | The portfolio landing page and the HMS joined in one project. |

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
```

## Setup in order
1. Create a Supabase project.
2. SQL Editor: run `app/schema.sql`, then `app/schema_v3.sql`.
3. Authentication: add staff users, turn off public sign-ups, then give each a role (SQL below).
4. Put URL and anon key into `app/config.js`.
5. Upload the whole folder to GitHub Pages / Netlify (https).

Give a role to a staff user (SQL Editor):
```sql
insert into profiles(id, full_name, role, doctor_id)
select id, 'Dr. Sharma', 'doctor', 'd1' from auth.users where email = 'sharma@example.com';
-- roles: reception, doctor (set doctor_id d1/d2/d3), lab, admin
```

## Not done yet
- Admin screen (add staff, doctors, departments). Today this is done in SQL.
- Signed (private) report links. Today the report link is public but unguessable.
- SMS/WhatsApp "your turn is near", printable bill/slip, daily reports.
- Not yet tested against a live Supabase project. Test each role once after setup.
- Real patient data needs backups, privacy review and a paid Supabase plan.

See NEXT-STEPS.md for the 10 steps to finish the project.
