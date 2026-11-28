# Features taken from MedBrains (and what was left out)

Source: the public README of https://github.com/medbrains/medbrains (an open-source hospital system in Rust, PostgreSQL and React).

**Licence note.** MedBrains is AGPL-3.0. No MedBrains code was copied or translated. Only feature *ideas* from its README were rebuilt from scratch on this project’s own stack (Supabase + plain JavaScript), so RADIX AI keeps its own licence. If you ever copy actual MedBrains code, the AGPL’s “share your changes” terms apply to your whole service. Their pledge also says commercial use needs a separate licence.

| MedBrains feature (from its README) | In RADIX AI | Where |
|---|---|---|
| OPD token queue and token display boards | Public queue board: tokens only | Board tab, `queue_board()` |
| Duplicate-patient check while you type | “This number was seen before” hint with one-click fill | Reception form |
| Prescriptions with drug-interaction checks | Interaction pairs, major ones need a doctor’s reason | `create_rx`, `rx_check` |
| Allergy conflicts block dispensing on the server | Allergy check at prescribing **and** at the counter; cannot be overridden | `dispense_rx` |
| Stock with batches and expiry, first-expiry-first-out | Same; expired batches never dispensed; dispensing adds to the bill | Pharmacy tab |
| Admission, live bed board, discharge | Wards tab: admit, transfer, discharge summary, bed charges to the bill | `admit_patient` etc. |
| Insurance / TPA claims | Claims tab with enforced status order | `claims` table + trigger |
| Dashboards, CSV export, quality indicators | Waiting time, consultation time, report turnaround, revenue, unpaid, CSV | Admin > Reports |
| Tamper-evident audit log (hash-chained, append-only) with export | Same idea; personal data is never written to it; “Verify chain” | Admin > Audit log |
| Roles and field-level access | Roles already existed; a new `pharmacy` role; allergy/consent fields limited by role | triggers/policies |
| TOTP second factor | Authenticator-app login, can be required for all staff | Security tab |
| Automatic logoff after inactivity (MedBrains lists this as *not started*) | 15-minute auto logout | `app-security.js` |
| Consent recorded purpose by purpose; withdraw as easily as giving it | SMS consent at registration; patient can stop SMS from their status page | `consent_sms` |
| Privacy requests (access, correction, erasure) tracked with due dates | Same; staff decide, deletion may be rejected for legal retention | Admin > Privacy |
| Erase when the purpose ends | Retention rule: anonymise old visits and delete report files | Admin > Settings |
| Backups with a restore drill | Encrypted nightly dump + written drill | `.github/workflows`, `docs/` |
| Patient portal | Already there (status page), now with privacy request and stop-SMS | Patient Portal |

## Not taken (too big for this project, or needs its own team)
Rust server and its own operating system; ABDM/FHIR/HL7/DICOM; eMAR and nursing charts; emergency and medico-legal; operation theatre; blood bank; radiology/PACS; payroll and HR; stores and procurement; native mobile apps; AI dictation; multi-hospital tenancy. If you outgrow RADIX AI, MedBrains itself may be worth evaluating as a whole system.
