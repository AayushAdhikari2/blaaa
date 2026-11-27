# Next 10 steps to complete the project

1. **Set up the database** (use `app/setup.sql` + `app/staff-setup.sql`). Create the Supabase project, run `app/schema.sql` then `app/schema_v3.sql`, turn off public sign-ups, and make the first admin user (SQL in SUMMARY.md).
2. **Connect and test locally** (follow `TEST-CHECKLIST.md`, start with `app/check.html`). Fill `app/config.js`, serve the folder with a local web server (not by double-clicking the file), and test the full flow with one user per role: reception registers, doctor calls in and orders a report, lab uploads, patient checks status, reception bills.
3. **Fix what the test shows.** Write down every confusing screen or missing field from step 2 and fix it before showing staff.
4. **Admin screen.** Add staff accounts, roles, doctors, departments and average consultation time from inside the app instead of SQL.
5. **Private report links.** Replace the public report links with signed, expiring links (Supabase Edge Function), and limit file type and size.
6. **Patient messages.** SMS or WhatsApp with a Nepal-friendly gateway: booking confirmed, "2 patients ahead", "report is ready".
7. **Print and QR.** Printable slip and bill with a QR code that opens the patient status page with the bill no filled in.
8. **Reports and dashboard.** Daily patients per doctor, average waiting time, revenue, unpaid bills, with CSV export.
9. **Security and privacy.** Audit log of who changed what, rate limiting at the edge, automatic backups, privacy policy and consent text, data-retention rule, staff two-factor login.
10. **Pilot, then grow.** Run it in one real clinic for two weeks, collect feedback, fix, then add modules (pharmacy, beds/admission, insurance claims).
