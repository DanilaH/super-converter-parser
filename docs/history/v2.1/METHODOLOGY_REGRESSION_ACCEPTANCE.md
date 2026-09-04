# Methodology Regression Acceptance — V2.1 PR-10

## Status

Implementation and review contract for V2.1 PR-10 (`methodology regression`).

PR-10 is a deterministic regression proof over the frozen Hardware/Audio corpus. It does not add a new research provider, scoring model, dashboard, runtime service, or live-data dependency.

## Purpose

The regression must answer one question:

> Can every material V1 → V2 analytical change be traced to explicit preserved evidence and the documented V2 methodology, without turning missing evidence into a negative conclusion?

A changed conclusion is not automatically a regression.

A methodology regression exists when an analytical/output change:

- cannot be traced to explicit pair/cohort/source evidence;
- violates a documented truth invariant;
- silently changes evidence scope or denominator;
- converts missing/unavailable evidence into zero/false/negative proof;
- introduces a conclusion stronger than the frozen evidence supports.

## Frozen source

Use only:

```text
src/enrichment/fixtures/hardware-audio-v1/manifest.json
src/enrichment/fixtures/hardware-audio-v1/initial.json
src/enrichment/fixtures/hardware-audio-v1/residual-round-3.json
src/enrichment/fixtures/hardware-audio-v1/targeted-round-2.json
```

The corpus is immutable regression evidence. PR-10 must not modify fixture facts merely to make V2 output pass.

No live Google, Keyword Surfer, Ahrefs, RDAP, Wayback, traffic provider, browser or network request is required.

## Required production path

The regression must call the production projectors used by V2.1 rather than reimplementing their analytical rules inside the test:

```text
frozen top-10 URL/domain evidence
→ clustering v2
→ representative query selection
→ entrant cohort
→ cohort-history projection where frozen history exists
→ finalist evidence matrix
```

V1 cluster membership is the frozen comparison baseline. Existing fixture tests may separately prove that the frozen V1 baseline is reproducible from raw domain evidence.

## Required V1 → V2 diff

The regression must cover:

1. cluster splits/merges;
2. representative query sets;
3. entrant repetition;
4. history coverage;
5. traffic/intent evidence where available;
6. warnings / missing-evidence semantics;
7. finalist A–G human-review surface.

## Clustering acceptance

Across the three frozen runs:

```text
V1 clusters = 22
V2 clusters = 23
```

Exactly one V1 cluster changes partition:

```text
initial: [mouse scroll test, double click test]
→ two V2 singleton clusters
```

The change must be traceable to production pair evidence:

```text
shared domains = 5
union domains = 14
classification = domain_only
shared URLs = 1
```

The regression must not describe the split as a quality improvement without evidence. It is specifically the consequence of V2 requiring URL evidence in addition to the old domain edge.

The frozen Audio pair must remain a V2 cluster:

```text
speaker test + audio test
classification = strong
shared domains = 4 / union 12
shared URLs = 3
```

No unexplained new cross-V1 merge is allowed.

## Representative acceptance

The split initial queries become separate singleton representative sets.

The retained Audio cluster must select:

```text
speaker test → medoid
audio test → high_demand
representative ids = [17, 20]
cluster URL coverage = 15 / 15
```

No synonym-volume summation is introduced.

## Entrant acceptance

For the Audio representatives, the production cohort must preserve:

```text
observed occurrences = 18
unique domains = 12
known-DR domains = 12
weak domains = 2 / 12
repeated domains = 4 / 12
same-page repeated domains = 3
different-page repeated domains = 1
```

The survivorship warning remains conceptually binding: observed top-10 entrants are not launch attempts and do not imply success probability.

## History acceptance

The frozen targeted fixture contains selected history facts for four current Audio cohort domains.

Required projection:

```text
checked = 4 / 12
unobserved = 8 / 12
registration age known = 3
young = 0 / 3
first-seen age known = 0
recent-web-presence coverage = 0 / 0 = null
```

The eight unobserved domains cannot be counted as old/not-young.

The zero first-seen denominator cannot become a numeric `0%` claim.

## Traffic acceptance

The frozen corpus contains no PR-08 provider-neutral traffic snapshots.

Required finalist semantics:

```text
importedSnapshotCount = 0
projectionAvailable = false
matchedSnapshotCount = null
```

Forbidden interpretations:

```text
competitor traffic = 0
traffic proof = negative
page traffic inferred from domain traffic
TRAFFIC_TARGET_MISMATCH fabricated without an import
```

## Site-structure / moat acceptance

The frozen PR-10 corpus does not contain sufficient finalist-scoped site-structure evidence to automate a moat assessment.

Required behavior:

```text
siteStructureModuleIncluded = false
SITE_STRUCTURE_NOT_COLLECTED
```

No strong/weak moat verdict is inferred.

## Monetization / geo acceptance

The frozen Audio representatives preserve CPC:

```text
0.54
2.48
coverage = 2 / 2
median = 1.51
```

The corpus preserves market `US`, but does not preserve enough source-specific physical-location evidence to verify Google physical geo for PR-10.

The regression must not reconstruct or assume a physical location from `US` market metadata.

## Product-feasibility acceptance

Required:

```text
automatedAssessment = null
PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW
```

No SEO proxy may become an implementation-feasibility verdict.

## Human-decision acceptance

The frozen corpus does not carry a generation-pinned PR-09 decision.

Required:

```text
buildDecision = null
seoProductRole = null
recordedAt = null
evidenceCurrent = null
HUMAN_DECISION_UNRECORDED
```

This is distinct from explicit `buildDecision = unknown`.

## Required human-readable report

`METHODOLOGY_REGRESSION_REPORT.md` must summarize the same deterministic evidence as the regression test without overstating execution status.

Before CI runs, the report may state that analytical/static review found no unexplained regression, but it must not claim the automated suite is green.

## Verification

Required automated regression:

```text
src/enrichment/methodologyRegression.corpus.test.ts
```

Repository completion gate remains:

```text
npm run typecheck
npm test
Ubuntu CI
Windows CI
```

Infrastructure-blocked or absent Actions runs are not PASS.

## Explicit non-goals

PR-10 does not:

- retune clustering thresholds;
- modify frozen corpus facts;
- add a new score or finalist probability;
- add live provider calls;
- collect new traffic evidence;
- invent missing site-structure evidence;
- infer physical geo from target market;
- assign a BUILD/WATCH/REJECT decision;
- change product feasibility into an automated metric;
- add a generic methodology framework or rule DSL.
