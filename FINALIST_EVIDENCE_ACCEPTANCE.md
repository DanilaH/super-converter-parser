# Finalist Evidence Matrix Acceptance — V2.1 PR-09

## Status

Implementation contract for V2.1 PR-09 (`finalist evidence matrix`).

PR-09 projects already durable finalist evidence into an explicit human-review surface. It does not run new browser/provider collection, replace Score v1, infer launch-success probability, or issue an automatic BUILD/WATCH/KILL verdict.

## Scope

```text
current representative-query generation
+ current entrant cohort
+ optional cohort-history projection
+ optional imported traffic evidence/policy
+ existing site-structure evidence
+ frozen source-run keyword/CPC/geo facts
+ optional human decision snapshot
        ↓
finalist-evidence CLI
        ↓
independent A–G evidence blocks
        ↓
finalist-evidence-matrix.csv / .json
        ↓
manifest/status publication + results.zip
```

SQLite and the frozen discovery run remain the durable sources of truth. The matrix is a deterministic publication projection.

## Evidence blocks

Each current finalist exposes independent blocks:

```text
A. Demand
B. SERP accessibility
C. Organic traffic proof
D. Entrant repeatability
E. Moat
F. Monetization / geography
G. Product feasibility
```

The blocks must not collapse into an opaque opportunity score.

### A. Demand

Use the current representative-query set only.

Expose:

- representative query identities;
- per-query volume or `null`;
- observed-volume numerator/denominator/ratio;
- min/median/max over known representative volumes.

Do not sum representative volumes into a fake cluster demand total because representatives can overlap semantically.

### B. SERP accessibility

Expose descriptive current SERP evidence, including:

- cluster member count;
- clustering cohesion when available;
- representative URL coverage with numerator/denominator;
- entrant domain count;
- known/missing/conflicting DR counts;
- weak-domain coverage;
- repeated-domain coverage;
- page-identity coverage;
- entrant/cohort warnings.

No `easy/hard` classifier is inferred automatically.

### C. Organic traffic proof

Reuse PR-08 traffic evidence only.

Expose:

- imported snapshot count for the finalist;
- whether a current traffic projection exists;
- matched/mismatched counts when projectable;
- compatible history identities;
- raw/effective snapshot counts per history;
- latest effective measurement;
- latest transparent velocity interval;
- low-base/currency/target warnings.

Only current target-matched histories participate in velocity. Domain and URL scope remain distinct.

### D. Entrant repeatability

Expose the entrant cohort’s observed repetition facts and survivorship warning.

If PR-07 cohort-history evidence exists, include its current summary exactly, including checked/omitted/unobserved denominators. If history was not collected, emit `null`; do not reinterpret absence as negative evidence.

### E. Moat

PR-09 does not invent a moat score.

Reuse already collected site-structure records that match current entrant-cohort domains and expose descriptive facts such as sitemap/site breadth and sampled utility URL counts.

Coverage is explicit. Unobserved domains are not negative moat evidence.

Every block carries an explicit warning that site-structure observations are descriptive competitor facts, not an automated moat verdict.

### F. Monetization / geography

Reuse frozen representative-keyword facts:

- CPC where genuinely observed;
- CPC numerator/denominator/ratio and min/median/max;
- Surfer market;
- Google `hl` / `gl`;
- detected Google location when present;
- geo warnings;
- Google observation/detected-location coverage.

CPC/geography are signals, not proof that monetization is viable.

### G. Product feasibility

The runner has no trustworthy automated product-feasibility measurement in V2.1.

Required output:

```text
automatedAssessment = null
```

The block explicitly requires human review. SEO/page proxies must not be converted into implementation-feasibility claims.

## Human decisions

Human decisions are a separate layer from evidence.

Accepted build decision:

```text
build | watch | reject | unknown
```

Accepted SEO/product role:

```text
acquisition_anchor
strong_supporting_tool
completeness_tool
experimental
not_applicable
```

`null` means no decision was recorded.

`"unknown"` is an explicit human decision and is not equivalent to `null`.

The optional `--decisions <json>` input is a strict JSON array of:

```json
{
  "clusterId": "cluster-1",
  "buildDecision": "watch",
  "seoProductRole": "strong_supporting_tool"
}
```

Unknown fields, duplicate cluster ids, invalid enums and decisions outside the current finalist scope are rejected before publication/DB mutation.

An explicit `[]` replaces the current decision snapshot with no recorded decisions.

## Decision generation pinning

A persisted human decision records:

```text
representative revision
entrant fingerprint
updated timestamp
```

When upstream evidence changes, the old decision row is not silently reinterpreted as a decision on new evidence.

For a still-current cluster:

```text
same revision + same entrant fingerprint
→ evidenceCurrent = true

otherwise
→ evidenceCurrent = false
→ HUMAN_DECISION_STALE
```

