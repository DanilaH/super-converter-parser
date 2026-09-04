# PIPELINE.md

## Purpose

This document describes the **current merged evidence flow** of Utility Research Runner.

It is not a roadmap. Historical implementation plans and acceptance files may describe older stage behavior; they do not override this pipeline.

## End-to-end overview

```text
INPUT
  ├── seed CSV
  └── Microsoft Keyword Planner export
        ↓
normalize + dedupe + provenance
        ↓
DISCOVERY ROOTS
  Google + Keyword Surfer
  ├── volume / CPC
  ├── raw Related observations
  └── organic SERP + source-specific Google state
        ↓
optional Expansion Admission V1
        ↓
selected expansion children only
        ↓
normalize SERP domains
        ↓
optional Ahrefs DR
        ↓
aggregation + Score v1.1 + run-quality
        ↓
DISCOVERY SNAPSHOT
        ↓
optional immutable append generation(s)
        ↓
explicit shortlist
        ↓
ENRICHMENT
  ├── clusters
  ├── query suggestions
  ├── domain age/history evidence
  ├── pages
  └── site structure
        ↓
explicit finalist scope
        ↓
FINALIZATION
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
  explicit human decisions
        ↓
  optional/current Research Library publication
```

The config-first planner/executor orchestrates this same pipeline and stops at unresolved human gates. It does not define a second evidence model.

## Stage 1 — Input

### Seed CSV

Minimal shape:

```csv
keyword
compare csv files
zip code county lookup
filter csv by column
```

### Microsoft export

Microsoft Keyword Planner CSV remains a supported discovery source.

The adapter should:

- recognize required headers by supported aliases;
- preserve source provenance;
- normalize into the same canonical keyword model as seed input;
- fail with a useful schema error when the export is not recognizable.

Microsoft volume is a discovery signal, not final truth and not a universal kill threshold.

## Stage 2 — Keyword normalization and identity

Normalize safely:

- trim surrounding whitespace;
- collapse repeated whitespace;
- preserve semantic punctuation;
- case-insensitive dedupe for semantically identical normalized text;
- preserve source provenance.

Text normalization is **not** relational ownership.

Within a source discovery generation, durable keyword-owned relations use the persisted keyword index scoped by the source run:

```text
(sourceRunId, keywordIdx)
```

Normalized text remains valid for semantic dedupe, cache identity where appropriate, user lookup, and display.

## Stage 3 — Root Google + Keyword Surfer collection

For each root keyword collect and persist primary evidence including:

```text
keyword
Surfer volume
Surfer CPC
Surfer market
Google hl/gl
Google page URL
detected Google location
Google source-specific SERP state
organic result rows
raw Related observations
provider/parser errors where applicable
```

### Google SERP truth

Google and Surfer can succeed/fail independently. Aggregate keyword status does not replace source-specific Google state.

Supported SERP semantics include:

```text
ok
empty
fetch_error
parse_error
not_fetched
unknown
```

Truth rule:

```text
ok + persisted rows       -> organic_result_count = N
empty + zero rows         -> organic_result_count = 0
fetch/parse/not_fetched/
unknown                   -> organic_result_count missing
```

Do not convert an unavailable or ambiguous Google result into an easy zero-result SERP.

### Organic result rules

Collect up to configured `topN` organic rows.

Do not count ads, sponsored results, PAA, related searches, shopping widgets, local packs, knowledge panels, Surfer-injected links, or navigation links as organic results.

If the rendered page yields fewer valid organic rows, preserve the observed number.

## Stage 4 — Expansion Admission V1

Fresh public discovery with expansion enabled uses a **global deterministic frontier**.

Old immediate-per-parent expansion is not the current V1 path.

### Lifecycle

```text
collect every root's primary + raw Related evidence
        ↓
all roots terminal
        ↓
build admission from durable Related rows
        ↓
append only selected candidates
        ↓
collect primary evidence for selected children
```

### V1 rules

- expansion depth is exactly 1;
- reject candidates already present as original keywords;
- reject single-token automatic expansion candidates;
- explicit seeds may still be single-token;
- apply configured `minOverlap`, `minVolume`, and per-parent candidate cap;
- rank per-parent occurrences deterministically;
- rank global candidates by non-broadening first, bucketed parent support, best overlap, bounded specificity, max volume, lexical tie-break;
- strict lexical broadening is a ranking penalty, not a universal reject;
- preserve directional queries as distinct;
- cap newly added candidates at:

```text
min(500, ceil(originalKeywordCount * 1.25))
```

### Durable/diagnostic behavior

Raw Related evidence is persisted independently from the final frontier decision.

Current derived diagnostics:

```text
expansion-admission.json
expansion-admission.csv
```

They expose decisions such as:

```text
selected
existing_keyword
single_token
below_min_signal
parent_cap
global_budget
```

along with support/priority evidence.

Do **not** claim omission reasons are unavailable for current V1 runs. Historical runs may lack this report and retain their historical semantics.

