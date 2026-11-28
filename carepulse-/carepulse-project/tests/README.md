# Automated checks (optional, for a developer)
- `stub.sql` + `gen_test.py`: 113 database checks (roles, triggers, audit chain, pharmacy, wards, claims, 2FA gate, retention).
  Needs a local PostgreSQL 14+. Create an empty DB, run `stub.sql` (fake Supabase roles/auth/storage), run `app/setup.sql`, then `python3 gen_test.py > test.sql && psql -f test.sql` and read table `tt.res`.
- `ui-smoke.js`: loads the real app files in jsdom with a fake Supabase client, logs in as each role, opens every screen. `npm i jsdom qrcode-generator@1.4.4`, fix the two paths at the top, `node ui-smoke.js`.
These do NOT replace testing on your real Supabase project (TEST-CHECKLIST.md).
