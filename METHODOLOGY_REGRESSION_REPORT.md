# V2.1 Methodology Regression — Hardware / Audio Frozen Corpus

## Status

Deterministic PR-10 regression baseline over the frozen Hardware/Audio corpus.

**Analytical review:** no unexplained methodology regression found.  
**Automated execution:** pending repository CI; do not treat this document as a substitute for Ubuntu + Windows test execution.

This report compares the frozen V1 evidence with the V2.1 production projectors. A changed conclusion is not automatically a regression. A regression means a change that cannot be traced to explicit pair/cohort/source evidence or that violates a documented truth invariant.

## Frozen basis

Corpus: `src/enrichment/fixtures/hardware-audio-v1/`

The retained fixture contains three historical runs:

| Run | Observations | V1 clusters | V1 edges | Selected history facts |
| --- | ---: | ---: | ---: | ---: |
| `initial` | 12 | 11 | 1 | 5 |
| `residual_round_3` | 7 | 7 | 0 | 4 |
| `targeted_round_2` | 5 | 4 | 1 | 4 |
| **Total** | **24** | **22** | **2** | **13** |

The regression uses the preserved raw top-10 URLs/domains/positions, volume/CPC and DR values. It does not call Google, Surfer, Ahrefs, RDAP, Wayback or another live provider.

## 1. Clustering: one explainable split, no new merge

V2 produces **23 clusters instead of 22** across the three runs.

There is exactly one partition change:

```text
V1 initial:
mouse scroll test + double click test

V2 initial:
mouse scroll test

double click test
```

The old V1 edge was supported by domain overlap:

```text
shared domains = 5
union domains = 14
domain Jaccard = 5 / 14 ≈ 0.357
```

V2 keeps that fact but classifies the pair as `domain_only` because only **1 normalized ranking URL** is shared. The V2 strong-edge gate requires at least 2 shared URLs as well as the domain evidence. The split therefore follows directly from explicit pair evidence; it is not an unexplained threshold drift.

The important Audio pair remains merged:

```text
speaker test + audio test
shared domains = 4
union domains = 12
shared URLs = 3
classification = strong
```

`residual_round_3` remains seven singleton clusters. No V1 clusters are newly merged by V2.

## 2. Representative query sets

The V2 split is carried forward explicitly rather than hidden downstream:

```text
mouse scroll test singleton → representative [mouse scroll test]
double click test singleton → representative [double click test]
```

For the retained Audio cluster, the production representative selector returns:

```text
speaker test → medoid
audio test   → high_demand
```

Representative ids:

```text
[17, 20]
```

Coverage:

```text
cluster URL identities = 15
covered URL identities = 15
coverage = 15 / 15
```

The higher-demand representative keeps its preserved Surfer volume of `14,800`; the medoid has `9,900`.

## 3. Entrant repeatability

Running the production entrant-cohort projector over the two Audio representatives produces:

```text
observed ranking occurrences = 18
unique entrant domains = 12
DR-known domains = 12
weak domains = 2 / 12
repeated domains = 4 / 12
same-page repeated domains = 3
different-page repeated domains = 1
```

Three domains repeat on the same normalized page across both queries:

```text
onlinemictest.com
audiocheck.net
soundtest.io
```

`youtube.com` repeats across both queries but on different pages. This distinction is preserved instead of collapsing all domain repetition into one binary signal.

The cohort still carries the survivorship limitation: these are observed top-10 winners, not failed entrants or launch-success observations.

## 4. History coverage

The frozen targeted fixture preserved selected history facts for only four of the twelve current Audio cohort domains:

```text
checked = 4 / 12
unobserved = 8 / 12
```

Within the four checked domains:

```text
registration age known = 3
known-young domains = 0 / 3
first-seen age known = 0
recent-web-presence ratio = 0 / 0 → null
comparable registration/first-seen histories = 0
```

The correct interpretation is **incomplete evidence**, not “eight old domains” and not “no recent domains”. In particular, the missing first-seen denominator remains zero and its ratio remains `null` rather than `0`.

## 5. Traffic / intent evidence

The frozen Hardware/Audio corpus predates PR-08 and contains **no provider-neutral traffic snapshots**.

PR-10 therefore records:

```text
imported traffic snapshots = 0
current traffic projection = unavailable
matched traffic snapshots = null
velocity evidence = unavailable
```

This is an evidence gap, not zero competitor traffic and not negative opportunity evidence. No domain-level value is fabricated into page-level traffic evidence.

## 6. Finalist A–G human-review surface

The production PR-09 finalist projector is exercised for the retained `speaker test + audio test` cluster.

### A. Demand

```text
representative volume coverage = 2 / 2
min = 9,900
median = 12,350
max = 14,800
```

Volumes are not summed into fake cluster demand.

### B. SERP accessibility

```text
entrant domains = 12
weak-domain coverage = 2 / 12
repeated-domain coverage = 4 / 12
```

DR and repetition remain descriptive evidence, not an automatic verdict.

### C. Organic traffic proof

```text
imports = 0
projection available = false
matched snapshots = null
```

No missing traffic becomes zero.

### D. Entrant repeatability

```text
repeated domains = 4 / 12
history checked = 4 / 12
```

The matrix exposes the incomplete history denominator.

### E. Moat

The frozen corpus does not preserve finalist-scoped site-structure evidence for this regression. The block remains uncollected and carries `SITE_STRUCTURE_NOT_COLLECTED`; it is not converted into a weak or strong moat verdict.

### F. Monetization / geography

Preserved CPC evidence:

```text
speaker test = 0.54
audio test = 2.48
CPC coverage = 2 / 2
median CPC = 1.51
```

The frozen fixture preserves target market `US` but not the source-specific detected physical Google location. Physical geo verification is therefore not reconstructed from memory or guessed from `US` market metadata.

### G. Product feasibility

```text
automatedAssessment = null
```

The runner does not infer implementation feasibility from SEO/page proxies.

## 7. Human decision state

The frozen corpus contains no generation-pinned PR-09 human decision.

The regression therefore preserves:

```text
build decision = null
SEO/product role = null
evidenceCurrent = null
```

This remains distinct from an explicit human `unknown` decision.

## 8. Expected audit warnings

The retained finalist surface must expose at least:

```text
COHORT_HISTORY_INCOMPLETE
SITE_STRUCTURE_NOT_COLLECTED
PRODUCT_FEASIBILITY_REQUIRES_HUMAN_REVIEW
HUMAN_DECISION_UNRECORDED
```

It must **not** invent `TRAFFIC_TARGET_MISMATCH` when no traffic evidence exists.

## Conclusion

The frozen corpus shows one material V1 → V2 cluster change, and that change is traceable to the intended V2 distinction between domain overlap and URL overlap. The retained Audio conclusion survives the stricter clustering rule and gains explicit representative, entrant-repetition, history-coverage and finalist-evidence surfaces.

No frozen evidence supports an automatic BUILD/KILL verdict, success probability, traffic conclusion, moat verdict, physical-geo verification or product-feasibility verdict. PR-10 treats those gaps as gaps.
