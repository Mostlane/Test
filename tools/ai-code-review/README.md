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
