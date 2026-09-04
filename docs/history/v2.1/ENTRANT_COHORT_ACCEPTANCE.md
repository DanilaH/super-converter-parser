# Entrant Cohort Acceptance — V2.1 PR-06

## Status

Implementation contract for V2.1 PR-06 (`entrant cohort`).

This document describes the descriptive cohort evidence implemented on `feat/v2-1-entrant-cohort`. It does not define RDAP/first-seen cohort history, traffic evidence, a finalist score, or a BUILD/WATCH/KILL decision.

## Scope

PR-06 builds one observed registrable-domain cohort per **finalist cluster** from the persisted PR-05 representative-query set.

The parent representative snapshot is mandatory. The cohort snapshot pins the exact representative revision and source/clustering evidence generation used to build it.

The cohort is observational:

```text
representative queries
→ persisted organic top-10 ranking rows
→ every ranking occurrence
→ registrable-domain cohort
→ transparent descriptive evidence
```

It is not a sample of all sites that attempted to rank. Domains that failed to reach the observed top 10 are unavailable to this evidence.

Every cohort therefore publishes the survivorship warning:

```text
Observed entrant cohorts contain only domains currently visible in representative-query top-10 SERPs; non-ranking attempts and failed entrants are not observed.
```

Observed competitor success must never be transformed into a launch-success probability.

## Ranking-window contract

Entrant cohort version: `1.0.0`.

The ranking window is fixed at organic top 10 per representative query.

Order of operations is mandatory:

1. read persisted organic SERP rows for a representative keyword;
2. sort by ranking position;
3. take the raw top-10 window;
4. preserve every selected ranking occurrence;
5. only then aggregate/deduplicate by registrable domain.

Repeated domains or pages inside the raw top 10 do not cause lower-ranked rows to move into the cohort window.

A representative keyword with no durable organic source SERP rows fails loudly rather than becoming a synthetic empty cohort.

## Occurrence truth

Each included occurrence preserves at least:

```text
keyword_idx
position
ranking_url
registrable_domain
normalized_page_identity
dr
```

The raw ranking URL is retained even when URL normalization succeeds.

A top-10 row without a usable persisted registrable domain is not silently discarded. It is retained in the occurrence artifact as an explicit exclusion with reason:

```text
no_registrable_domain
```

Domain aggregation therefore exposes both:

- observed included occurrence count;
- excluded occurrence count.

## Domain identity

Cohort entity identity is the persisted registrable-domain identity produced by the discovery pipeline's shared domain-normalization contract.

PR-06 does not introduce a second domain identity or semantic site-classification system.

Every included occurrence belongs to exactly one domain projection, while the original occurrence rows remain available for audit.

## Domain evidence

For each registrable domain PR-06 derives descriptive evidence including:

- `bestRank` — best observed rank across all representative-query occurrences;
- `medianRank` — median over all preserved ranking occurrences;
- `queryIdsPresent`;
- query coverage;
- raw ranking URL set;
- normalized page identity set;
- page-identity coverage;
- same-page repetition across representative queries;
- same-domain/different-page repetition across representative queries;
- DR evidence status and coverage.

### Query coverage

```text
numerator   = distinct representative queries where the domain appears
denominator = full representative-query set size for the finalist cluster
ratio       = numerator / denominator
```

The denominator is not the number of observed domain occurrences.

### Page identity

Page comparison reuses clustering-v2 URL identity `1.0.0`.

The raw ranking URL remains source evidence. URL identity is only the comparison key.

Page identity coverage is explicit:

```text
numerator   = domain occurrences with a usable normalized page identity
denominator = all observed occurrences for that domain
```

Cluster summary also exposes normalized occurrence coverage over all included occurrences.

This matters because an unnormalizable URL must not make `samePageRepetition=false` look like complete negative evidence.

### Same-page repetition

A domain has same-page repetition when the same normalized ranking page is observed for at least two representative queries.

Published evidence includes:

- boolean observation;
- count of repeated normalized pages;
- maximum representative-query count for one normalized page.

### Same-domain/different-page repetition

A domain has different-page repetition when:

- it appears for at least two representative queries; and
- at least two distinct normalized page identities are observed.

The distinct normalized-page count is published alongside the boolean.

## DR / weak-domain evidence

PR-06 reuses the persisted discovery-run DR threshold snapshot. It does **not** read current environment thresholds when rebuilding an old cohort.

The existing weak boundary remains:

```text
DR < weakMax
```

