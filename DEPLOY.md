# Deploying Mostlane Portal

Plain‑English reference for how updates reach Cloudflare — and how the API worker
keeps its bindings, variables and secrets without ever reverting to a "static"
worker. **If the worker ever loses its code editor / bindings again, read the
"Health check" and "If it goes wrong" sections at the bottom.**

There are three things that deploy, in three different ways.

## 1. Portal pages (mostlane-portal.com) — automatic
The website pages (all the `.html` at the repo root) are served by **GitHub
Pages** from the `Mostlane/Test` repo. Every push to the `main` branch rebuilds
and publishes them automatically (the "pages build and deployment" GitHub Action).
Nothing to paste. `.nojekyll` in the repo root must stay — it stops GitHub
running a Jekyll build that could crash and freeze the site.

## 2. The API worker (mostlane-api) — automatic, from GitHub
This is the important one, because it used to be a manual paste and once broke.

**How it works now:** Cloudflare **Workers Builds** is connected to the
`Mostlane/Test` GitHub repo, with **Root directory = `worker`**. Every push to
`main` makes Cloudflare rebuild and redeploy the worker from `worker/src/`. No
pasting.

**Why bindings & variables never get lost:** the file **`worker/wrangler.toml`**
(in the repo) lists everything the worker needs:
- D1 databases: `DB` (mostlane) and `PO_DB` (mostlane-po)
- R2 storage: `JOB_FILES` and `ASSET_BUCKET`
- the hourly cron trigger
- all non‑secret settings (EMAIL_FROM, VAPID_PUBLIC, R2_PUBLIC_BASE, etc.)

Because that list is in the repo, **every deploy re‑applies it automatically**.
That's the safety net: even if something wobbles, the next push puts the bindings
and variables back.

**Why secrets survive:** secrets are **NOT** in the repo — they live only in the
Cloudflare dashboard (Settings → Variables and Secrets) and **persist across
deploys**. You set them once. Normal deploys don't touch them. The current
secrets are: `RESEND_API_KEY`, `MASTER_PASSWORD`, `PORTAL_BRIDGE_SECRET`,
`SITELOG_ADMIN_SECRET`, `HS_PLAN_TOKEN`, `VAPID_PRIVATE`, `JOBS_INBOUND_TOKEN`.

**What keeps it from going "static‑assets‑only"** (the failure where the code
editor vanishes and bindings won't save): two settings must stay correct —
- in `worker/wrangler.toml`: `main = "src/index.js"` (this makes it a *code*
  worker, not a static‑assets one — never add an `[assets]`/`[site]` block), and
- in the Workers Builds settings: **Root directory = `worker`** (never the repo
  root).

Leave those two alone and it stays a normal worker.

## 3. The SiteLog worker (api.site-log.co.uk) — manual paste
The SiteLog worker (`Mostlane/SiteLog` → `worker.js`) is **still deployed by
pasting** into its Cloudflare worker. Its code is committed to `Mostlane/SiteLog`
`main` as the source of truth, but Jamie pastes it to go live. Note:
`PORTAL_BRIDGE_SECRET` must be the **same value** on this worker and on
mostlane-api.

---

## Normal workflow
1. Edit `worker/src/…` and/or the root `.html` pages.
2. Rebuild the committed bundle (kept in sync as a fallback):
   `cd worker && npx esbuild src/index.js --bundle --format=esm --outfile=dist/worker.js`
   (and `--minify` → `dist/worker.min.js`).
3. Commit, `merge --no-ff` into `main`, push. Workers Builds redeploys the API
   and GitHub Pages republishes the site within a few minutes.

## Health check (30 seconds — do this if anything feels off)
1. Open **mostlane-api** in Cloudflare — the **Edit code** button should be
   there. *If it's gone, the worker has reverted to static — that's the alarm.*
2. **Settings → Bindings:** DB, PO_DB, JOB_FILES, ASSET_BUCKET all listed.
3. **Settings → Variables and Secrets:** the vars + all 7 secrets present.
4. **Deployments:** the newest one says it came from a **GitHub commit**
   (Workers Builds), matching your last push.

## If it goes wrong (recovery)
The worker went static once (from a build with the wrong root directory). To
recover: redeploy with the correct `worker/wrangler.toml` and **Root directory =
`worker`** — that restores the bindings and variables. Then re‑add any **secrets**
that dropped (secrets don't survive that kind of reset; the list is above). Once
the two settings are right, it stays a normal code worker.
