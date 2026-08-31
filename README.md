# Utility Research Runner

Local-first CLI for discovering, validating, extending, and preserving SEO research for small browser utilities.

This is an internal research tool, not a SaaS product. SQLite checkpoints are the durable source of truth; CSV/JSON/Markdown/ZIP files are derived operator artifacts.

## Current operator workflow

```text
seed / Microsoft keyword input
        ↓
discovery:full
        ↓
research:append (optional, repeatable)
        ↓
enrich:full against the current discovery snapshot
        ↓
choose finalist clusters / review evidence
        ↓
finalize:full
        ↓
Research Library publication when current human decisions are complete
```

The phases stay separate deliberately:

- discovery and enrichment collect deterministic evidence;
- append advances one research through immutable combined discovery snapshots;
- finalization forwards explicit finalist scope, methodology policy, optional traffic, and human decisions rather than inventing them;
- Research Library publication preserves immutable cross-research history.

See [`FULL_RUNS.md`](./FULL_RUNS.md) for the normal end-to-end command flow.

## Runtime and install

The repository and CI runtime are pinned by `.nvmrc` (currently Node 24).

```bash
npm ci
```

Create local configuration from `.env.example`. `.env`, browser profiles, caches, research outputs, and secrets are gitignored.

### Research Chrome

Discovery and browser-backed suggestion collection use a dedicated Chrome profile with Keyword Surfer installed. Do not use the daily browsing profile.

```powershell
npm run chrome:setup
npm run chrome:start
```

The default CDP endpoint is `http://127.0.0.1:9333` and can be overridden with `CDP_URL`.

## Primary commands

### Full discovery

```bash
npm run discovery:full -- --seeds input/seeds.csv --name my-research
```

or:

```bash
npm run discovery:full -- --microsoft input/microsoft.csv --name my-research
```

`discovery:full` is the normal discovery runner with depth-one Keyword Surfer expansion enabled. Discovery persists Google organic evidence, Surfer volume/CPC and related observations, domain normalization, optional Ahrefs DR, cache provenance, quality state, and resumable checkpoints.

Ahrefs remains optional unless `--require-ahrefs` is supplied. Missing evidence stays missing; it is never converted to zero.

### Ordinary resume

```bash
npm run research -- --resume <run-id>
```

Ordinary resume continues unfinished work. Terminal keyword checkpoints are not silently reopened.

### Explicit primary-checkpoint repair

```bash
npm run research -- --resume <run-id> --retry-failed
```

`--retry-failed` is the historical flag name. The implemented repair surface includes:

- `failed` keyword checkpoints; and
- `partial` primary checkpoints whose persisted Surfer/Google evidence proves that primary collection is incomplete.

Completed checkpoints and partial checkpoints without a repairable primary failure are left untouched. Before reopening current state, the previous keyword/SERP evidence is copied into the append-only retry journal. An interrupted repair remains resumable through ordinary `--resume`.

### Append another seed batch to the same research

```bash
npm run research:append -- --to <research-id-or-run-id> --seeds input/more-seeds.csv
```

Append stores the input batch under the same research, de-duplicates normalized keywords, and forks a new immutable combined discovery snapshot only when genuinely new keywords exist. Existing checkpoints/evidence are copied forward unchanged; only new keywords are collected.

Use the **current run ID printed by the command** for downstream enrichment. See [`RESEARCH_BATCHES.md`](./RESEARCH_BATCHES.md).

### Inspect current research status

```bash
npm run research:status -- --research <research-id-or-any-run-id>
```

`research:status` is read-only. It resolves the logical research to `research.json.currentRunId` and reports the current discovery generation, keyword completion/repairability, existing quality warnings, immutable enrichment generations and module state, finalization/human-decision progress, and whether the **current exact public snapshot fingerprint** already exists in the Research Library. It never resumes, repairs, finalizes, publishes, or rewrites state.

Use `--json` for the machine-readable projection. The displayed next action is workflow navigation only; it is not a business or opportunity recommendation.

### Full enrichment

