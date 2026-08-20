# AGENTS.md

## Mission

Implement and maintain `utility-research-runner` as a reliable local research CLI.

The purpose is to eliminate repetitive SEO research work, not to build a generic SEO platform.

## Source of truth

Read in order:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `PIPELINE.md`
4. `README.md`
5. `IMPLEMENTATION_PLAN.md`

## Critical fact

The Keyword Surfer + Google integration has already been proven.

Observed spike result:

```text
query: compare lists
Surfer volume: 49,500
Surfer CPC: 7.90
organic candidates: 9
```

Do not replace the working mechanism with a speculative alternative without a demonstrated reason.

The spike also showed that Keyword Surfer related-keyword data is present in the page and can be parsed.

## Mandatory constraints

Do:

- strict TypeScript;
- preserve working spike behavior;
- centralize browser selectors/parser logic;
- build persistent cache;
- build resume/checkpoints;
- show live progress;
- retain debug evidence on parser failures;
- use official Ahrefs API access;
- preserve source provenance;
- make output agent-readable.

Do not:

- add React;
- add Next.js;
- add a dashboard;
- add Express just to expose local functions;
- add a remote database;
- add Redis/queues;
- scrape Ahrefs UI;
- scrape Similarweb UI;
- automate CAPTCHA solving;
- add stealth/anti-detection frameworks;
- add proxy rotation for evasion;
- add LLM calls;
- add AI scoring;
- recursively expand Surfer keywords without a hard depth limit;
- turn DR thresholds into absolute SEO truth;
- auto-sum synonym keyword volumes.

## Browser behavior

Use the dedicated research Chrome profile.

Do not use or modify the user's normal Chrome profile.

If CAPTCHA appears, pause and request manual intervention.

## Geographic accuracy

Treat:

```text
Surfer market
Google gl/hl
detected Google location
```

as separate fields.

Do not claim a SERP is truly US-localized solely because `gl=us`.

## Progress is required

The operator must always know:

- current stage;
- current item;
- completed/total;
- errors;
- cache hit rate where relevant;
- approximate ETA where meaningful.

## Reliability is required

A 200-keyword run must survive:

- individual keyword failures;
- individual domain failures;
- temporary API errors;
- Ctrl+C;
- restart/resume.

If parser health collapses, pause rather than silently generate junk.

## Scope discipline

If a new abstraction or dependency is not required by these docs, justify it before introducing it.

Prefer explicit code over a premature generic "provider/plugin framework".

## Completion rule

Do not declare v1 complete until the end-to-end acceptance in `IMPLEMENTATION_PLAN.md` passes.

---

## Implementation plan and acceptance

The phase descriptions below define capability requirements. `IMPLEMENTATION_PLAN.md` defines the current PR delivery order and takes precedence when sequencing differs.

The browser integration spike is already successful.

Do not repeat the original spike as a separate project.

Reuse/refactor its proven code into the production runner.

## Phase 1 — Foundation

Deliver:

- strict TypeScript project;
- config;
- CLI shell;
- dedicated Research Chrome connection;
- preflight;
- proven Surfer parser;
- proven Google organic parser;
- debug artifact support.

Acceptance:

```text
npm run research -- --seeds input/seeds.csv
```

can process a small batch and persist raw keyword/SERP results.

## Phase 2 — Durable run engine

Deliver:

- run manifest;
- progress state;
- persistent checkpoints;
- resume;
- graceful shutdown;
- retry/backoff;
- circuit breaker;
- error classification;
- CLI progress/ETA.

Acceptance:

Interrupt a multi-keyword run, restart it, and confirm completed work is not repeated.

## Phase 3 — Cache

Deliver:

- keyword research cache;
- related keyword cache;
- DR cache;
- TTL;
- cache hit/miss reporting;
- force refresh.

Acceptance:

Run the same input twice and verify second run avoids unnecessary browser/API work.

## Phase 4 — Ahrefs DR

Deliver:

- official free DR API integration;
- normalized registrable domains;
- global domain dedupe;
- domain progress;
- rate-limit/error handling.

Acceptance:

Repeated domains across keywords trigger one fresh DR lookup per TTL window.

