# Step 1: Patient master record

Only NEW files are in this zip. Nothing from your existing project is modified or included.

## Files
- `app/schema_v11.sql`: run once in Supabase SQL Editor, after v10. Safe to re-run.
- `app/app-patients.js`: new screen logic. It adds everything from JavaScript, so `app.js` is untouched.

## 3 steps to add it to the project (do this when you merge with your next zip)
1. Run `app/schema_v11.sql` in Supabase.
2. Copy `app-patients.js` into `app/`.
3. In `app/index.html`, add ONE line between `app-modules.js` and `app-start.js`:
   `<script src="app-patients.js"></script>`

## What it does
**Reception**
- "Find a patient" bar above the form: search by phone (any format: `+977`, spaces, dashes), name, or `PT-000123`.
- **New visit** fills name, phone, age and allergies; **History** opens past visits, with report and bill status.
- Edit details (name, phone, age, sex, allergies) from the History window.
- Live phone hint: green for a valid Nepali mobile (97/98 + 8 digits), amber advice otherwise. It never blocks.
- Typing a new patient by hand still works: the server finds an existing record with the same phone + name, so no duplicates.

**Doctor**
- "Patient history" button and allergy tag on the patient in the room. A doctor can only open patients they have seen.

**Database**
- `patients` table with permanent `patient_no`, linked from `visits.patient_id`. Existing visits are linked automatically (backfill by phone + name).
- Family members who share a phone stay separate (matched on phone + name).
- Functions: `patient_search`, `patient_history`, `patient_update`, `patient_merge` (admin), `patient_erase` (admin), new `register_visit`.
- Audit: create / update / view / merge / erase are logged with IDs only, never names or phones.
- Retention: when retention anonymises a patient's last visit, the patient record is anonymised too (automatic trigger).
- Privacy: reception and admin read `patients`; doctors get data only through `patient_history`.

## Tested
- Your 113 existing database checks still pass with v11 applied.
- 40 new database checks pass (matching, search, role limits, merge, erase, retention, audit has no names).
- Browser check (jsdom) passes: search, autofill, id sent on register, no id for a new patient, history dialog, edit form, doctor button.
- Not tested against your live Supabase project: please run your `TEST-CHECKLIST.md` after merging.

## Decisions to check
- A doctor who has treated a patient can see that patient's earlier visits **and report links from other doctors**. Remove `report_path` for doctors in `patient_history` if you want reports limited to the treating doctor.
- No merge/erase screen yet (admin SQL functions only): `select patient_merge(keep_id, drop_id);`. Say if you want an admin screen.
- Token numbering is unchanged (`count+1`). The race fix is step 3.

## Next: step 2 (queue board with realtime)
