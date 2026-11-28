# RADIX AI — clinic system (landing page + HMS + AI X-ray)

## Folder map
```
index.html, privacy.html     public landing page and privacy notice
app/                         the clinic system (index.html = patient portal, booking, queue board, staff screens; check.html = setup check; manifest.webmanifest = installable app)
xray/                        old links only: index.html and review.html redirect into the app (AI X-ray is now part of app/)
css/                         colors.css (shared colours) · landing.css · app.css · ui.css (toasts, dialogs, bell, AA colours) · xray.css
js/config.js                 THE ONE PLACE for your Supabase URL + anon key
js/landing.js                landing page script
js/app/                      app scripts, loaded by app/index.html in this order:
                             ui (first), app, print, security, admin, modules, patients, queue, slip, notes, notify, inbox, appointments, xray, start
                             ui.js = the ONE toast + dialog system · inbox.js = notification bell · xray.js = AI X-ray (patient scan + doctor review)
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

Links: landing → `app/#book`, `app/#board`, `app/#staff`, `app/#xray`; the app logo → back to `/`.
Local preview: `python3 -m http.server 8000` in this folder, then open http://localhost:8000/

## Popups and notifications (how to use them)
- Never call `alert()`, `confirm()` or `prompt()`. Use `toast(msg)`, `UI.toast(msg,'warning'|'info'|'error'|'success'|'loading')`, `await ask({title,message,confirm,danger:true})`, `await askText({...})`, and `UI.modal(label,node)` for form popups.
- Notifications are created by database triggers (`ntf_*` in setup.sql) after real changes, never by button clicks. To add one, call `notify(...)` from a trigger. Previews must not contain patient names.
- Admin > Settings: low-stock alert level and the booking terms and conditions text patients must accept.
- Tests: `tests/db/gen_notify_test.py` (114 DB checks), `tests/ui/notify-ui.js` (80 browser checks, needs Playwright), `tests/ui/audit.js` (layout + accessibility audit, needs axe-core).
