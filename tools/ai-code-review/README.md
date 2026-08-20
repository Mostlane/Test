# AI code review

Automatically reviews the portal's code for **bugs and inefficiencies** with Claude
and opens a GitHub issue when it finds something. This is the *code-level* watchdog;
the *live-runtime* watchdog (broken / slow endpoints) is the worker's `health.js`
module and the **Health** page (`health.html`) in the portal.

## When it runs

- **Nightly** at 02:00 UTC — reviews everything changed in the last day.
- **On every push to `main`** — reviews that push's diff.
- **On demand** — Actions tab → *AI code review* → **Run workflow** (choose `recent`
  or `full`; a manual run always opens an issue, even when clean, so you can test it).

## One-time setup (do this once)

1. Go to the repo on GitHub → **Settings → Secrets and variables → Actions**.
2. **New repository secret**:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key (the same key the worker uses for its AI features).
3. That's it. The next nightly run (or a manual **Run workflow**) will review the code.

Without the secret the job **skips cleanly** — it never fails a build or blocks a deploy.

## Optional: use a cheaper model

Reviews default to `claude-opus-5` (the strongest reviewer). To spend less, add a repo
**variable** (Settings → Secrets and variables → Actions → *Variables* tab):

- Name: `ANTHROPIC_MODEL`
- Value: `claude-sonnet-5`

Rough cost: a nightly run over a normal day's changes is on the order of pennies to
~£1 on Opus, less on Sonnet. It only reads changed files (capped at 30 files /
~260 KB), so it stays cheap even on busy days.

## What you get

An issue titled e.g. `🤖 AI review — 1 high · 2 medium · 0 low — 2026-08-19`, listing
each finding with the file, what's wrong, when it bites, and the suggested fix. Close
issues as you deal with them. Every run also writes a summary into the Actions run page,
so you can see it ran even when nothing was found.

**Findings are AI-generated — verify each one before acting.** False positives happen.

## Auto-fix (cautious, no merge button)

`autofix.mjs` + `.github/workflows/ai-auto-fix.yml` go one step further: once a night
(02:30 UTC, or on demand) it asks Claude for fixes to the **worker code** changed that
day, **applies the safe ones itself, and ships them** — no merge to press.

It is deliberately cautious:

- **Worker logic only** (`worker/src/**`). It never edits your HTML pages.
- **Never touches** login, permissions, sessions, core routing, or config
  (`index.js`, `auth.js`, `devices.js`, `users.js`, `push.js`, `health.js`,
  `wrangler.toml`, `*.sql`). Problems there come to you as a review issue instead.
- **Only high-confidence, small fixes** are applied, as exact one-spot replacements.
- **Hard safety gate:** every change is syntax-checked and the worker bundle is rebuilt
  before anything ships. If it doesn't validate, the whole batch is thrown away and an
  issue is opened instead.
- **You always know, and can undo:** each shipped fix opens a `✅ Auto-fixed…` issue
  with the exact `git revert <sha>` command, and sends you a phone alert.

### Optional: the phone alert

The alert uses the worker's `POST /health/notify`, which is gated by your existing
`JOBS_INBOUND_TOKEN`. To turn the phone ping on, add that token as a **GitHub secret**
too (Settings → Secrets and variables → Actions), name `JOBS_INBOUND_TOKEN`, same value
as in the worker. Without it, the ping is skipped and the `✅ Auto-fixed…` issue is still
the record.

To make it bolder or more careful later, edit the `inScope` / `PROTECTED` lists and the
confidence gate in `autofix.mjs`.
