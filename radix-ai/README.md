# RADIX AI — clinic system (landing page + HMS + AI X-ray)

## Folder map
```
index.html, privacy.html     public landing page and privacy notice
app/                         the clinic system (index.html = patient portal, booking, queue board, staff screens; check.html = setup check; manifest.webmanifest = installable app)
xray/                        AI X-ray: index.html (patient upload) and review.html (doctor review)
css/                         colors.css (shared colours) · landing.css · app.css · xray.css
js/config.js                 THE ONE PLACE for your Supabase URL + anon key (used by app/ and xray/)
js/landing.js                landing page script
js/app/                      app scripts, loaded by app/index.html in this order:
                             app, print, security, admin, modules, patients, queue, slip, notes, notify, appointments, start
js/xray/                     common, patient, review
assets/icons/                app icons
supabase/sql/setup.sql       the ONLY database file to run (safe to re-run); staff-setup.sql runs once after you create staff users
supabase/functions/          admin-staff, report-link, send-messages, xray-analyze (edge functions)
tests/                       db/ (154 checks), ui/, xray/
docs/                        guides, checklists, pilot plan, screenshots
.github/workflows/           nightly encrypted backup
```
## Set up
1. Supabase > SQL Editor: run `supabase/sql/setup.sql`; create staff users; run `supabase/sql/staff-setup.sql`.
2. Put your URL + anon key in `js/config.js`.
3. Deploy functions: `supabase functions deploy admin-staff report-link send-messages xray-analyze` (secrets: see `docs/NEXT-STEPS.md` and `docs/XRAY-README.md`).
4. Host the folder as static files over https (Netlify, Cloudflare Pages, Vercel, GitHub Pages). Open `app/check.html` to verify the connection.

Links: landing → `app/#book`, `app/#board`, `app/#staff`, `xray/`; app/xray → back to `/`.
Local preview: `python3 -m http.server 8000` in this folder, then open http://localhost:8000/