```bash
npm run enrich:full -- --run <current-run-id> --shortlist-file input/shortlist.txt
```

The current full enrichment alias runs:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

Deep modules require an explicit 5-200 keyword shortlist. Enrichment resume uses the same enrichment ID:

```bash
npm run enrich -- --resume <enrichment-id>
```

Completed module/target checkpoints are restored from SQLite; unfinished work continues without replaying already committed network work.

### Full finalization

```powershell
npm run finalize:full -- --enrichment <enrichment-id> `
  --clusters cluster-1,cluster-2 `
  --young-domain-max-age-days 730 `
  --recent-web-presence-max-age-days 730 `
  --repurpose-gap-min-days 365 `
  --decisions .\decisions.json
```

The threshold values above are an example policy, not universal SEO truth. The first finalization must receive explicit finalist scope (`--clusters ...` or deliberately `--all-clusters`) and explicit cohort-history policy. Later reruns may reuse compatible persisted state.

Finalization builds, in order:

```text
representative queries
entrant cohort
cohort history
optional compatible traffic evidence
finalist evidence matrix
Research Library publication when every current finalist has a current human decision
```

If human decisions are incomplete, finalization stops successfully after rebuilding the evidence matrix and reports what is still missing. It does not fabricate a decision.

A deliberate evidence-only publication requires the explicit `--publish-without-decisions` escape hatch.

### Manual Research Library publication

```bash
npm run library:publish -- --enrichment <completed-enrichment-id>
```

Publication is immutable and idempotent for the same public snapshot. Later versions of the same top-level research form one `supersedes` lineage even when append created a new discovery run and enrichment ID. See [`RESEARCH_LIBRARY.md`](./RESEARCH_LIBRARY.md).

## Discovery CLI controls

The lower-level research CLI remains available when the full alias is not desired:

```bash
npm run research -- --seeds input/seeds.csv
npm run research -- --microsoft input/microsoft.csv
npm run research -- --seeds input/seeds.csv --expand
npm run research -- --seeds input/seeds.csv --force-refresh
npm run research -- --seeds input/seeds.csv --refresh-keyword "json diff"
npm run research -- --seeds input/seeds.csv --json-status
npm run research -- --resume <run-id>
npm run research -- --resume <run-id> --retry-failed
```

Use `npm run research -- --help` for the main discovery CLI flags. `.env.example` is the authoritative copyable list of current environment settings and defaults.

## Enrichment CLI controls

Individual modules remain independently runnable:

```bash
npm run enrich -- --run <run-id> --modules clusters
npm run enrich -- --run <run-id> --modules query_suggestions --shortlist-file input/shortlist.txt
npm run enrich -- --run <run-id> --modules domain_age --shortlist-file input/shortlist.txt
npm run enrich -- --run <run-id> --modules pages --shortlist-file input/shortlist.txt
npm run enrich -- --run <run-id> --modules site_structure --shortlist-file input/shortlist.txt
npm run enrich -- --resume <enrichment-id>
```

Use `npm run enrich -- --help` for the current module/shortlist flags. Unknown flags and unexpected positional arguments are rejected as invalid input rather than silently ignored.

## Durable research layout

A logical research may contain multiple immutable discovery and enrichment generations:

```text
<RESEARCH_OUTPUT_ROOT>/
└── <date>-<label>/
    ├── research.json                 # stable research id + current discovery run
    ├── batches/                      # preserved append inputs
    ├── discovery/                    # original discovery snapshot
    ├── discovery-02/                 # combined snapshot after append
    ├── discovery-03/
    ├── enrichment/                   # enrichment for one discovery snapshot
    ├── enrichment-02/                # later enrichment generation
    ├── debug/                        # parser-failure evidence; excluded from results.zip
    └── results.zip                   # portable current research snapshot
```

Each discovery directory owns `run.sqlite`; each enrichment directory owns `enrichment.sqlite`. Old generations are retained for audit/history and are never rewritten merely because a newer generation exists.

The output root also contains an `index/` used to resolve run/enrichment IDs independently of the active checkout/worktree.

## Research Library layout

```text
<RESEARCH_OUTPUT_ROOT>/research-library/
├── library.sqlite
├── library.json
├── library.zip
└── researches/
    └── pub_<fingerprint>.zip
