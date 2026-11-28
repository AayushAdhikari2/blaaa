# RADIX AI X-ray (standalone module, v1)

A patient uploads a plain X-ray. AI drafts a report. A doctor checks and approves it. The patient reads it with a report number and code.
It does not change anything in the main RADIX AI project.

## Try it now (demo mode)
In this folder run `python3 -m http.server 8000`, then open http://localhost:8000
While `js/config.js` has placeholder values: no AI is called, the report is fixed sample text, and data stays in your browser.

## How it works
1. The browser opens the image, resizes it (longest side 2576 px max) and re-encodes it, which removes hidden photo data such as GPS.
2. The image is shown only during the scan, then wiped from the page, whether the scan succeeds or fails.
3. The `xray-analyze` function sends it to the AI from memory. It writes the image to no storage, database or log. There is no image column or bucket.
4. The AI returns: image quality, findings (with significance and confidence), impression, urgency, next steps, limitations, plain-language summary.
   A non-X-ray or unreadable image saves nothing.
5. The draft is saved as "pending review". Urgent drafts go to the top of the doctor's queue.
6. The doctor checks the original X-ray, edits, then releases or rejects. The original AI draft is kept unchanged beside the final version.
7. The patient sees only the doctor's version, with the doctor's name, registration number and a note that AI was used.

## What "image deleted" means
- **Your system:** never saves it. Only a fingerprint (SHA-256 of the original file) is stored.
- **The AI provider:** Anthropic normally deletes API inputs and outputs within 30 days. Longer for flagged content (up to 2 years), legal reasons,
  or other listed exceptions. https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
  Do not tell patients the image is deleted everywhere immediately. A zero-data-retention agreement is a separate arrangement with Anthropic.
- **The patient's device** and any hosting/network service keep their own behaviour. Check that your host does not log request bodies.
- Because you keep no image, **you cannot re-check a disputed report against it**. Ask a lawyer whether medical-record rules require keeping it.

## Why a doctor must approve
Anthropic's Usage Policy (effective 12 Nov 2026, https://www.anthropic.com/aup) requires a qualified person, with authority to change it, to review
high-risk medical output before the individual receives it, and requires telling the person AI was used. It is also a safety matter:
Anthropic says Claude's image analysis is not a substitute for professional diagnosis and that it is not designed to interpret CT or MRI
(https://platform.claude.com/docs/en/build-with-claude/vision). **This module's accuracy on X-rays has not been measured.**
It can miss real problems and report ones that are not there. It is not a certified medical device.

## Real setup
1. Supabase project (new, or the same one as the HMS: all names start with `xray_`).
2. SQL Editor: run `sql/xray_setup.sql`.
3. Authentication: turn off public sign-ups, add each doctor, then register them:
   ```sql
   insert into xray_reviewers(user_id, full_name, registration_no)
   select id, 'Dr. Name', 'REGISTRATION-NUMBER' from auth.users where email = 'doctor@example.com';
   ```
   Add only people qualified to read X-rays.
4. Get an API key from the Claude Console. Then:
   ```
   supabase secrets set ANTHROPIC_API_KEY=... XRAY_IP_SALT=<long random text> XRAY_ALLOWED_ORIGIN=https://your-site
   supabase functions deploy xray-analyze --no-verify-jwt
   ```
   Optional: `XRAY_AI_MODEL` (default `claude-opus-5-5`), `XRAY_AI_EFFORT` (default `medium`).
5. Put the Supabase URL and anon key in `js/config.js`. Never put the AI key there. Host on https.

**Cost and abuse:** anyone can upload, so limits are 5 scans per connection per hour and 100 per day in total (rejected uploads count).
Change with `update xray_limits set per_ip_hour=5, per_day=100;`. A determined attacker can fake the connection address or use up the daily total,
so also set a spend limit in the Claude Console. Consider a CAPTCHA or a clinic-issued upload code before going public.
Each scan is billed by tokens; check real usage in the Console after a few test scans. Pricing: https://platform.claude.com/docs/en/about-claude/pricing

## Test before real patients
- Deploy, then scan a normal photo (must be refused) and several de-identified X-rays.
- Have a radiologist compare drafts with their own reads on a set that includes normal and abnormal cases, **including subtle fractures and chest findings**.
  Count misses and false alarms, and decide in advance what result is good enough. Repeat after changing the model or prompt.
- Check the function logs and database: no image data anywhere.
- Try a real phone (Android and iPhone), a large file, a slow connection, and printing.

## Not in v1
- DICOM, CT, MRI, ultrasound; several views in one report; marking areas on the image.
- Alerts to the doctor for urgent drafts (someone must watch the queue; it does not refresh by itself). Patients are not shown AI urgency before review.
- Two-factor login for reviewers (comes with the HMS sync), SMS, billing, data retention/erasure tools, Nepali language.
- A lost access code cannot be recovered in the app.
- Text printed on the image is sent to the AI. The prompt tells it not to copy names, but patients should crop or cover them.

## Later: sync with the HMS
| Standalone now | After sync |
|---|---|
| `xray_reviewers`, `xray_is_reviewer()` | Use HMS `profiles` / `my_role()`, so the HMS two-factor rule applies. Add registration number to profiles. Decide which doctors may review. |
| Patient types name, phone, age | Verify bill no. + code and fill them from `visits`; save `xray_reports.visit_id` (column is ready; add the foreign key) |
| `XR-` number + own code | Show the X-ray report inside the HMS patient status page |
| `review.html` | A tab in `app/index.html`; doctor sees "X-ray waiting" on the visit |
| Own event log | Write into the HMS hash-chained audit log |
| Not covered | Add to retention, privacy requests, backups, billing and "report ready" SMS |
| `colors.css` copy | Use the root `colors.css` |
Also update `privacy.html` to name the AI provider and describe this processing.

## Tests
- `node --test tests/core.test.mjs` — AI function logic, with the AI service faked (15 tests).
- `tests/db_test.sql` — database rules (38 checks). Empty PostgreSQL database: run `tests/stub.sql`, `sql/xray_setup.sql`, then this file.
- `python3 tests/ui_test.py` — browser flow in demo mode (15 checks).

**Not tested:** a real Supabase project, the deployed Edge Function (`index.ts` was not run), a real AI call, real X-rays, real phones.

## Files
```
index.html            patient: upload, scan, my report
review.html           doctor: queue, check original, edit, release/reject
js/  xray.css  colors.css
sql/xray_setup.sql    database
supabase/functions/xray-analyze/   index.ts (server) + core.js (prompt, checks, AI call)
tests/
```
