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

1. Copy the real `Default` profile to a **space-free** path (Chrome refuses to open
   the DevTools port when `--user-data-dir` contains a space):

   ```
   robocopy "%LOCALAPPDATA%\Google\Chrome\User Data\Default" C:\tmp\research-profile\Default /E /XD Cache Code Cache Service Worker /XF *.log
   ```

2. Launch Chrome on the copy with the DevTools port open:

   ```
   start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
     --remote-debugging-port=9333 ^
     --user-data-dir=C:\tmp\research-profile ^
     --profile-directory=Default ^
     --remote-allow-origins=*
   ```

3. In `chrome://extensions`, enable/re-install **Keyword Surfer** (a copied
   profile is treated as non-standard and Chrome may disable extensions on first
   launch).

4. Export the CDP endpoint:

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

## 5. Expected artifacts (under `runs/<run-id>/`)

`manifest.json`, `keywords.json`, `serp.json`, `keywords.csv`,
`related-keywords.csv`, `serp.csv`, `domains.csv`, `candidates.csv`,
`report.md`, `status.json`. `manifest.json` is the final publication marker;
a `status.json` is never left without its matching `manifest.json`.

## 6. Pause / resume (Ctrl+C)

- First **Ctrl+C**: the active keyword finishes its checkpoint, the run is set to
  `paused`, the process exits `130`, and the exact resume command is printed.
- Second **Ctrl+C**: force-quit (as documented).
- Resume: `npm run research -- --resume <run-id>`. Completed keywords are **not**
  re-collected; a stale `running` keyword is reset and safely recollected;
  expansion stays depth-one and does not duplicate candidates.

## 7. CAPTCHA handling (never automated)

The runner never solves or bypasses CAPTCHA.

- **Interactive (TTY):** it waits for stdin. Solve the CAPTCHA in the Research
  Chrome window, then press Enter in the terminal.
- **Non-interactive (background):** it polls for the marker file
  `CAPTCHA_DONE_MARKER` (default `C:\tmp\captcha-done.txt`; override via env).
  After solving in the browser, create the file to let the run resume.

A required CAPTCHA pauses the run and preserves the active checkpoint; new
keywords are not scheduled until it is cleared.

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
| 3 | CAPTCHA/manual pause and Ctrl+C/resume contracts | PASS | `src/browser/captcha.test.ts` (detection + marker pause + first Ctrl+C interrupt), `src/browser/collect.captcha.test.ts` (real collect wiring waitForManualCaptcha → pauseForManualCaptcha), `src/cli/research.captcha.test.ts` (first Ctrl+C during marker-wait via runCli → paused/130), `src/cli/research.test.ts` (SIGINT → 130, resume) |
| 4 | Geo mismatch visible, no false localization | PASS | `src/cli/research.geo.test.ts` (keywords.csv `detected_google_location` + `geo_warning`, keywords.json geo fields, report.md, CLI `GEO WARNING` log naming the detected location) |
| 5 | Parser failures retain debug evidence; breakers trip | PASS | `src/diagnostics/artifacts.test.ts`, `src/runs/policies.test.ts`, `src/runs/engine.test.ts` |
| 6 | Ahrefs isolated, cached, traceable, secret-safe | PASS | `src/cli/research.secretLeak.test.ts`, `src/runs/engine.dr.test.ts` |
| 7 | Cold/warm/refresh/identity cache consistent | PASS | `src/runs/engine.cache.test.ts`, `src/runs/engine.test.ts` |
| 8 | Interrupted work resumes without repeats | PASS | `src/cli/research.test.ts` (SIGINT resume), `src/runs/engine.test.ts` |
| 9 | Terminal historical runs immutable | PASS | `src/runs/engine.test.ts` (RESUME_TERMINAL_RUN), `src/cli/research.test.ts` (resume completed → exit 2) |
| 10 | Output atomic, manifest-last, never falsely terminal | PASS | `src/runs/aggregation.regression.test.ts` (Contracts 7/14/15) |
| 11 | CSV/JSON/Markdown agree with run DB | PASS | `src/runs/aggregation.regression.test.ts`, `src/runs/csv.snapshot.test.ts` |
| 12 | `--json-status` stable and machine-readable | PASS | `src/cli/research.jsonstatus.test.ts` (completed / completed_with_errors / paused; JSON asserted as the single, final stdout line with no other JSON/ANSI noise) |
| 13 | Representative real Google + Surfer e2e | BLOCKED_BY_ENVIRONMENT | attempted automated run: CDP at 127.0.0.1:9222 and :9333 unreachable from the agent environment; the mandatory flow also needs interactive CAPTCHA solving, which a non-interactive agent cannot perform. Deterministic contracts above are verified; the live path is the operator's manual acceptance |
| 14 | Docs reproducible, evidence + limitations honest | PASS | `ACCEPTANCE.md`, README acceptance note, `IMPLEMENTATION_PLAN.md` |
| 15 | Typecheck + test suite green | PASS | `npx tsc --noEmit` clean; 296 pass / 0 fail / 1 skipped |
