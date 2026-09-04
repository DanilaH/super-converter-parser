# Representative Queries Acceptance — V2.1 PR-05

## Status

Implementation contract for V2.1 PR-05 (`representative query set per finalist cluster`).

This document describes the behavior implemented on `feat/v2-1-representative-queries`. It does not redefine PR-06 entrant-cohort scoring or any later finalist evidence model.

## Scope

PR-05 derives a small, explicit, versioned query set from clustering-v2 evidence so downstream entrant analysis does not depend on one canonical/head keyword.

Representative queries are generated only from completed clustering `2.0.0` data with URL identity `1.0.0` and `complete_link` grouping. Historical clustering remains readable but is not silently retrofitted.

Finalist scope is explicit:

- first run requires `--clusters <comma-separated ids>` or `--all-clusters`;
- `--all-clusters` is an explicit operator decision, not the default;
- the resolved concrete `selectedClusterIds` are persisted;
- later reruns inherit persisted scope unless the operator explicitly changes it;
- unknown/deleted cluster ids fail loudly.

This prevents PR-06 from accidentally treating every broad-discovery cluster as a finalist cohort.

## Selection contract

Representative query set version: `1.0.0`.

Automatic selection is deterministic and intentionally avoids an opaque composite score:

1. **Overlap medoid** — maximize summed intra-cluster URL Jaccard; use summed domain Jaccard as the next tie-break; then source `keyword_idx`.
2. **High-demand distinct representative** — choose the highest real non-null volume among remaining normalized-query-distinct members; tie-break on source `keyword_idx`.
3. **Coverage expansion** — greedily choose the remaining member adding the most previously uncovered normalized top-N ranking URLs; tie-break on source `keyword_idx`.
4. Normalized query duplicates are deferred while a distinct member remains.
5. The default automatic target is **5** representatives, bounded by cluster size. The CLI permits an explicit target in `[3, 10]`.

The default of 5 is an implementation decision inside the roadmap's stated normal range of 3–10. It keeps PR-06 entrant collection bounded while retaining more than a minimal three-query view. It is versioned/configurable rather than a hidden scoring constant.

Clustering top-N semantics are reused: representative coverage is built from the same raw ranked top-N window and the same conservative URL identity used by clustering v2.

## Manual override contract

Manual override JSON is a strict array of:

```json
[
  {
    "clusterId": "cluster-1",
    "keywordIds": [17, 20],
    "reason": "human-reviewed intent coverage"
  }
]
```

Rules:

- cluster id must exist inside the selected finalist scope;
- every keyword id must be a member of that cluster;
- keyword ids must be unique and preserve the explicit operator order;
- reason is mandatory and non-empty;
- an explicit `[]` clears previously persisted manual overrides;
- manual selection does not bypass missing/corrupt clustering-v2 evidence checks;
- the published effective target for a manual set equals the explicit override size.

## Evidence-integrity failures

PR-05 fails loudly rather than manufacturing zero evidence when:

- a cluster member has no durable source keyword identity;
- source organic SERP rows required to reconstruct the member's evidence are missing;
- any intra-cluster clustering-v2 pair row is missing URL/domain Jaccard evidence;
- duplicate cluster ids, member ids or pair identities are encountered;
- a manual override references an unknown cluster or non-member keyword;
- the source discovery run is no longer `completed`;
- the source discovery run was modified after the completed `clusters` checkpoint.

The last guard prevents a repaired/reopened discovery run from mixing newer SERP rows with an older persisted clustering snapshot. If source `updatedAt` is newer than the completed clusters item's `updatedAt`, clustering enrichment must be rerun before representative queries are rebuilt.

Missing evidence is not treated as Jaccard `0` or URL coverage `0` merely to complete a representative set.

## Persistence and revision history

Representative data lives in the existing `enrichment.sqlite` as a feature-owned extension schema; `RunStore` core schema version is not bumped.

Durable state includes:

- enrichment id;
- selected finalist cluster ids;
- target count;
- set version;
- representative keyword ids;
- per-query selection reason and coverage gain;
- URL coverage numerator/denominator;
- manual override flag/reason;
- current revision;
- append-only full snapshot history.

Revision behavior:

- first successful snapshot is revision `1`;
- an identical rerun does not create a new revision;
- a changed representative set, finalist scope, override or selection config creates the next revision;
- prior full snapshots remain available for audit.

## Published artifacts

PR-05 publishes:

```text
representative-queries.csv
representative-queries.json
```

and adds them to existing enrichment `manifest.json`, `status.json`, and `results.zip` publication.

Artifacts expose:

- current revision and whether this invocation changed durable state;
- selected finalist scope in JSON/manifest config;
- representative ids and display keywords;
- selection reasons;
- per-query coverage gains;
- covered URL count and total cluster URL count;
- coverage percent only when the denominator is non-zero;
- manual override state/reason;
- previous representative ids and per-set semantic drift when a prior revision exists.

A zero URL denominator is serialized as missing coverage percent (`null` JSON / blank CSV), not a fake `0%` observation.

## Frozen-corpus evidence

The sanitized Hardware/Audio targeted corpus is reused as a method regression fixture.

For the clustering-v2 strong cluster containing source keyword ids `17` (`speaker test`) and `20` (`audio test`):

- `speaker test` is selected first as the deterministic overlap medoid (two-member centrality tie resolves on source keyword idx);
- `audio test` is selected second as the distinct higher-demand query (`14800` volume in the frozen observation);
- the two-query set covers the complete normalized URL union for that cluster.

This is a regression assertion over frozen evidence, not threshold tuning against a new live run.

## Explicit non-goals

PR-05 does **not**:

- construct entrant cohorts;
- deduplicate or score competitor domains for launch viability;
- add RDAP/first-seen cohort projections;
- infer success probabilities;
- change clustering thresholds or canonical-keyword selection;
- start PR-06 work.
