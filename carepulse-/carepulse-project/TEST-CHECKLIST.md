# Step 2 — local test checklist

## Run it locally
Do NOT double-click index.html (login and storage need http). In the project folder run one of:

    python3 -m http.server 8000        # then open http://localhost:8000
    npx serve .                        # then open the address it prints

First open `http://localhost:8000/app/check.html` — every line must show ✓ OK.
Type a staff email + password to also check that user's role.

## Full flow (use two browser windows: one staff, one private/incognito for the patient)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 1 | Visitor | Landing page -> Book Appointment, send a request | "Request received" |
| 2 | reception@ | Login -> Online requests -> Register | Form filled with the request |
| 3 | reception@ | Register the patient | Slip with Bill no + 6-digit code |
| 4 | Patient (incognito) | Landing page -> Check my status -> bill no + code | Waiting list no. #1, estimated wait, Waiting |
| 5 | Patient | Enter a wrong code 5 times | "Too many wrong tries" message |
| 6 | doctor@ | Doctor tab -> Call in | Patient screen changes to "With doctor" within ~5 s |
| 7 | doctor@ | Send for report (Blood test, 15 min) | Patient sees report In progress + countdown |
| 8 | lab@ | Lab tab -> choose a PDF -> Upload & mark ready | Patient sees Report Ready + Download button |
| 9 | doctor@ | Patient is back in queue ("returning with report") -> Call in -> Complete visit | Patient screen: Completed |
| 10 | reception@ | Billing: add Consultation 500, Lab 800, Mark paid | Patient sees Rs 1,300 Paid |

## Role checks (each should be refused or hidden)
- doctor@ cannot see Reception or Lab tabs.
- lab@ cannot see Billing.
- A second doctor account (d2) does not see Dr. Sharma's patients.

## Write down every problem
Copy the failing row number and what you saw. Send it to me and I will fix it (step 3).

## Admin screen (step 4)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 11 | admin@ | Admin tab -> add a staff member (role Reception) | Toast "Account created"; appears in list; they can log in |
| 12 | admin@ | Edit that staff -> change role to Doctor, pick a doctor | Saved; their next login shows the Doctor tab |
| 13 | admin@ | Edit -> type a new password | They can log in with the new one |
| 14 | admin@ | Try to remove yourself / demote the only admin | Refused with a message |
| 15 | admin@ | Add a doctor; untick Active on another | New doctor in booking + registration; inactive one hidden |
| 16 | reception@ | Open the site, look for an Admin tab | Not visible |

## Private reports (step 5)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 17 | lab@ | Upload a .docx or a file over 10 MB | Refused with a message |
| 18 | Patient | Status page -> Open my report | Report opens in a new tab |
| 19 | Anyone | Copy that long link, wait 6 minutes, reopen | Link no longer works |
| 20 | Anyone | Open the old public URL `.../object/public/reports/...` | Not found |
| 21 | doctor@ | Open uploaded report | Opens |

## Patient messages (step 6) — works in test mode, no gateway needed
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 22 | reception@ | Register a patient with “agrees to SMS” ticked | Admin > Messages: a “registered” line, status sent (test mode) |
| 23 | reception@ | Register another patient **without** the SMS tick | No message for them, ever |
| 24 | doctor@ | Register 4 patients for one doctor, call the first in | “N patients ahead” messages for the 2nd/3rd only, once each |
| 25 | lab@ | Mark a report ready | “report ready” message; text never shows the test name or the code |
| 26 | Patient | Status page → Stop SMS updates | Toast “SMS updates stopped”; later actions queue nothing |

## Print and queue board (step 7)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 27 | reception@ | After registering press Print slip | Print preview: token, bill no, code, QR, nothing else on the page |
| 28 | Phone | Scan the QR | Status page opens with the patient’s status already loaded |
| 29 | reception@ | Billing → Print bill | Itemised bill with total and PAID / UNPAID |
| 30 | Anyone, logged out | Queue board | Doctors with “Now serving” and “Next” tokens, **no names**; updates in 5 s |

## Dashboard (step 8)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 31 | admin@ | Admin > Reports (this week) | Visits, avg wait, avg report turnaround, collected, unpaid match what you did in the flow above |
| 32 | admin@ | Export visits (CSV, no names) | File opens in Excel/Sheets; no names, no codes. Admin > Audit log shows an EXPORT line |
| 33 | reception@ | Look for Reports | Not visible; calling it is refused |

## Security and privacy (step 9)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 34 | admin@ | Security tab → set up authenticator → Admin > Settings → require 2FA | Other staff are asked to set up 2FA at next login |
| 35 | doctor@ | Log in after that | Must enter or set up a code before any screen opens |
| 36 | admin@ | Audit log → Verify chain | “Chain intact”. No patient names appear in the list |
| 37 | Anyone | Leave a staff screen idle 15 min | Logged out with a message |
| 38 | Visitor | Booking without the privacy tick | Refused. Four requests in an hour from one phone → “Too many requests” |
| 39 | Patient | Status page → Privacy request | Admin > Privacy shows it with a due date |
| 40 | admin@ | Settings → Data retention → Preview (set retention to 90 days on a test copy only) | Counts of visits that would be anonymised. Run only on test data first |
| 41 | You | GitHub Action “nightly-backup” → Run workflow, then restore it into a spare Supabase project | Tables and rows come back |

## Modules (step 10)
| # | Who | Do this | You should see |
|---|-----|---------|----------------|
| 42 | doctor@ | Consultation card → allergies “penicillin” → Save, prescribe Amoxicillin | Refused: ALLERGY CONFLICT |
| 43 | doctor@ | Prescribe Ibuprofen + Warfarin | Asks for a reason (major interaction), then sends |
| 44 | pharmacy@ | Stock → add a batch → Pharmacy queue → Dispense | Stock falls from the earliest-expiry batch; charge appears on the bill; patient page says “medicines dispensed” |
| 45 | pharmacy@ | Add a batch that already expired | Refused; an expired batch already in stock is never dispensed |
| 46 | reception@ | Wards → Admit → Transfer → Discharge (with summary) | Bed colours change; bed charge lines added to the bill |
| 47 | reception@ | Claims → new claim → Submit → (admin) Approve → Mark paid | Status steps in order; skipping a step is refused |
| 48 | any staff | Feedback button | Admin > Feedback shows it |