Unknown persisted admission versions fail closed.

## Stage 5 — Domain normalization

For every organic URL derive:

```text
hostname
registrable domain (eTLD+1)
```

Use Public Suffix List-aware normalization. Do not derive registrable domains with a naive split on dots.

## Stage 6 — Ahrefs DR

Collect DR once per unique registrable domain subject to the shared cache and provider pacing/TTL policy.

Ahrefs is optional unless explicitly required.

Preserve provider outcomes distinctly:

```text
ok
not_found
error
not_attempted
```

Missing DR does not become `0`.

## Stage 7 — Aggregation and scoring

Aggregate only from trustworthy persisted discovery evidence.

Examples include:

```text
organic_result_count
unique_domains
min_dr / median_dr / max_dr
top3_median_dr / top5_median_dr
weak/strong domain counts
missing_dr_count
niche-domain heuristic counts
SERP diversity
```

If SERP evidence is unavailable/ambiguous, SERP-derived candidate fields stay missing.

Broad-discovery scoring is governed by [`SCORING.md`](./SCORING.md). Do not duplicate or silently alter its formula here.

The score is a prioritization signal, not a BUILD/KILL verdict.

## Stage 8 — Run-quality projection

`run-quality.json` is a deterministic read projection over durable discovery evidence.

It reports source-specific coverage/warnings for Google, Surfer, Related, Ahrefs, geo, omissions/caps where available, and other discovery quality facts.

Quality warnings explain uncertainty. They are not negative opportunity evidence.

## Stage 9 — Discovery publication

Current discovery produces derived artifacts such as:

```text
manifest.json
keywords.json
serp.json
run-quality.json
keywords.csv
related-keywords.csv
serp.csv
domains.csv
candidates.csv
report.md
status.json
expansion-admission.json/.csv   # V1 expansion runs
```

SQLite remains resume truth.

Terminal/public metadata is published from durable state with fail-closed ordering. A generated file is not authoritative merely because it physically exists.

## Stage 10 — Append / iterative discovery

A logical research can be extended with:

```bash
npm run research:append -- --to <research-id-or-run-id> --seeds input/more-seeds.csv
```

Append can create a new immutable combined discovery generation when:

- a genuinely new normalized keyword appears; or
- an existing expansion child is explicitly promoted into a root seed.

Promotion-only append may therefore create a generation with zero genuinely new keywords.

For V1 expansion forks, raw Related evidence can carry forward, but previous generation `selectedForExpansion` decisions are not current truth and are recomputed for the new frontier.

See `RESEARCH_BATCHES.md`.

## Stage 11 — Enrichment

Current full enrichment modules are:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

Shortlist-dependent deep work requires an explicit bounded shortlist.

Each module/target is checkpointed incrementally in the enrichment generation's SQLite database. Successful sibling evidence survives individual provider/target failures.

### Entrant-aware bounded domain selection

Fresh enrichment generations that execute `domain_age` or `site_structure` use the versioned `entrant-v1` allocation policy for bounded deep-domain targets. This changes **which domains receive the existing evidence budget**, not the cap or provider budget itself.

The policy preserves shortlist keyword round-robin breadth. Within each keyword it prefers:

```text
known weak DR
→ recurrence across shortlisted queries
→ distinct normalized ranking pages
→ better rank
→ lower known DR / occurrence count / deterministic tie-breaks
```

`weak` reuses the immutable source-discovery scoring contract `DR < scoring.drThresholds.weakMax`; no enrichment-specific threshold is invented. Missing or conflicting DR is unknown evidence and is never silently classified as weak.

Persisted enrichments created before the `entrant-v1` marker retain their legacy rank-first selection when resumed. A software update must not silently change the target population of an existing enrichment generation.

### Query suggestions

Suggestion sources are independently observable. One source failing must not erase another source's successful results.

`empty`, `unavailable`, and `error` remain distinct. Cache TTL semantics may differ by outcome.

### Page/site-structure work

HTTP enrichment remains bounded in time/bytes/redirects and must preserve the existing SSRF/private-address protection boundary.

## Stage 12 — Representative queries

Finalist validation begins from explicit finalist cluster scope.

Representative query sets are deterministic/versioned projections over current cluster evidence, with explicit override support where accepted.

A changed representative set invalidates dependent interpretation rather than silently relabeling old entrant/finalist evidence as current.

## Stage 13 — Entrant cohort

Build entrant evidence from current representative-query SERPs.

Preserve ranking occurrences while deduplicating cohort entities by registrable domain for domain-level projection.

Aggregate/public summaries must keep their counting units explicit:

```text
rankingOccurrenceCount                   # included SERP ranking rows
clusterDomainMembershipCount             # domain rows across finalist cohorts; one domain may appear in several clusters
globalUniqueDomainCount                  # registrable domains deduplicated across all finalist clusters
crossClusterDomainCount                  # globally unique domains present in >=2 finalist clusters
knownDrDomainMembershipCount             # cluster-domain memberships with one unambiguous known DR
weakDomainMembershipCount                # known-DR memberships satisfying the source run's weak threshold
withinClusterRepeatedDomainMembershipCount # memberships repeated across representative queries inside the same cluster
```

A per-cluster `summary.uniqueDomainCount` remains valid because it is unique **within that cohort**. Summing those per-cluster values produces `clusterDomainMembershipCount`, not a globally unique domain count.

Expose transparent repetition/coverage facts; do not convert observed entrant success into a launch-success probability.

## Stage 14 — Bounded sampled historical presence

Current `finalize:full` automatically includes the production Common Crawl sampled-presence step after entrant cohort and before cohort history.

Fresh collections use a separately versioned entrant-aware allocation policy inside the existing Common Crawl domain cap. The policy preserves finalist-cluster round-robin breadth; within each cluster it prefers known weak entrants and then cross-cluster/cross-query recurrence, distinct ranking-page evidence, and rank/DR/occurrence evidence. A shared domain consumes one bounded slot, so a later cluster advances to its next candidate rather than spending another slot on the same domain. The collection format remains independently versioned; legacy snapshots without the selection-policy marker remain readable under their historical semantics.

The enrichment deep-domain cap and the historical-presence cap are separate bounded allocation contexts. Success of one selector does not imply coverage by the other, and neither may silently increase its configured cap.

Semantics:

```text
bounded sampled web presence
```

Not:

```text
exact first-ever web presence
exact site age
proof of non-existence
```

Keep these states distinct:

```text
ok
not_found
not_attempted
unavailable
error
omitted/domain_cap
incomplete selected-collection traversal
```

Common Crawl never backfills exact `firstSeenDate` semantics.

## Stage 15 — Cohort history

Cohort history projects registration and first-seen evidence under explicit methodology policy.

RDAP registration evidence, first-seen evidence, and Common Crawl sampled historical presence remain separate fact families.

Coverage denominators must expose checked vs unobserved/omitted/error state rather than treating missing domains as clean negatives.

## Stage 16 — Optional traffic evidence

Traffic is provider-neutral imported evidence and remains optional.

Domain-level traffic must not silently populate page-level traffic facts.

Absent traffic remains missing.

Compatible persisted traffic snapshots may be reused according to their existing parent/currentness contract.

## Stage 17 — Finalist evidence matrix

Project current evidence into independent human-review blocks.

The matrix is an evidence surface, not a hidden scalar opportunity score.

Current evidence may include demand, SERP accessibility, entrant repetition, sampled/historical evidence, traffic, moat observations, monetization/geography fields, and explicitly missing product-feasibility information.

Do not fabricate evidence for blocks the runner cannot measure.

## Stage 18 — Human decisions and Library publication

Human decisions remain explicit facts such as:

```text
build | watch | reject | unknown
```

and their current SEO/product role where provided.

Decisions are pinned to the evidence generation they reviewed. Stale decisions remain visible rather than silently current.

Research Library publication is immutable/idempotent for the same public snapshot. Derived Library snapshots may be repaired independently when durable `library.sqlite` already contains the publication.

## Resume and repair

### Ordinary discovery resume

```bash
npm run research -- --resume <run-id>
```

Continues unfinished work and does not reopen terminal primary checkpoints.

### Explicit primary repair

```bash
npm run research -- --resume <run-id> --retry-failed
```

The current implementation repairs:

- failed primary keyword checkpoints; and
- provably incomplete `partial` primary checkpoints where persisted source evidence establishes repairable primary collection.

The historical flag name must not be interpreted as “failed rows only”.

Repair is planned/validated before mutation, journals previous evidence, reopens only eligible current checkpoints, and remains resumable if interrupted.

### Enrichment resume/recovery

```bash
npm run enrich -- --resume <enrichment-id>
```

A persisted `running` enrichment generation may be treated as crash residue only after acquiring that generation's execution lock. A live concurrent owner must not be reset.

## Config-first orchestration

Primary operator flow:

```bash
npm run research:plan -- --config research.config.json
npm run research:run -- --config research.config.json
npm run research:plan -- --research <research-id> [--continue continuation.json]
npm run research:run -- --research <research-id> [--continue continuation.json]
```

Planner/executor use the same semantic resolution model.

Human-gated states stop explicitly. Continuation names the stable research; generated run/enrichment IDs are resolved from durable state.

## Progress and cancellation

The CLI should expose current stage/item, completed/total, errors, cache behavior, and useful timing/progress data where available.

First Ctrl+C requests graceful cancellation/pause. A later stage must not launch merely because the current stage happened to complete after the signal was already raised.

## Evidence honesty invariant

At every stage:

```text
unknown != zero
missing != negative
not_found != unavailable
not_attempted != checked
error != empty
omitted != measured
```

This invariant is more important than making every table numerically complete.