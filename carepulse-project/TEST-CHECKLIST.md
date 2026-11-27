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
