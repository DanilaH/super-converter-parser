# IMPLEMENTATION_PLAN.md

## Status

The browser integration spike is complete and accepted.

Observed for `compare lists`:

```text
Surfer volume: 49,500
Surfer CPC: 7.90
organic candidates: 9
```

Do not repeat the spike. Production work must preserve and refactor the proven CDP, Surfer, and Google behavior.

## Project decisions

- Repository name: `super-converter-parser`.
- Product name: `Utility Research Runner`.
- Runtime: Node.js 20+ with strict TypeScript.
- Package manager: npm. The repository already has `package-lock.json`; command examples use `npm run research -- ...`.
- Interface: local CLI only.
- Browser: dedicated Research Chrome connected through CDP.
- Browser keyword concurrency starts at `1`.
- Persistence target: SQLite, introduced with the durable run/cache work when its schema is defined.
- Run directories are mutable only while a run is created, running, or paused. Terminal runs are immutable.
- Pull requests must stay focused and independently reviewable.

## Delivery sequence

### PR 1 — Production foundation and seed batch collector

Refactor the proven spike into production modules and process a small seed CSV sequentially.

Deliver:

- CLI command `research`;
- explicit configuration with environment overrides;
- seed CSV validation, normalization, and case-insensitive dedupe;
- Research Chrome/CDP preflight;
- centralized Surfer selectors and parser;
- centralized organic SERP parser;
- sequential multi-keyword collection;
- raw run manifest and keyword/SERP JSON output;
- diagnostic HTML/screenshot/context on parser failure;
- focused tests for pure parsing and normalization logic.

Do not include:

- SQLite/cache;
- resume/checkpoints;
- Ahrefs;
- Microsoft import;
- Surfer expansion;
- scoring;
- final CSV/report suite.

Acceptance:

```bash
npm run research -- --seeds input/seeds.csv
```

With a three-keyword fixture and a prepared Research Chrome, the command:

1. fails early with a clear preflight error when Chrome is unavailable;
2. processes unique keywords sequentially;
3. records volume, CPC, Google URL, and up to ten real organic results;
4. creates a deterministic run directory containing `manifest.json`, `keywords.json`, and `serp.json`;
5. preserves debug evidence for a parser failure;
6. keeps `npm run probe` working;
7. passes typecheck and focused tests.

### PR 2 — Durable run engine

Deliver run states, incremental checkpoints, graceful Ctrl+C handling, bounded retries, error codes, circuit breaker, progress, ETA, and `--resume`.

Acceptance: interrupt a multi-keyword run and resume without repeating completed browser work.

### PR 3 — Persistent cache

Introduce SQLite-backed keyword, related-keyword, and domain caches with source-specific TTLs, parser versioning, hit/miss statistics, and force refresh. Browser cache keys include normalized keyword, Surfer market, Google `hl/gl`, and parser version. Failed entries use a shorter TTL than successful entries.

Acceptance: a second identical run avoids fresh browser work for valid cached entries.

### PR 4 — Microsoft Keyword Planner import

Add header-alias detection, useful schema errors, source-column preservation where practical, normalization, dedupe, and provenance.

Acceptance: a real Microsoft export feeds the same internal keyword pipeline as seed CSV.

### PR 5 — Keyword Surfer expansion

Parse related keyword, overlap, and volume from the proven sidebar. Add depth-one expansion, limits, filters, and dedupe.

Acceptance: expansion adds bounded candidates with parent/source metadata and cannot recurse indefinitely.

### PR 6 — Domain normalization and Ahrefs DR

Add Public Suffix List-aware registrable-domain normalization, global domain dedupe across the final keyword set, official Ahrefs DR adapter, rate-limit handling, and DR cache integration.

Acceptance: repeated domains trigger one fresh lookup per TTL window.

### PR 7 — Aggregation, scoring, and complete outputs

Define `SCORING.md` first, including exact feature normalization, weights, missing-data behavior, and tier boundaries. Then add DR distributions, observable candidate features, deterministic configurable scoring, neutral tiers, explainable rationales, CSV outputs, `report.md`, `status.json`, and `--json-status`.

Acceptance: every ranked candidate is traceable to raw keyword, SERP, and domain records.

### PR 8 — Hardening and end-to-end acceptance

Exercise CAPTCHA pause, geo mismatch warning, parser failure evidence, invalid input, Ahrefs failure, secret handling, historical run immutability, partial runs, and representative end-to-end flow.

Delivered as issue #16 (TASK-008). The reproducible acceptance contract and the
verified result matrix are maintained in [`ACCEPTANCE.md`](./ACCEPTANCE.md).

## Inputs and decisions still required

These do not block PR 1, but must be resolved before their respective phases:

- a real Microsoft Keyword Planner CSV fixture and observed header aliases;
- exact Ahrefs DR endpoint, authentication scheme, quota, and a safe test credential workflow;
- exact Google detected-location extraction strategy and fallback behavior;
- default cache TTLs, error TTLs, and resume behavior after config/parser-version changes;
- `SCORING.md`, including exact-match and niche-domain classification rules;
- expected CSV dialect, encoding/BOM handling, and practical input-size limits.

## Review policy

Every implementation PR is reviewed against:

1. its stated scope and acceptance criteria;
2. preservation of the proven spike behavior;
3. strict TypeScript and explicit data contracts;
4. failure behavior and diagnostic evidence;
5. tests that protect meaningful parser/domain/run invariants;
6. absence of unrelated abstractions or out-of-scope features;
7. documentation for any changed CLI or output contract.

Review findings are classified as:

- `BLOCKER` — correctness, data loss, secret exposure, broken acceptance, or scope violation;
- `MAJOR` — unreliable behavior or missing required coverage;
- `MINOR` — maintainability or clarity issue that does not invalidate acceptance;
- `NIT` — optional polish.

The team lead approves progression to the next PR only after all blockers and majors are resolved.

## Final v1 acceptance

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

The operator must not need to manually open every Google or Ahrefs page.
