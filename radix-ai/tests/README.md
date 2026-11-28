# Automated checks (optional, for a developer)
- `db/stub.sql` + `db/gen_test.py`: 113 database checks (roles, triggers, audit chain, pharmacy, wards, claims, 2FA gate, retention).
  Needs a local PostgreSQL 14+. Create an empty DB, run `stub.sql` (fake Supabase roles/auth/storage), run `supabase/sql/setup.sql`, then `python3 gen_test.py > test.sql && psql -f test.sql` and read table `tt.res`.
- `ui/ui-smoke.js`: loads the real app files in jsdom with a fake Supabase client, logs in as each role, opens every screen. `cd tests/ui && npm i jsdom qrcode-generator@1.4.4 && node ui-smoke.js` (no paths to edit).
These do NOT replace testing on your real Supabase project (TEST-CHECKLIST.md).
- `ui/ui-screenshots.js` + `ui/stub-browser.js`: loads the real app in headless Chromium (`npm i puppeteer-core @sparticuz/chromium@131 qrcode-generator@1.4.4`), with a stubbed Supabase, and saves phone/desktop screenshots.

- `xray/`: `node --test tests/xray/core.test.mjs` (AI function logic), `db_test.sql` (run after db/stub.sql + supabase/sql/setup.sql), `python3 tests/xray/ui_test.py` (Playwright, demo mode).