## Phase 5 — Microsoft import

Deliver:

- adapter for real Microsoft Keyword Planner CSV;
- schema validation;
- provenance preservation;
- normalized keyword import.

Acceptance:

The provided real export can feed the same internal keyword pipeline as raw seeds.

## Phase 6 — Surfer expansion

Deliver:

- related keyword parsing;
- overlap;
- volume;
- depth=1 expansion;
- configurable limits;
- dedupe against existing keywords.

Acceptance:

A seed can generate related candidates without creating recursive explosion.

## Phase 7 — Aggregation/scoring/output

Deliver:

- DR distributions;
- candidate features;
- deterministic score;
- CSV outputs;
- report.md;
- status.json;
- `--json-status`.

Acceptance:

A full run produces a ranked candidate table traceable back to raw SERP/domain data.

## Phase 8 — Hardening

Verify:

- CAPTCHA pause;
- geo mismatch warning;
- parser failure debug artifacts;
- preflight failure;
- Ahrefs failure;
- corrupted/invalid input handling;
- no secret leakage;
- historical runs preserved.

## Pull request strategy

Prefer focused PRs/phases rather than one enormous change.

However, the end deliverable is the complete v1. Do not stop after Phase 1 and call the project finished.

## Final end-to-end acceptance

Using a representative batch:

```text
Microsoft CSV or seeds
        ↓
batch Google/Surfer research
        ↓
optional Surfer expansion
        ↓
organic SERPs
        ↓
Ahrefs DR
        ↓
cache/resume/retries
        ↓
candidate aggregation/scoring
        ↓
CSV + report + machine status
```

The operator should not manually open every Google/Ahrefs page.

---

## Live research run (Chrome + Keyword Surfer)

The runner connects to a running Chrome over CDP (`CDP_URL`, default `http://127.0.0.1:9222`).
Surfer must be installed in that Chrome (`hasSurfer` preflight check).

### Critical: user-data-dir must not contain spaces

The operator's real profile lives at a path with a space
(`C:\Users\Biba Bobovich\AppData\Local\Google\Chrome\User Data`). Chrome does **not**
open the DevTools port when launched with `--user-data-dir` containing a space
(every launch method — cmd/bat/PowerShell `&`/Node spawn — reports `CDP: DOWN`).

Workaround that works (proven live):

1. Copy the real `Default` profile to a space-free path, e.g. `C:\tmp\research-profile`
   (robocopy, exclude caches; keep `Local Extension Settings` so Surfer carries over).
2. Launch Chrome on that copy:

   ```bat
   @echo off
   start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
     --remote-debugging-port=9333 ^
     --user-data-dir=C:\tmp\research-profile ^
     --profile-directory=Default ^
     --remote-allow-origins=*
   ```

3. In `chrome://extensions`, enable / re-install Keyword Surfer (a copied profile is
   treated as non-standard, so Chrome may disable extensions on first launch).
4. Run the research against the copy:

   ```text
   CDP_URL=http://127.0.0.1:9333 npm run research -- --seeds input/seeds.csv --expand
   ```

CDP on the space-free copy works and Surfer injects (proven: live returned
`compare lists -> volume 49,500 | cpc $7.90 | organic 9`, identical to the spike).

### Known live limitation: related-keywords widget

The related-keywords widget `keyword-surfer-sidebar` is parsed correctly from the
**real spike DOM** (fixture `test/fixtures/surfer-related-table.html` ->
`instagram / 50% / 30400000`). However, in a copied/free Surfer profile the widget
often does **not** render on the live SERP page. When it is absent, related expansion
is recorded as a non-fatal structured error (`related.status = 'error'`) and the
keyword still completes with its main volume/cpc/organic data. This is an environment
limitation observed with that Surfer account/extension state. Parser errors retain
HTML/screenshot/context evidence so the distinction can be verified per run.

### CAPTCHA in background runs

`pauseForManualCaptcha` waits for stdin when `process.stdin.isTTY`, otherwise polls for
the marker file `C:\tmp\captcha-done.txt` (override with `CAPTCHA_DONE_MARKER`). Create
the file after solving CAPTCHA in the Research Chrome window to let a background run resume.
