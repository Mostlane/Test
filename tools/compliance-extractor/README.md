# TSC Compliance → R2 extractor (Phase B)

Streams The Southern Co-op compliance certificates out of the **"TSC Compliance"**
SharePoint tree and into the portal's `POST /compliance/file`, which stores each
file in R2 and indexes it in D1 (keyed by store **code** + compliance **type**).
Once files are in, the compliance table (`eicr-portal.html`) shows a 📄 link on
every date cell that has a certificate on file.

This runs **outside** the normal Claude session because the Microsoft 365
connector can't bulk-transfer (1 MB/file cap + rate limits). It needs an Azure
**app registration** with Graph application permission `Sites.Read.All` (or
`Files.Read.All`), admin-consented.

## Why it's careful

The tree is *mostly* `group / <code> name / TYPE / files` but has real variance
(all handled — see `--selftest`):

| Shape seen in the tree | How it's keyed |
|---|---|
| `COBRA / 9667 Plymouth / 5 Year / 9683~EICR~17-12-21.pdf` | code `9667` (folder), type `fiveYear`, date `2021-12-17`. The filename's own code `9683` disagrees → logged to `mismatches.csv`, folder wins by default. |
| `Retail / 9688 … / PAT / cert.pdf` | code `9688`, type `pat`. |
| `EV Maintenance / East Devon crematorium- 2026-04-24… / cert.pdf` | **no code in the folder** → **quarantined** to `unmatched.csv` (type `ev`, date parsed), *not* imported under a guessed code. |
| `Crematorium & Burial Grounds / 4000 … / 5 Year / EICR 2023.pdf` | code `4000`, type `fiveYear`, year `2023`. |
| `Lakeside Head Office / Data Schedules / notes.docx` | no code, unknown type → `unmatched.csv`. |

Rules: type = the **deepest** folder that names a known type, else inferred from
the filename; code = the **first coded folder** (or the filename, with
`--code-source=filename`); anything without a confident code is **quarantined,
never guessed**.

## Setup

1. Azure Portal → App registrations → New. Add an application permission
   `Sites.Read.All` under Microsoft Graph, **Grant admin consent**, create a
   client secret.
2. On the **worker**, set the secret `COMPLIANCE_IMPORT_TOKEN` (dashboard →
   mostlane-api → Settings → Variables → *Encrypt*), any long random string,
   then **Deploy**.
3. `cp .env.example .env` here and fill it in (`.env` is git-ignored).

## Run — review first, then commit

```bash
node extract.mjs --selftest      # offline: prove the classifier (no creds needed)

node extract.mjs                 # DRY RUN: walk + classify, write out/*.csv, download NOTHING
#   → inspect out/unmatched.csv and out/mismatches.csv

node extract.mjs --commit        # download each file + POST to the portal (idempotent — re-runnable)
```

Re-running `--commit` is safe: the server de-dupes on the SharePoint item id
(`source`), and the script checks `/compliance/has` before downloading, so an
interrupted run resumes without re-uploading.

### Flags

| Flag | Meaning |
|---|---|
| `--commit` | Actually download + upload (default is dry-run). |
| `--code-source=folder\|filename` | Who wins a code clash (default `folder`). |
| `--names=names.json` | `{ "store name substring": "9683", … }` to rescue **code-less** folders by name. Build it from the review of `unmatched.csv`. |
| `--only=CODE` | Only process files that resolve to this store code (smoke test). |
| `--limit=N` | Stop after N files. |
| `--max-mb=95` | Skip + report files bigger than this (Worker request-body limit). |

### Reports (written to `out/`)

- `imported.csv` — everything imported (or, in dry-run, everything that *would* be).
- `unmatched.csv` — **no confident store code** → needs a `--names` entry or a folder rename.
- `mismatches.csv` — folder code ≠ filename code (imported under the folder code; review if any look wrong).
- `skipped.csv` — system files / oversize.
- `errors.csv` — download/upload failures (re-run `--commit` to retry).

## Suggested workflow

1. `--selftest`, then a plain **dry run**.
2. Open `unmatched.csv` — for the code-less crematorium/funeral folders, add a
   `names.json` mapping store-name → code and re-dry-run with `--names`.
3. Skim `mismatches.csv` — decide if `--code-source=filename` fits your data
   better (it didn't for the one sample we saw; folder is the safe default).
4. `--commit`. Watch the counters; re-run to mop up any `errors.csv`.
5. Load the compliance table — 📄 links appear on stores that now have certs.
