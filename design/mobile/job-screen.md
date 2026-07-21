# Engineer Job screen — LOCKED spec (approved)

The "open a job → complete it" screen for the mobile engineer app. Approved from
the working preview; this is the source of truth for wiring the live
`job-view.html` + the `mostlane-api` worker. Preview: `job-screen-preview.html`
in this folder.

## Golden rules
- **No SLA information anywhere in the engineer's view** — no countdown, no
  target time, no P1–P4 priority number. A plain "Urgent" flag is allowed; the
  activity trail must not mention SLA.
- **Engineer-settable statuses = exactly these five, in order:**
  `Travelling · In Progress · Complete · On Hold · Quote`.
  Office-only statuses (Order, Invoiced, Closed) and custom office categories
  (e.g. "FRA Works") never appear in the engineer's status picker.
- **One universal "slide to finish" bar** is the commit action for every end
  point (Complete / On Hold / Quote). Label adapts ("Slide to complete job" /
  "Slide to send for approval" / "Slide to submit quote"). It stays locked
  until that outcome's criteria are met. Sliding is the gate before the next
  job. Travelling / In Progress show no slide.

## The risk assessment (RA) is an arrival gate, not a login gate
- **Travelling can be set WITHOUT the RA** — it's the "on my way" state, before
  the engineer has even seen the site. You can't assess a job you haven't
  reached.
- Everything else on the job is **locked until the RA is signed on site**:
  photos, notes, customer signature, and the In Progress / Complete / On Hold /
  Quote statuses. Tapping any of them opens the RA. The status grid stays
  visually available (Travelling must look tappable); photos/notes/signature dim.
- Signing the RA = the job goes **In Progress** and unlocks.

### RA contents (all required to start)
1. **Work-area photo** (required) — and it is **stored as the job's `Before`
   photo**, so it's never taken twice and it satisfies the completion
   photo requirement.
2. **Hazard controls** — each row is **In place / N/A** (both are positive
   answers); every row must be answered. If a needed control *isn't* in place,
   that's the cue to report (below).
3. **Site conditions / notes** (optional).
4. **Declarations** (all required):
   - "I am suitably trained & competent to carry out this task"
   - "Third parties & the public are safeguarded — barriers, segregation etc. in place"
   - "Safe to proceed"
5. **Engineer name + drawn signature** (both required — a name with no stroke,
   or a stroke with no name, is refused).

### RA escape — "can't proceed safely"
- If the engineer can't honestly complete the RA, they tap **"⚠ I can't proceed
  safely — tell the office"**, give a required reason (which declarations/
  controls failed are recorded), and:
  - the job goes to **"Awaiting office"** — a distinct safety state; the job has
    NOT started;
  - **all office/admins get an urgent alert** (push + Inbox);
  - the engineer **stays blocked on this job** (same hard-block as a pending
    On Hold — decided by the owner) until an admin resolves it (reassign /
    reschedule / "controls in place, retry the RA") — they retry the RA once
    it's sorted.

## Photos
- Each photo carries a **Before / During / After** stage label the engineer
  picks with a slider before adding.
- Upload by a stable filename so an offline retry can't duplicate.

## Completion criteria (server-enforced; admins can override)
- **Complete** = completion note (≥15 chars) + ≥1 photo + **customer signature**
  (name + drawn stroke). Applies to every engineer.
- **Quote** = the full quote pack (below) + ≥1 photo + **customer signature**.
- **On Hold** = reason + what's-needed-to-resume, then **admin approval**
  (engineer's hold is "pending"; admin approve/reject notifies the engineer;
  the engineer is hard-blocked from the next job until approved).
- **In Progress** = a signed RA (the arrival gate above).

### Quote pack — every field required (office prices from these)
1. Engineers required — stepper, **default 1**.
2. Estimated duration — hours, **default 1**.
3. Full list of materials required.
4. Time restrictions on when works can be done.
5. Access equipment required — pick any of: Small Step Ladder, Large Step
   Ladder, Ladder, Tower 5m Working Height, Scissor Lift (multi-select; a
   mutually-exclusive "None needed" is offered for ground-level work).
6. Barriers required to the affected areas — Yes / No.
7. Any disruption the client should know about first — Yes / No; **Yes reveals a
   required notes box**.

## Cross-job guard
- An engineer can't start their next job (set it Travelling / In Progress) until
  their current job is at a valid **end point**: Complete, Quote, or an
  **approved** On Hold. A **pending** On Hold and **Awaiting office** both block.
- Blocked → alert naming the offending job + jump straight into it showing what's
  missing.

## Carried-over features (must all survive the reskin)
Site details, **Site Documents** (`site-folder.html`), Directions (Google Maps),
call the site, **Raise PO for this job** (`#mlpo=` prefill), photos + lightbox,
customer signature, engineer-capture readback, activity timeline, office "Edit
details" modal (office only). Offline: Complete & Quote work fully offline
(queue + replay on reconnect); On Hold and the safety report need a bar of signal
to clear their block.

## Offline
- Complete / Quote captured on-device (payload + photos as blobs), optimistic
  local state so the guard works offline, replay via idempotent endpoints, a
  "waiting to sync" indicator.
