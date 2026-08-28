# AGENTS.md

## Mission

Implement and maintain `utility-research-runner` as a reliable local research CLI.

The purpose is to eliminate repetitive SEO research work, not to build a generic SEO platform.

## Source of truth

Read in order:

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `PIPELINE.md`
4. `V2_1_IMPLEMENTATION_ROADMAP.md` — current V2.1 engineering backlog and implementation decisions
5. `V2_1_BASELINE_GAP_MATRIX.md` — current-state reconciliation evidence; not a substitute for implemented behavior
6. `README.md`
7. `ACCEPTANCE.md`
8. `IMPLEMENTATION_PLAN.md` — historical v1 delivery plan, not the current backlog

Current-state documents (`ARCHITECTURE.md`, `PIPELINE.md`, `README.md`, `ACCEPTANCE.md`) must remain truthful about merged behavior. Do not document a roadmap target as already implemented. When a V2.1 PR changes runtime behavior, update the relevant current-state docs in that PR.

## Current V2.1 implementation rule

Follow `V2_1_IMPLEMENTATION_ROADMAP.md` instead of mechanically replaying proposal-era phases.

The foundation order is deliberate:

```text
SERP truth semantics
→ durable enrichment keyword ownership
→ independent cold review
→ larger clustering/cohort work
```

Do not start by rebuilding RDAP/Wayback, introducing a global keyword UUID migration, or adding Common Crawl/Certificate Transparency to the critical path. The roadmap records why those older proposals are superseded, deferred, or dropped.

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

## Evidence truthfulness is required

Never silently convert unavailable evidence into a valid-looking negative value.

In particular:

```text
missing != zero != error != omitted/cap
```

A numeric zero is only valid when the corresponding source successfully observed and proved zero. Source-specific success/failure must survive persistence when aggregate keyword state is ambiguous.

Relational keyword ownership must use the durable source-run keyword identity. Normalized text remains valid for intentional semantic dedupe/cache/user lookup/display, but not as a substitute for an available relational key.

## Scope discipline

If a new abstraction or dependency is not required by these docs, justify it before introducing it.

Prefer explicit code over a premature generic "provider/plugin framework".

## Completion rule

v1 acceptance status is recorded in `ACCEPTANCE.md`. New work must preserve its mandatory PASS contracts and keep that document truthful.

V2.1 work is complete only according to the current roadmap gates. Each roadmap PR follows:

```text
task
→ implementation
→ independent review
→ fix
→ review
→ Ubuntu + Windows CI
→ merge
```

Do not skip the independent review gate because the first implementation passes tests.

---

## Implementation plan and acceptance

The phase descriptions below are a historical capability map. `IMPLEMENTATION_PLAN.md` records the completed v1 delivery sequence; it is not the current backlog. Current behavior and verification contracts come from the code, `README.md`, `PIPELINE.md`, and `ACCEPTANCE.md`. Current V2.1 work comes from `V2_1_IMPLEMENTATION_ROADMAP.md`.

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

For V2.1, the focused PR sequence and dependencies in `V2_1_IMPLEMENTATION_ROADMAP.md` supersede using these historical phase headings as a backlog.

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

The runner connects to a running Chrome over CDP (`CDP_URL`, default `http://127.0.0.1:9333`).
Surfer must be installed in that dedicated Research Chrome (`hasSurfer` preflight check).

### Research Chrome setup

Use `npm run chrome:setup` once to prepare the isolated profile and `npm run chrome:start` to launch it. The canonical operator setup and live-acceptance procedure is maintained in `ACCEPTANCE.md` §1; do not duplicate a second machine-specific runbook here.

### Known live limitation: related-keywords widget

The related-keywords widget `keyword-surfer-sidebar` is parsed correctly from the
**real spike DOM** (fixture `test/fixtures/surfer-related-table.html` ->
`instagram / 50% / 30400000`). However, in a copied/free Surfer profile the widget
often does **not** render on the live SERP page. When it is absent, related expansion
is recorded as a non-fatal structured error (`related.status = 'error'`) and the
keyword still completes with its main volume/cpc/organic data. This is an environment
limitation observed with that Surfer account/extension state. Parser errors retain
HTML/screenshot/context evidence so the distinction can be verified per run.

### CAPTCHA handling

`pauseForManualCaptcha` polls the Research Chrome page directly. After the operator solves the challenge, the runner continues automatically; no Enter press or marker file is used. Ctrl+C sets the shared cancellation signal so the active keyword remains resumable.
