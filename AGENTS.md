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
