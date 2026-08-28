# Acceptance — Utility Research Runner (v1)

This document is the reproducible acceptance contract for the production
research pipeline (TASK-008 / issue #16). It defines how to verify, deterministically
and live, that the runner is a trustworthy local v1 tool.

Scope: hardening and verification only. No new scoring formulas, no new features,
no UI/server/LLM. A mandatory requirement is a **real Google + Keyword Surfer
browser run** (see §9); everything else is deterministic or fixture-driven.

## 1. Prerequisites (Research Chrome over CDP)

The runner connects to a running Chrome via the Chrome DevTools Protocol (CDP).
It does **not** use or modify the operator's normal Chrome profile.

1. Prepare the isolated, space-free profile once:

   ```
   npm run chrome:setup
   ```

2. Start Research Chrome. The command waits until CDP is reachable:

   ```
   npm run chrome:start
   ```

3. After the first setup, verify **Keyword Surfer** once in
   `chrome://extensions`; Chrome may disable extensions in a copied profile.

4. Export the CDP endpoint only when overriding the default:

   ```
   set CDP_URL=http://127.0.0.1:9333
   ```

If `CDP_URL` is wrong/unreachable, the run fails **before keyword collection**
with `BROWSER_CONNECTION_ERROR` and exit code **3** (never a false success).

## 2. Safe environment setup (no real secrets in files)

Copy the template and fill only what you need. `.env` is git-ignored; never
commit it and never paste a real key into chat or PRs.

```
copy .env.example .env
```

`.env` (placeholders only — do not commit real values):

```
CDP_URL=http://127.0.0.1:9333
RESEARCH_MARKET=US
GOOGLE_HL=en
GOOGLE_GL=us
TOP_N=10
SURFER_WAIT_MS=60000

# Optional. When unset, the entire DR phase is skipped honestly and observed
# domains are kept as source 'none' / status 'not_attempted'.
AHREFS_API_KEY=
AHREFS_ENDPOINT=https://api.ahrefs.com/v3/public/domain-rating-free
```

Set the key only in your own shell session (preferred) or in the git-ignored
`.env`:

```
# PowerShell session only — the key is never written to a committed file:
$env:AHREFS_API_KEY="your-real-key"
```

To run without a key (DR skipped), simply leave it unset.

## 3. Commands

| Purpose | Command |
| --- | --- |
| Fresh research from seeds | `npm run research -- --seeds input/seeds.csv` |
| Force re-collect everything | `... --force-refresh` |
| Re-collect one keyword | `... --refresh-keyword "json diff"` |
| Microsoft CSV import | `npm run research -- --microsoft input/ms.csv` |
| Surfer depth-1 expansion | `... --seeds input/seeds.csv --expand` |
| Resume a paused/interrupted run | `npm run research -- --resume <run-id>` |
| Machine-readable final status | `... --json-status` |

`--seeds`/`--microsoft`/`--resume` are mutually exclusive; `--refresh-keyword`
must name a real run keyword.

## 4. Expected exit codes and run states

| Code | Meaning |
| --- | --- |
| `0` | completed (incl. `completed_with_errors`) |
| `1` | unexpected internal failure |
| `2` | invalid input / configuration |
| `3` | preflight / infrastructure failure (CDP, Google, Surfer, unwritable dir, bad cache) |
| `130` | gracefully paused (Ctrl+C) |

Run states: `running`, `paused`, `completed`, `completed_with_errors`. A terminal
run (`completed` / `completed_with_errors`) is immutable; `--resume` refuses it.

## 5. Expected artifacts

New work is stored under
`<RESEARCH_OUTPUT_ROOT>/<date>-<label>/discovery`; enrichments use sibling
`enrichment`, `enrichment-02`, and later directories. UUIDs stay inside
SQLite/manifest and remain valid resume identifiers. The research directory also
contains `debug/` and an atomically refreshed `results.zip`.

Discovery publishes `manifest.json`, `keywords.json`, `serp.json`,
`keywords.csv`, `related-keywords.csv`, `serp.csv`, `domains.csv`,
`candidates.csv`, `report.md`, and `status.json`. `manifest.json` is the
final publication marker; a `status.json` is never left without its matching
`manifest.json`. Legacy `runs/<uuid>` directories remain resumable but are not
created for new work.

## 6. Pause / resume (Ctrl+C)

- First **Ctrl+C**: the active keyword finishes its checkpoint, the run is set to
  `paused`, the process exits `130`, and the exact resume command is printed.
- Second **Ctrl+C**: force-quit (as documented).
- Resume: `npm run research -- --resume <run-id>`. Completed keywords are **not**
  re-collected; a stale `running` keyword is reset and safely recollected;
  expansion stays depth-one and does not duplicate candidates.

## 7. CAPTCHA handling (never automated)

The runner never solves or bypasses CAPTCHA.

Solve the CAPTCHA in the Research Chrome window. The runner polls that page
directly and continues automatically after the challenge disappears; no Enter
press, marker file, or separate terminal action is required. Ctrl+C leaves the
active keyword resumable. An unresolved CAPTCHA times out after 10 minutes with
`CAPTCHA_REQUIRED`.

## 8. Geo mismatch visibility

Keep three fields separate: Surfer `market`, Google `hl`/`gl`, and the detected
physical Google location. `gl=us` **does not** prove a truly US-localized SERP.

A mismatch is surfaced consistently in: keyword checkpoint/JSON, `keywords.csv`
(`geo_warning` + `detected_google_location`), `report.md`, the CLI warning, and
the manifest/status rollups. An unknown/unavailable detected location stays
distinguishable from a confirmed match.

## 9. Live end-to-end acceptance (mandatory)

Use a small batch (4–6 canonical keywords) to avoid unnecessary traffic:

```
npm run research -- --seeds input/seeds.csv   # real Google + Keyword Surfer
# ... interrupt with Ctrl+C, then:
npm run research -- --resume <run-id>          # no repeated completed work
npm run research -- --seeds input/seeds.csv    # warm run: cache hits, zero lookups
```

Minimum evidence (recorded in the PR body, not committed as run dirs):

1. one real fresh browser run;
2. ≥1 keyword with visible Surfer volume/CPC and organic rows;
3. geo state recorded honestly;
4. interrupt → resume without repeating completed keywords;
5. identical warm run demonstrating cache behavior;
6. `candidates.csv`, `report.md`, `status.json`, and manifest consistent with
   the run DB;
7. `--json-status` points to real outputs.

Known environment limitation: in a copied/free Surfer profile the
`keyword-surfer-sidebar` related-keywords widget often does **not** render. That
produces a structured `related` error and is acceptable **only when** the main
Surfer volume/CPC and organic pipeline remain valid and the error + debug
evidence are retained. A blocked optional live Ahrefs call must not be disguised
as success.

## 10. Distinguishing a product defect from an environment limitation

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `related` status `error`, main volume/CPC/organic present | Copied-profile Surfer widget not rendering (env) | Expected; keep error + debug, do not claim expansion success |
| Main Surfer volume/CPC missing or organic parse empty with debug `parser-context.json` | Product/parser defect | Inspect `debug/<run-id>/page.html`, `page.png`, `parser-context.json`; file a defect |
| `gl=us` but detected location differs | Geo mismatch, not a defect | Verify `geo_warning` surfaces everywhere |
| `BROWSER_CONNECTION_ERROR` / `SURFER_NOT_DETECTED` / `GOOGLE_UNAVAILABLE` | Preflight/infra (exit 3) | Fix environment; not a false success |

Debug artifacts live under `debug/<run-id>/` and contain: `page.html`,
`page.png`, `parser-context.json` (keyword, parser/error code, selector/version,
page URL — no secrets).

## 11. Acceptance result matrix

Legend: `PASS` (verified), `FAIL` (defect), `BLOCKED_BY_ENVIRONMENT` (unaffected
contract verified, limitation documented). v1 is **not** accepted while any
mandatory row is `FAIL`.

| # | Check | Result | Verified by |
| --- | --- | --- | --- |
| 1 | Preflight failures early, classified, actionable, non-terminal | PASS | `src/cli/research.test.ts` (cache DB unreadable → exit 3; preflight failure → exit 3), `src/browser/preflight.ts` |
| 2 | Invalid inputs/CLI exit with documented code (2) | PASS | `src/cli/research.input.test.ts`, `src/cli/research.test.ts` |
| 3 | CAPTCHA/manual pause and Ctrl+C/resume contracts | PASS | `src/browser/captcha.test.ts` (page polling, navigation race, timeout and cancellation), `src/browser/collect.captcha.test.ts` (real collect wiring), `src/cli/research.captcha.test.ts`, `src/cli/research.test.ts` (SIGINT → 130, resume) |
| 4 | Geo mismatch visible, no false localization | PASS | `src/cli/research.geo.test.ts` (keywords.csv `detected_google_location` + `geo_warning`, keywords.json geo fields, report.md, CLI `GEO WARNING` log naming the detected location) |
| 5 | Parser failures retain debug evidence; breakers trip | PASS | `src/diagnostics/artifacts.test.ts`, `src/runs/policies.test.ts`, `src/runs/engine.test.ts` |
| 6 | Ahrefs isolated, cached, traceable, secret-safe | PASS | `src/cli/research.secretLeak.test.ts`, `src/runs/engine.dr.test.ts` |
| 7 | Cold/warm/refresh/identity cache consistent | PASS | `src/runs/engine.cache.test.ts`, `src/runs/engine.test.ts` |
| 8 | Interrupted work resumes without repeats | PASS | `src/cli/research.test.ts` (SIGINT resume), `src/runs/engine.test.ts` |
| 9 | Terminal historical runs immutable | PASS | `src/runs/engine.test.ts` (RESUME_TERMINAL_RUN), `src/cli/research.test.ts` (resume completed → exit 2) |
| 10 | Output atomic, manifest-last, never falsely terminal | PASS | `src/runs/aggregation.regression.test.ts` (Contracts 7/14/15) |
| 11 | CSV/JSON/Markdown agree with run DB | PASS | `src/runs/aggregation.regression.test.ts`, `src/runs/csv.snapshot.test.ts` |
| 12 | `--json-status` stable and machine-readable | PASS | `src/cli/research.jsonstatus.test.ts` (completed / completed_with_errors / paused; JSON asserted as the single, final stdout line with no other JSON/ANSI noise) |
| 13 | Representative real Google + Surfer e2e | PASS | live run against Research Chrome (CDP `http://127.0.0.1:9333`): cold `force-refresh` collected real Surfer volume/CPC + organic rows; `Ctrl+C` mid-collection exited `130` with the active keyword left resumable (`status.json` `"status":"paused"`); on the SAME run id `--resume` skipped the already-`completed` keyword (not re-collected, no keyword-cache re-fetch — volume unchanged) and performed exactly `2` browser lookups for the two pending keywords only; warm run was `100%` cache hits / `0` browser lookups. See §12.1 for the single-run-id evidence |
| 14 | Docs reproducible, evidence + limitations honest | PASS | `ACCEPTANCE.md`, README acceptance note, `IMPLEMENTATION_PLAN.md` |
| 15 | Typecheck + test suite green | PASS | CI runs `npm run typecheck` and the complete `npm test` suite; exact test counts are intentionally not pinned here because the suite grows |

## 12. PR #17 live E2E evidence (issue #16 §9)

Run live against Research Chrome over CDP (`http://127.0.0.1:9333`, copied
space-free profile `C:\tmp\research-profile`, Keyword Surfer injected). Expansion
was disabled (`EXPANSION_ENABLED=false`); Ahrefs DR skipped (no key). Google was
reachable and served real SERPs.

### 12.1 Cold run → Ctrl+C → resume on ONE run id (no repeated work)

Single live scenario, **same run id throughout**:
`20260822082607391_f646df8b-b61f-4b01-aa4c-2eae6d187779`
(Keywords `compare lists`, `json diff`, `merge lists`; cold via `--force-refresh`.
Preflight passed: `Research Chrome connected`, `Google reachable`,
`Keyword Surfer injection detected`.)

- **Phase A (cold):** `compare lists` collected for real — volume **49,500**,
  cpc **$7.90**, organic **9**. `Ctrl+C` during collection →
  `Run paused: SIGINT received; run paused safely.`, process exited **130**.
- **Keyword states BEFORE `--resume`** (read from the run store, same id):
  - `compare lists` → `completed`, volume **49,500**
  - `json diff` → `pending`
  - `merge lists` → `pending`
  - run state → `paused`
- **Phase B (`--resume 20260822082607391_f646df8b-b61f-4b01-aa4c-2eae6d187779`):**
  the resume collection loop begins at **`[1/3] json diff`** then **`[2/3] merge lists`**.
  `compare lists` **never appears as a collection step** — it was already `completed`
  in the run store, so the engine skipped it (it is not re-run and is not
  re-fetched from the keyword cache); its volume stayed **49,500** unchanged.
  - `json diff` → collected, volume **8,100**, cpc **$10.55**
  - `merge lists` → collected, volume **140**, cpc **$3.72**
  - resume-session browser lookups = **2** (json diff, merge lists only); the run's
    lifetime total is **3** because `compare lists` was collected once in Phase A and
    **not** again on resume.
- **Keyword states AFTER `--resume`:** all three `completed`, `errors: 0`.

This proves the completed keyword was **skipped on resume, not re-collected** (no
new browser lookup, no cache-hit re-fetch); only the pending keywords were collected.

### 12.2 Warm run (cache behavior)

Fresh `--seeds` on the same keywords (`20260822081618363_f6572fa7-f2b4-4a55-9568-fa5ca15dcaec`):

- `Cache 100% (3 hit / 0 miss / 0 expired / 0 refreshed)`, `Browser lookups 0`.
- `status.json` cache: `hits: 3, hitRatePercent: 100`.

### 12.3 Geo honesty

Every keyword recorded `geo_warning: true` with
`detected_google_location: "Chelyabinsk Oblast, Russia"` against the configured
`gl=us`/`market: US`. The mismatch is surfaced in `keywords.csv`, `keywords.json`,
`report.md`, the CLI `GEO WARNING` log, and the manifest/status rollups — no false
US-localization claimed.

### 12.4 Known environment limitation (honest)

In this copied/free Surfer profile the `keyword-surfer-sidebar` related-keywords
widget did not render; expansion was run with `--expand` off, so `relatedKeywords`
is `0`. That is the documented §9/§10 limitation, not a product defect: the main
Surfer volume/CPC + organic pipeline remained valid and `errors: 0`. No CAPTCHA was
encountered, so the manual CAPTCHA path was not exercised live (covered by
`src/cli/research.captcha.test.ts` and `src/browser/captcha.test.ts`).

### 12.5 Commands used

```
set CDP_URL=http://127.0.0.1:9333
npm run research -- --seeds input/seeds.csv --force-refresh   # cold, real browser
# ... Ctrl+C during collection → exit 130, run paused ...
npm run research -- --resume <run-id>                         # no repeated completed work
npm run research -- --seeds input/seeds.csv                   # warm: 100% cache hits, 0 lookups
```