```

`library.sqlite` is the cumulative queryable truth. `library.json` and `library.zip` are derived snapshots.

## Core truth and safety contracts

- **SQLite first.** Resume/rebuild never reconstructs truth from CSV/JSON output files.
- **Immutable generations.** Append and re-enrichment create new snapshots instead of mutating historical discovery/enrichment evidence.
- **Fail closed on stale parents.** Representative, entrant, history, traffic, finalist, and publication layers pin compatible upstream generations/fingerprints.
- **Missing is not zero.** Unavailable, failed, omitted, synthetic, and unmeasured evidence remain distinguishable.
- **No automatic finalist verdict.** Automated evidence blocks remain separate from human `build | watch | reject | unknown` decisions.
- **Truthful Google geography.** Surfer market, `hl/gl`, and detected physical Google location are tracked separately.
- **Bounded network work.** HTTP enrichment uses bounded time/bytes/redirects, SSRF validation with pinned public destinations, rate limiting, and bounded retries for explicit transient failures.
- **No anti-bot bypass.** No proxy rotation for evasion, fingerprint spoofing, CAPTCHA solving service, or stealth browser work.

## Cache and interruption behavior

Discovery uses the persistent cross-run cache at `data/cache/cache.sqlite` by default. HTTP enrichment has its own persisted cache. Cache hits are copied into the durable run/enrichment checkpoint; completed work never depends on the cache row afterwards.

The first Ctrl+C requests a graceful pause and preserves resumability. A second interrupt may force termination. Browser CAPTCHA handling pauses for manual intervention instead of bypassing the challenge.

## Current external evidence boundaries

- **Keyword Surfer**: browser extension data; a missing related widget is explicit non-fatal evidence, not an empty success.
- **Ahrefs DR**: official free API only; optional unless required explicitly.
- **RDAP**: registration evidence.
- **Wayback/first seen**: separate optional evidence from registration age and may be unavailable.
- **Traffic**: provider-neutral imported evidence; absent traffic remains missing.
- **Paid page/backlink/organic provider metrics**: not a hidden dependency of the current full workflow. Do not fabricate them when no supported provider/account is configured.

## Read next / source of truth

Use these instead of treating this README as a duplicate specification:

1. [`FULL_RUNS.md`](./FULL_RUNS.md) — current end-to-end command orchestration.
2. [`RESEARCH_BATCHES.md`](./RESEARCH_BATCHES.md) — append generations, provenance, locks, failure behavior.
3. [`RESEARCH_LIBRARY.md`](./RESEARCH_LIBRARY.md) — cumulative publication and version lineage.
4. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — durable state, module boundaries, invariants.
5. [`PIPELINE.md`](./PIPELINE.md) — evidence flow.
6. [`SCORING.md`](./SCORING.md) — broad-discovery Score v1 contract.
7. `*_ACCEPTANCE.md` and methodology regression documents — feature-specific acceptance contracts and frozen-corpus evidence.
8. [`AGENTS.md`](./AGENTS.md) — repository rules for coding agents.

### Future planning (not current runtime/CLI contracts)

- [`V3_COMMERCIAL_EVIDENCE_SPEC.md`](./V3_COMMERCIAL_EVIDENCE_SPEC.md) — next-major-version commercial evidence scope and explicit runner boundary.
- [`COMMERCIAL_DATA_PROVIDER_MATRIX.md`](./COMMERCIAL_DATA_PROVIDER_MATRIX.md) — free-first provider/access audit; provider constraints must be re-verified before implementation.

## Proven integration

The original spike proved the browser-risky path: Playwright/CDP can control a dedicated Research Chrome profile, Keyword Surfer data is accessible to automation, and organic results can be parsed without confusing Surfer annotations with organic links. Production discovery, enrichment, append/finalization, and Research Library behavior are now governed by the durable contracts and acceptance documents above rather than by the historical single-query spike.