# RADIX AI + Carepulse: merged project

This folder is the base project (v10_2, with the v11 safety fixes) merged with the patient/queue/notification/clinical/appointment/triage steps and the X-ray module.

## Set up (3 steps)
1. **Database:** paste ALL of `supabase/sql/setup.sql` into Supabase > SQL Editor > Run. It is the only SQL file you need and is safe to re-run.
   Then run `supabase/sql/staff-setup.sql` once (after creating your staff users), as before.
2. **Config:** fill `js/config.js`, deploy the functions in `supabase/functions` as described in `NEXT-STEPS.md`.
3. **App:** serve the whole project folder (the pages use `../css` and `../js`). `app/index.html` already loads every script from `js/app/` in the right order.

## What is inside `supabase/sql/setup.sql` (in this order)
base schema + v3..v11 -> patient master record -> queue (realtime, call_next) -> merged register_visit -> notifications -> clinical notes -> appointments -> triage -> X-ray tables.

## Where the two zips overlapped, and what I did
| Conflict | Resolution |
|---|---|
| Both had a "v11" (base: safety fixes, patients zip: patient record) | Both are included; base v11 runs first |
| Two token fixes (base `token_counters`, patients zip `token_counter`) | Kept the base one (`next_token`). The duplicate was not applied |
| Two `register_visit` versions (short bill `BL-0012` vs patient-aware) | One merged version: patient linking + short bill numbers + atomic token. Old 8-argument version is dropped |
| Two `patient_history` functions (by visit vs by patient) | The doctor's "Earlier visits" panel now uses `visit_patient_history(p_visit)`; the patient window uses `patient_history(p_patient)`. `app-modules.js` was updated for the new name |
| `patient_status` in the triage step lost short bill numbers | Fixed to use `norm_bill()`, so `12`, `bl12`, `BL-0012` all work |
| Two `app-queue.js` | Used the newer one (with triage). The older one is not included |

## Tested here (local PostgreSQL 16 with Supabase stubs, and jsdom)
- `setup.sql` runs with no errors on a fresh database and 3 times in a row.
- Base database suite: 154 checks pass, 0 fail (history checks point at `visit_patient_history`).
- Browser smoke test (all roles, all screens, the slip dialog, booking): no errors. Both test scripts were updated for the merge.
- **Not tested:** your live Supabase project, a real phone, a real printer, the X-ray AI function, or the SMS gateway. Run `TEST-CHECKLIST.md` before using it with real patients.

## Notes
- X-ray module: web pages are in `xray/` (scripts in `js/xray/`); its tables are already in `setup.sql`. Its `xray-analyze` function still needs deploying (see `docs/XRAY-README.md`).
- Patient-step docs are in `docs/build-steps/`. Step 8 onward (lab catalogue, billing depth, etc.) is not built yet.
- Check the "Decisions to check" sections in `docs/build-steps/`, for example doctors seeing other doctors' report links in patient history.
