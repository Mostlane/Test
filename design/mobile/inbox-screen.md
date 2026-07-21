# Inbox screen — LOCKED spec (approved)

One place for everything that today is scattered across the blocking attention
overlay + tile/sidebar badges. Preview: `inbox-screen-preview.html`.

## Contents
Aggregates the existing 9 attention types (asset request / reply / transfer /
confirm, holiday decision, H&S permit, van-check due / missing) PLUS the new:
- **Job assigned** — informational only. Engineers do NOT accept jobs: if it's
  sent, it's theirs. Row shows "New job — added to your route" + **View job ›**.
  No accept/decline anywhere.
- **On-hold approval** (office/admin) — Approve / Reject.
- **Safety flag** "can't proceed safely" (office/admin) — Call engineer /
  Reassign-reschedule (from GET /sla/safety/open + /sla/holds/pending).
- **Messages** (office ↔ engineer) — tap opens a thread you can reply in
  (/messages backend).

## Behaviour
- **Filters:** All / Jobs / Messages / Admin, each with an unread count.
- **Role split:** engineers see jobs, messages, sign-offs, van-check & transfer
  reminders. Office/admins additionally see on-hold approvals + safety flags.
- **Mark all read** clears unread dots. Snooze/seen state syncs across devices
  via /prefs (unchanged). Web push still fires per event.
- No SLA information shown.
