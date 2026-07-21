# Engineer Route screen — LOCKED spec (approved)

Merges the old **My Day** (Story-Mode guided wizard) and **My Jobs** (list +
map) into one screen. Preview: `route-screen-preview.html`.

## Auto-selects its layout from today's job count
- **One job today → single-site focus** (a multi-day project, or one big
  call-out).
- **Several jobs today → the reactive call-out list** (up-next + timeline + map).
- No engineer-facing toggle. If a call-out lands on a one-job day it becomes two
  jobs and Route flips to the list.

## Shared, both layouts
- **Start of day**: the **weekly van check is enforced before clock-on** (14-item
  walkaround + "safe & roadworthy" + defects note + start mileage/odometer;
  due by the configured deadline). Clock-on captures **GPS + start mileage**.
- **End of day**: clock-off captures **end mileage + fuel**, then a **day
  summary** (hours on shift, jobs done / "project day", miles).
- **No SLA information anywhere** (no countdown, target or P-number).
- Tapping any job opens the approved **Job screen**.
- Cross-job guard: can't start the next job until the current one is at a valid
  end point (see job-screen spec).

## Reactive layout (several jobs)
- **Up-next hero**: the next job, Navigate + "On my way".
- **"Then" timeline**: the rest of today's jobs (tap → Job screen); done jobs
  struck through.
- **Today's map** ("heat map"): status-coloured pins + legend (postcodes
  geocoded, from the old My Jobs map).
- **Job history**: week navigation + load older (from My Jobs).

## Single-site focus layout (one job)
- **"You're on" hero**: project/site name, **"Day X of ~Y" progress bar** for a
  multi-day project (omitted for a one-day single job), Directions + Documents.
- **Today's tasks**: office-set task list the engineer ticks off.
- **"Log today's work"**: opens the day log — a **risk assessment on arrival
  each day** (site conditions change daily), then **hours + photos + notes**
  logged against the project. Project stays open across days; **completed /
  signed off at the end** (customer signature on the final day, like a job).
- Single site pin map.

## Carried-over features (must survive)
Van check (walkaround + photo slots + defects), clock on/off with GPS,
start/end mileage + fuel, up-next, today's timeline, status-coloured jobs map,
week job history, directions + call, Story-Mode day flow, day summary. Project
side adds: day counter, project documents, office-set tasks, daily log.
