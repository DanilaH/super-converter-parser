# ARCHITECTURE.md

## Purpose

This document describes the **current merged architecture** of Utility Research Runner.

Historical roadmaps and acceptance records explain how the system evolved, but they do not override this contract.

## Principles

1. Local-first.
2. CLI/config-first; no hosted service requirement.
3. Strict TypeScript.
4. SQLite is durable truth.
5. Generated JSON/CSV/Markdown/ZIP files are derived read/publication surfaces.
6. Immutable discovery/enrichment generations preserve history.
7. Missing/unavailable/error evidence never becomes a valid-looking zero or negative fact.
8. Provider-specific behavior stays isolated behind small adapters.
9. Browser/parser failures retain lightweight debug evidence.
10. Human finalist decisions remain separate from automated evidence.
11. Currentness is established by durable identity/fingerprints, never by filesystem mtime.
12. New abstraction is justified by measured need, not symmetry.

## Implemented stack

```text
Node.js (repo/CI pinned by .nvmrc)
TypeScript
Playwright Core over CDP
better-sqlite3
csv-parse
undici
tldts
CSV / JSON / Markdown / ZIP artifacts
```

## Durable state model

### Discovery

Each discovery generation owns:

```text
<research>/discovery[-NN]/run.sqlite
```

`run.sqlite` owns keyword checkpoints, SERP evidence, Related observations, domains, retry history extensions, expansion selection state, and other generation-local discovery facts.

### Enrichment/finalization

Each enrichment generation owns:

```text
<research>/enrichment[-NN]/enrichment.sqlite
```

That database owns enrichment checkpoints and the downstream finalist evidence chain for that enrichment generation.

### Cross-run caches

Discovery and enrichment caches are reusable accelerators, not durable research truth. Once a cache hit is copied into a run/enrichment checkpoint, the completed checkpoint no longer depends on the mutable cache row.

### Research container

One logical research may contain many immutable generations:

```text
<RESEARCH_OUTPUT_ROOT>/
└── <date>-<label>/
    ├── research.json
    ├── operator-config.json        # when created through config-first flow
    ├── batches/
    ├── discovery/
    ├── discovery-02/
    ├── enrichment/
    ├── enrichment-02/
    ├── debug/
    └── results.zip
```

The stable research identity is anchored to the first discovery generation.

Current lineage invariants:

```text
research.json.researchId == research.json.batches[0].resultRunId
research.json.currentRunId == research.json.batches[-1].resultRunId
```

The current reader fails closed when those invariants are broken.

The output index is a locator only. Durable SQLite identity is validated before an indexed run/enrichment is trusted.

## High-level module shape

```text
src/
├── ahrefs/              # official DR adapter
├── browser/             # Research Chrome/CDP, preflight, CAPTCHA handling
├── cache/               # shared persistent caches
├── cli/                 # operator entrypoints
├── config/              # machine/runtime configuration
├── db/                  # SQLite schema/store boundaries
├── diagnostics/         # parser failure evidence
├── discovery/           # discovery application service/facade
├── domains/             # hostname / registrable-domain normalization
├── enrichment/          # clustering, suggestions, page/site-structure, evidence projections
├── finalization/        # shared downstream finalization services/orchestration
├── firstseen/           # first-seen provider boundary
├── google/              # organic SERP and suggestion parsing
├── historicalPresence/  # bounded Common Crawl sampled-presence evidence
├── input/               # seeds, Microsoft, traffic imports
├── operatorConfig/      # typed config/preset/continuation + planner semantics
├── outputs/             # research layout/index/archive/publication helpers
├── rdap/                # registration evidence
├── runs/                # discovery engine/checkpoints/expansion/aggregation
├── scoring/             # broad-discovery Score contract
├── shared/              # intentionally small common utilities
└── surfer/              # Keyword Surfer parser/selectors
```

Keep cross-cutting abstractions narrow. Do not introduce a generic provider/plugin framework merely because several adapters exist.

## Config-first architecture

The accepted normal orchestration layer is:

```text
OperatorResearchConfigV1
        +
optional OperatorContinuationV1
        +
current durable research state
        +
machine/runtime capabilities
        ↓
semantic resolver
        ↓
ResolvedExecutionPlan
      /                 \
research:plan         research:run
(read-only)           (side effects)
                          ↓
                 shared stage services
                          ↓
                    durable Runner state
```