With default scoring thresholds this means very-weak plus weak domains (`DR < 30`).

This is descriptive evidence only. It does not filter domains out of the cohort and does not create a new opportunity score.

DR state per domain is explicit:

- `known` — exactly one consistent known DR value is observed;
- `missing` — no numeric DR observation exists;
- `conflict` — multiple different known DR values are present for the same persisted domain evidence.

Missing DR never becomes `0`.

A conflict is not averaged or arbitrarily resolved. It is published separately and excluded from the weak-domain denominator.

Weak-domain coverage is therefore:

```text
numerator   = domains with one trusted known DR below weakMax
denominator = domains with one trusted known DR
```

Missing and conflicting DR domains remain separately counted.

## Persistence and parent identity

The current cohort snapshot lives in the existing `enrichment.sqlite` through a feature-owned extension schema. Core `RunStore` schema version is unchanged.

The durable snapshot pins:

- enrichment id;
- source run id;
- representative revision;
- cohort version;
- top-N contract;
- persisted DR thresholds;
- source-run `updatedAt`;
- clustering checkpoint `updatedAt`;
- complete per-cluster cohort evidence.

Persistence rejects a cohort when:

- the owning enrichment does not exist;
- its source run id differs from the enrichment source run;
- no current representative snapshot exists;
- representative revision differs from the current parent revision;
- finalist cluster set or representative keyword ids differ from the parent;
- occurrence/domain projections or published denominators are internally inconsistent.

PR-06 stores the current deterministic cohort snapshot rather than creating a second independent history model. PR-05 already preserves representative revisions; the cohort snapshot explicitly records which current parent revision it belongs to.

## Evidence-generation freshness

PR-06 inherits the PR-05 source-generation guard.

The discovery source run must be completed and its `updatedAt` must not be newer than the completed clustering checkpoint used by the representative evidence.

If the discovery run is repaired or otherwise mutated after clustering, cohort construction fails loudly instead of combining new SERP rows with old clustering/representative evidence.

The operator must rebuild the upstream evidence chain first.

## Downstream invalidation

Entrant evidence is invalid when its parent representative snapshot changes.

Two surfaces are invalidated:

### SQLite truth

After an entrant snapshot exists, a real change to the persisted representative snapshot deletes the current entrant snapshot in the same SQLite transaction via a feature-owned trigger.

An identical representative rerun does not invalidate the cohort.

### Published artifacts

When representative publication advances to a revision different from the published entrant revision:

- `entrantCohort` metadata is removed from `manifest.json` and `status.json`;
- entrant artifact names are removed from both artifact lists;
- reserved entrant artifact files are deleted;
- `results.zip` is rebuilt by the representative workflow without stale cohort files.

A same-revision representative publication preserves the current cohort publication.

## Published artifacts

PR-06 publishes:

```text
entrant-cohort.csv
entrant-cohort-occurrences.csv
entrant-cohort.json
```

The domain CSV exposes per-domain rank, query coverage numerator/denominator, page-identity numerator/denominator, repetition evidence, DR state, DR occurrence coverage and weak classification.

The occurrence CSV preserves every included and explicitly excluded raw top-10 occurrence.

The JSON pins parent/source provenance and contains the complete cohort summaries and survivorship warning.

The artifacts are added to enrichment `manifest.json`, `status.json`, and the research `results.zip`.

## Frozen Hardware/Audio regression

The sanitized targeted Hardware/Audio corpus is reused as a method regression fixture rather than a threshold-tuning source.

For the representative set:

```text
17  speaker test
20  audio test
```

frozen evidence contains:

- 18 organic ranking occurrences;
- 12 unique registrable domains;
- 4 domains appearing across both representative queries;
- 3 same-page repeated domains: `onlinemictest.com`, `audiocheck.net`, `soundtest.io`;
- YouTube as a repeated domain using different ranking pages;
- 2 weak domains out of 12 domains with known DR under the frozen threshold contract.

These assertions lock the descriptive method against known evidence. They do not optimize thresholds for the fixture.

## Explicit non-goals

PR-06 does **not**:

- classify or filter cohort membership by domain age;
- publish a `young` count without RDAP/first-seen evidence;
- integrate cohort history — that is PR-07;
- add traffic estimates — that is later V2.1 work;
- infer failed entrants that are absent from the observed SERPs;
- calculate launch-success probability;
- decide BUILD / WATCH / KILL;
- introduce a new composite opportunity score;
- change PR-04 clustering thresholds or PR-05 representative-selection semantics.
