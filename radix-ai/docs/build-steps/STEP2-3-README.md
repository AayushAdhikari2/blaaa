# Steps 2 and 3: queue board, realtime, token fix, print slip

Only NEW files are in this zip. Needs step 1 (`schema_v11.sql`) already applied.

## Files
| File | What |
|---|---|
| `app/schema_v12_queue.sql` | realtime on `visits` + `call_next()` |
| `app/schema_v13_token.sql` | token counter, unique token index, `register_visit` (v11 version + the token fix) |
| `app/app-queue.js` | doctor queue board, reception live queue, realtime |
| `app/app-slip.js` | print-ready slip window with QR |

## Add to the project
1. In Supabase SQL Editor run, in this order: `schema_v12_queue.sql`, then `schema_v13_token.sql`. Both are safe to re-run.
2. Copy the two `.js` files into `app/`.
3. In `app/index.html` the script lines at the bottom should read, in this order:
```
<script src="app-modules.js"></script>
<script src="app-patients.js"></script>   <!-- step 1 -->
<script src="app-queue.js"></script>      <!-- step 2 -->
<script src="app-slip.js"></script>       <!-- step 3 -->
<script src="app-start.js"></script>
```
`app.js` and the other files are untouched. (If you skip step 1's file, these two still work; keep v11's SQL either way.)

## Step 2: what you get
**Doctor**
- Board: **Now seeing**, **Next up** (first 3), **Waiting**, **Back from lab**, **At lab**, each with a count and a "No patients waiting" style empty state.
- **Call next** button (or press `N`): calls the oldest patient (waiting or back from lab) in one safe step, so two clicks or two screens can never call the same patient. `R` refreshes. Keys are ignored while typing.
- Each card shows token, age, reason, allergy tag, last visit with you, minutes waiting, and a "Call in" button for out-of-order calls.
- When a report comes back: a sound, a vibration on phones, a highlighted card, a message and a flashing tab title. "Sound on/off" button (remembered on the device). Browsers allow sound only after the first click or tap on the page.
- The consultation panel (order a test, prescribe) is unchanged, under "Now seeing".

**Reception**
- The "Today's visits" card is now a live queue next to the registration form, with **doctor** and **status** filters, wait times, status badges (text + colour), Paid/Unpaid, and a Slip button.

**Both**
- **Realtime**: changes appear within about a second. The label shows "● Live · updated 3 s ago", or "○ Refreshing every 5 s" if realtime is not connected. **Refresh** button for a manual refresh.
- A screen is redrawn only when its data changed, and the scroll position is kept, so the page no longer jumps. If someone is typing, the redraw waits until they leave the field.
- Tap targets in the new areas are at least 44 px.

## Step 3: what you get
- **Token fix**: each doctor has one counter per day, increased atomically. Tested with 8 sessions registering 10 patients each at the same moment: 80 visits, 80 different tokens (1 to 80). A unique index now blocks duplicates in the database too.
- **Slip window**: after "Register", a window opens with the big token, patient, doctor, bill no., access code, QR code, one **Print slip** button (focused, so Enter prints) and **Done**. Every "Slip" button in the lists opens the same window. The old inline box is hidden.

## Tested
- Database: your 113 existing checks pass with v11-v13 applied. Step 1's 40 checks pass. New: 14 checks for `call_next` (order, roles, back-from-lab first, empty queue, other doctor blocked) plus the parallel token test above.
- Browser (jsdom, 27 checks): board columns, call next (button and `N` key), no redraw when unchanged, report-back cue, realtime event redraw, reception filters and empty state, slip window, print, Done, Slip buttons. It also caught one bug in my first version (filter dropdowns did not respond), now fixed.
- Not tested on your live Supabase project or on a real phone/printer. Please run `TEST-CHECKLIST.md` and print one real slip on your 80 mm printer.

## Decisions to check
- **Order**: "Call next" uses the same order as the patient's own "you are Nth" number (arrival time, including patients back from lab). If you want lab-returners seen first, say so; the patient page would need the same change.
- **Old duplicate tokens**: if the old race already created two equal tokens on the same day, the unique index is skipped with a notice and everything else still works. The notice contains a query to find them.
- **Slip button**: "Print slip" prints through the existing hidden print area (the same 80 mm layout as before), so nothing changes on paper.

## Next: step 4 (notifications)