### Key invariants

- `ResolvedExecutionPlan` is ephemeral; it is never a second workflow database.
- continuation targets an explicit stable `researchId`;
- no “latest research” inference;
- stage semantic fingerprints isolate unrelated semantic changes;
- existing evidence-parent fingerprints/revisions remain authoritative for downstream currentness;
- relative authored paths resolve relative to the file that declares them;
- resolved absolute paths, secrets, CDP URL, cache paths, transport timeouts, and generated IDs are excluded from semantic identity where they do not belong;
- legacy/direct CLIs remain supported adapters over the same accepted stage behavior where shared services exist.

## Discovery architecture

```text
Seeds / Microsoft CSV
        ↓
normalize + canonicalize + preserve provenance
        ↓
Research Chrome / Google + Keyword Surfer
        ↓
run.sqlite primary checkpoints
        ↓
optional Expansion Admission V1 frontier
        ↓
Google/Surfer collection for selected children
        ↓
normalized domains + optional Ahrefs DR
        ↓
aggregation / Score projection / quality artifacts
```

### Google observation truth

Aggregate keyword status is not sufficient to describe Google evidence because Surfer and Google can succeed/fail independently.

Persist source-specific SERP observation state such as:

```text
ok
empty
fetch_error
parse_error
not_fetched
unknown
```

Truth invariant:

```text
serpStatus=ok    + persisted rows -> organic_result_count=N
serpStatus=empty + zero rows      -> organic_result_count=0
other states                     -> organic_result_count missing
```

A Surfer failure does not erase valid Google evidence. A Google failure does not become an empty/easy SERP.

### Durable keyword identity

Within one source discovery run, relational keyword ownership uses the persisted keyword index, scoped by the source run.

Conceptually:

```text
(sourceRunId, keywordIdx)
```

Normalized text remains valid for semantic dedupe, cache identity where appropriate, user lookup, and display. It is not a substitute for an available durable relational key.

## Expansion Admission V1

Fresh public discovery with expansion enabled stamps the persisted admission version and uses a **global durable frontier**.

Lifecycle:

```text
collect all depth-zero roots
        +
persist raw Related observations
        ↓
all roots terminal
        ↓
build deterministic admission from durable Related evidence
        ↓
append only selected children
        ↓
collect selected child primary evidence
```

V1 policy includes:

- depth 1 only;
- reject existing keywords;
- reject single-token automatic expansion candidates;
- preserve configured `minOverlap`, `minVolume`, and per-parent cap;
- rank non-broadening before strict lexical broadening;
- bucket parent support so generic hubs do not dominate without bound;
- use overlap, bounded specificity, volume, and lexical tie-breaks deterministically;
- global addition budget:

```text
min(500, ceil(originalKeywordCount * 1.25))
```

- preserve directional query identity;
- persist full decision diagnostics in `expansion-admission.json` / `.csv`;
- recompute generation-local selection when append creates a new V1 frontier;
- fail closed on unknown persisted admission versions;
- preserve historical behavior for snapshots without the marker.

The admission report is a derived explanation surface; SQLite Related/keyword state remains durable truth.

## Append generations

`research:append` mutates one logical research by creating a new immutable combined discovery generation when necessary.

A generation may be created because:

- a genuinely new normalized seed is added; or
- a keyword that previously behaved as an expansion child is explicitly supplied as a root seed.

Promotion reopens the promoted keyword in the new generation and gives the new generation truthful root provenance. The prior generation remains the immutable record of how that keyword originally entered.

See `RESEARCH_BATCHES.md` for the full append contract.

## Enrichment architecture

A completed/current discovery generation may feed one or more immutable enrichment generations.

Current full enrichment modules:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

Deep modules use an explicit bounded shortlist. Module/target work is checkpointed in `enrichment.sqlite` and resumed from durable state.

Network-backed page/site-structure inspection keeps bounded fetch/redirect/SSRF protections; do not replace it with an unbounded convenience fetch.

## Finalization evidence chain

The current downstream chain is:

```text
current enrichment
        ↓
representative queries
        ↓
entrant cohort
        ↓
bounded Common Crawl sampled historical presence
        ↓
cohort history (RDAP / first-seen policy projection)
        ↓
optional compatible traffic evidence
        ↓
finalist evidence matrix
        ↓
current human decisions
        ↓
Research Library publication
```

### Parent pinning / invalidation

Each downstream projection pins compatible upstream identity/fingerprint/revision.

When an upstream parent changes, stale downstream interpretation must fail closed. Public metadata/artifact advertisements are invalidated so an old finalist matrix cannot remain current merely because the file still exists.

Filesystem timestamps are not currentness proof.

### Sampled historical presence

Common Crawl evidence means:

```text
bounded sampled web presence in selected collections
```

It does not mean:

```text
exact first-ever web presence
exact site age
proof of non-existence when no capture is observed
```

`not_found`, `not_attempted`, `unavailable`, `error`, domain-cap omission, and incomplete traversal remain distinct.

Common Crawl timestamps never populate exact `firstSeenDate` semantics.

### Human decisions

Human finalist decisions are stored separately from evidence and pinned to the evidence generation they reviewed. Upstream changes may make a decision stale; they do not silently rewrite it as current.

## Research Library architecture

`library.sqlite` is cumulative durable publication truth.

Derived surfaces include:

```text
library.json
library.zip
researches/pub_<fingerprint>.zip
```

Publication identity is semantic/public-artifact based, not based on SQLite/WAL bytes or mtime.

The same public fingerprint is idempotent. A later materially different publication from the same logical research forms a `supersedes` lineage.

If durable Library publication succeeds but derived snapshots are interrupted/stale, config-first status/planning can reopen only the local publication repair path; upstream provider/evidence work is not rerun merely to regenerate derived files.

See `RESEARCH_LIBRARY.md`.

## Repair / resume architecture

### Ordinary discovery resume

```bash
npm run research -- --resume <run-id>
```

Continues unfinished work and does not reopen terminal primary checkpoints.

### Explicit primary repair

```bash
npm run research -- --resume <run-id> --retry-failed
```

The historical flag name now covers:

- failed primary checkpoints; and
- provably incomplete `partial` primary checkpoints whose persisted source evidence shows a repairable primary failure.

Repair planning is read-only first; previous primary/SERP evidence is journaled before current state is reopened. An interrupted repair remains resumable.

### Enrichment recovery

Enrichment execution is serialized per durable enrichment generation. A persisted `running` state can be treated as crash residue only by the process that successfully acquires that generation's execution lock; a genuinely live concurrent process must not be reset.

## Locking model

Do not conflate different lock scopes.

Current important boundaries:

- discovery execution lock per canonical durable output root;
- research execution lock per stable research identity;
- research batch/publication lock;
- enrichment execution lock per durable enrichment generation.

Canonical research mutation order is:

```text
execution -> batch -> discovery
```

Direct finalization entrypoints use the same research execution boundary as config-first finalization so evidence mutations cannot interleave.

Lock identity must collapse filesystem aliases where the same physical durable root is intended. The output index is not lock identity truth.

## Browser/provider boundaries

### Research Chrome

Use a dedicated persistent Research Chrome profile with Keyword Surfer installed.

Do not use the operator's normal Chrome profile.

CAPTCHA policy:

```text
detect -> pause -> manual solve -> resume
```

No automated solving, stealth, fingerprint spoofing, or evasion proxy rotation.

### Ahrefs

Use the official free Domain Rating API path only. Authentication/systemic failures remain explicit and must not be fanned out as fake per-domain success.

### RDAP / first seen / Common Crawl

Registration date, first-seen evidence, and sampled historical presence are separate fact families. Do not alias one into another to fill gaps.

## Publication and interruption

Terminal/publication metadata is written from durable state with fail-closed ordering. A derived artifact write failure must not rewrite durable evidence history.

Graceful shutdown preserves resumability. First Ctrl+C requests cancellation/pause; stage boundaries must honor an already-raised cancellation before launching the next expensive stage.

## Documentation boundary

This file is a current architecture contract.

Historical release acceptance and implementation roadmaps may contain older architecture snapshots. Preserve them as history, but do not use them to reintroduce superseded runtime behavior.