A persisted decision whose cluster is no longer a current finalist is exposed separately as a retired human decision rather than blocking the current matrix projection.

## Audit flags

Audit flags describe evidence state. They are not a verdict or score.

Current flags include incomplete/missing demand, cohesion, DR, traffic policy/target state, cohort history, site structure, CPC/geo evidence, product-feasibility review requirement, and human-decision state.

The existence or count of flags must never be converted automatically into a finalist opportunity score.

## Persistence

Human decisions use a feature-owned lazy schema in the existing `enrichment.sqlite`.

The core `RunStore` schema version remains unchanged.

A decision replacement is validated against the current representative + entrant parent before the transaction deletes/replaces decision rows. An invalid replacement must not erase the previous valid snapshot.

Changing entrant evidence does not delete the historical decision row; the generation metadata makes its stale state visible to the matrix projector.

## Source generation

PR-09 requires:

- completed enrichment;
- current persisted representative-query state;
- current persisted entrant-cohort state;
- equal representative revision between those parents;
- completed frozen discovery source run;
- discovery `updatedAt` equal to the entrant snapshot’s source generation.

If the source run changed after the entrant snapshot, PR-09 fails closed and requires upstream rebuild.

## Optional evidence

Cohort history, traffic and site structure remain optional evidence sources.

Missing optional evidence is represented explicitly:

- history projection: `null` + audit flag;
- no traffic policy/imports: no fabricated traffic proof;
- site-structure module absent: zero observed coverage + explicit not-collected flag.

Unknowns are not converted into zeros that imply failure.

## CLI mutation order

Normal matrix rerun:

```text
resolve completed enrichment
→ load/pin representative + entrant generation
→ verify frozen discovery generation
→ load source run-quality / keywords
→ load optional history / traffic / site-structure facts
→ load existing human decisions
→ build matrix
→ preflight public representative + entrant parent
→ write matrix CSV/JSON
→ publish manifest/status metadata
→ rebuild results.zip
```

With `--decisions`:

```text
parse strict decisions JSON
→ validate current finalist scope
→ stage generation-pinned decisions in memory
→ build matrix preflight
→ public-parent preflight
→ invalidate old matrix publication
→ replace decision rows
→ rebuild matrix from persisted decisions
→ public-parent preflight again
→ write/publish/archive
```

Invalid decision input must fail before old publication or DB decisions are mutated.

If a later output/publication step fails after a valid decision replacement, the old matrix remains unadvertised; a rerun can rebuild from durable decision/evidence state.

## Publication

PR-09 publishes:

```text
finalist-evidence-matrix.csv
finalist-evidence-matrix.json
```

The JSON artifact carries exact enrichment/source ids, representative revision, entrant fingerprint, source run quality, independent evidence blocks, human decisions, retired/stale decision state and audit flags.

The CSV is a flattened human-review surface. Every coverage field that can be misread without a denominator exposes numerator, denominator and ratio. Warning columns preserve evidence caveats in the tabular export.

## Publication parent gate

Before advertising matrix artifacts, manifest/status and `entrant-cohort.json` must agree with:

```text
enrichment id
source run id
representative revision
entrant representative revision
entrant fingerprint
completed enrichment publication
```

A stale/mismatched parent fails before matrix metadata is published.

## Transitive invalidation

A published finalist matrix is downstream of representative, entrant, history, traffic and human-decision generations.

Required behavior:

- representative drift invalidates entrant/history/traffic/matrix publication as applicable;
- changed entrant cohort invalidates history/traffic/matrix publication while preserving append-only raw traffic imports and historical human decision rows;
- changed cohort-history projection invalidates the matrix;
- changed traffic imports/policy invalidate the matrix;
- explicit decision replacement invalidates the matrix before DB mutation;
- unchanged upstream evidence does not invalidate the matrix unnecessarily.

Invalidation removes:

- `finalistEvidence` metadata from manifest/status;
- finalist artifact names from manifest/status;
- stale finalist matrix files from disk.

## ZIP gating

`results.zip` treats finalist matrix files as manifest-gated enrichment artifacts.

A stale orphan `finalist-evidence-matrix.csv/json` on disk must not enter the archive unless the local enrichment manifest advertises it.

## Score boundary

Existing Score v1 remains a broad-discovery priority signal.

PR-09 does not:

- replace Score v1;
- combine A–G into another score;
- calculate launch-success probability;
- infer BUILD/WATCH/KILL;
- infer product feasibility;
- treat missing evidence as a penalty.

## Done when

PR-09 is complete when:

- A–G are independently inspectable;
- denominators/warnings survive publication;
- no opaque finalist score exists;
- human decisions are explicit, generation-pinned and distinct from evidence;
- optional evidence remains honestly missing when unavailable;
- parent validation and downstream invalidation are fail-closed;
- stale matrix files cannot leak into `results.zip`;
- regression tests cover projector semantics, decision persistence, publication lifecycle and ZIP gating.
