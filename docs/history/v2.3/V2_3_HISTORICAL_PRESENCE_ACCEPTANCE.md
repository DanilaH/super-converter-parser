# V2.3 Historical Presence Acceptance

**Scope:** post-V2.2 Common Crawl sampled historical-presence productionization  
**Acceptance date:** 2026-09-01  
**Operator transport smoke:** PASS  
**Engineering integration:** PASS  
**Integrated finalist-cohort operator acceptance:** PASS  
**Overall status:** ACCEPTED

This document keeps three different claims separate:

1. Common Crawl can be reached from the real operator environment under the bounded client policy;
2. the production transport, cache, cohort lifecycle, status projection, finalist evidence integration, and invalidation contracts pass deterministic cross-platform engineering gates;
3. the complete merged `finalize:full` path has been exercised on a real finalist cohort and inspected end to end.

All three claims are now demonstrated. Claim 3 was established by the integrated operator-machine acceptance recorded in section 5.

## 1. Why this exists separately from V2.2

`V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md` correctly recorded `DEFER historical provider` for the V2.2 release because the original Common Crawl evidence came from GitHub-hosted runners rather than the operator environment.

After V2.2 release acceptance, a dedicated operator-machine Common Crawl smoke was performed before productionization PR #95. That smoke established legitimate operator-environment access:

```text
latest mode: 7/8 domains observed
annual mode: 7/8 domains observed across 24 selected collections
403 responses: 0
429 responses: 0
5xx responses: 0
network failures: 0
```

That smoke was an access/bounded-behavior gate. It was not the later integrated finalist-cohort acceptance described in section 5.

## 2. Engineering implementation

### PR #95 — production Common Crawl evidence client

Merged commit:

```text
200849e06a2d57b2352897e3c3c73368fd18a5e6
```

Implemented:

- explicit sampled historical-presence contract;
- official Common Crawl collection/index endpoints;
- bounded `latest` / `annual` collection selection;
- domain-scoped CDX lookup;
- `ok` / `not_found` / `unavailable` / `not_attempted` / `error` semantics;
- separate provider HTTP and archived-page HTTP evidence;
- rate limiting, retry/backoff and circuit behavior;
- isolated durable cache with provider/query identity;
- no `firstSeenDate` aliasing and no Wayback fallback.

Exact-head CI:

```text
workflow 33419836472 / run #421
head 8196f19b89551a5c99ae6ea09159373565dd1c7f
Ubuntu: PASS
Windows: PASS
npm ci: PASS
strict typecheck: PASS
full test suite: PASS
```

### PR #96 — finalist-cohort sampled-presence lifecycle

Merged commit:

```text
ce6c58ffae5b1a5e9c44806df56bb8062b049822
```

Implemented:

- deterministic entrant-domain prioritization;
- explicit domain-cap omissions;
- provider/query-aware cache reuse and refresh;
- immutable sampled-presence snapshot parented to the entrant-cohort fingerprint;
- DB invalidation on entrant-cohort change;
- `cohort-historical-presence.csv` and `.json`;
- manifest/status metadata with semantics `bounded_sampled_web_presence_not_exact_first_seen`;
- standalone `cohort-historical-presence` command;
- filesystem publication invalidation so stale sampled artifacts cannot survive an entrant-parent change.

Cold review found and fixed two issues before merge:

- the first integration fixture used an invalid representative target count and was corrected to obey the existing 3–10 contract;
- DB invalidation initially did not remove already-published sampled metadata/artifacts; publication invalidation was extended to fail closed across DB + manifest/status + files.

The sampled CSV was also routed through the existing shared CSV renderer so spreadsheet-formula neutralization stays consistent with other runner exports.

Exact-head CI:

```text
workflow 33422153977 / run #428
head 6768612d843bcba9a3969eef12074dc29c4f9021
Ubuntu: PASS
Windows: PASS
npm ci: PASS
strict typecheck: PASS
full test suite: PASS
```

### PR #97 — integrated finalization/status/finalist evidence

Merged commit:

```text
c1add2026f9b55c89a480f11490184b77b5017fc
```

Implemented:

```text
representatives
  -> entrant cohort
  -> bounded sampled historical presence
  -> existing cohort history
  -> optional/reused traffic
  -> finalist evidence
  -> optional Library publication
```

Additional contracts:

- `research:status` v1.2 exposes sampled history separately from existing RDAP/first-seen coverage;
- finalist JSON contains a separate `sampledHistoricalPresence` factual block;
- finalist CSV adds explicit sampled-history columns while retaining existing cohort-history columns;
- sampled history never feeds an automatic BUILD/WATCH/REJECT decision;
- Common Crawl timestamps never become `FirstSeenResult.firstSeenDate`;
- changed sampled publication invalidates stale finalist matrix publication before sampled metadata is republished;
- publication order is validate parent -> invalidate dependent finalist publication -> reload publication context -> publish sampled metadata;
- `not_found`, `omitted`, `not_attempted`, `unavailable`, `error`, and incomplete selected-collection traversal remain distinct.

Cold review found and fixed two semantic/invalidation issues before merge:

1. stale finalist metadata could have been reintroduced from an in-memory pre-invalidation manifest; publication now reloads context after invalidation;
2. `not_attempted` was initially described as unobserved while still contributing to checked coverage. It is now excluded from checked coverage and counted as unobserved in the finalist projection, with regression coverage.

Exact-head CI:

```text
workflow 33424493378 / run #436
head 75f07894619485534122c77317e83cd1276de13c
Ubuntu: PASS
Windows: PASS
npm ci: PASS
strict typecheck: PASS
full test suite: PASS
```

## 3. Evidence semantics that remain mandatory

Common Crawl evidence means:

```text
bounded sampled web presence
```

It does **not** mean:

```text
exact first-ever web presence
exact site age
proof that a domain did not exist when no capture is found
proof that an omitted/unavailable/error/not_attempted domain had no historical presence
```

Therefore:

- `not_found` means no capture was observed in the selected Common Crawl collections under the configured bounded traversal;
- `not_attempted` is unobserved and does not count as checked coverage;
- domain-cap omission is explicit missing evidence;
- provider unavailable/error states remain explicit uncertainty;
- an `ok` capture with incomplete earlier selected-collection checks is surfaced as incomplete sampled history;
- existing RDAP registration and Wayback-style first-seen semantics are not rewritten by Common Crawl.

## 4. What engineering acceptance proves

The merged implementation is defensible at the code-contract level:

- immutable parent identity is checked on load;
- stale sampled state fails closed after entrant changes;
- stale finalist publication is removed when sampled evidence changes;
- coverage denominators use unique entrant domains;
- uncertainty is not converted into zero or negative evidence;
- cross-platform CI passes on the exact merged PR heads;
- no V3/commercial scoring or generic provider framework was introduced.

Engineering acceptance alone did not prove that a complete real finalist-cohort `finalize:full` run behaves acceptably under the operator's current network, Common Crawl latency/rate conditions, cache state, and real cohort size. That remaining live condition is now covered by the operator acceptance below.

## 5. Integrated operator acceptance — PASS

The merged production path was exercised on the real V2.2 research from current `main`.

Research:

```text
20260831143913996_357a43e8-597f-4da1-8eb0-30faee966303
```

Enrichment:

```text
20260831150111426_14b5a777-3aac-447a-96e7-41f1da3ebe71
```

Acceptance sequence:

```text
1. finalize:full on the real enrichment/finalist cohort
2. research:status in text mode
3. research:status --json
4. identical second finalize:full on the same enrichment
```

Observed historical-presence metrics:

| Metric | First `finalize:full` | Second `finalize:full` |
| --- | ---: | ---: |
| Historical presence checked | 19/19 | 19/19 |
| Observed | 18 | 18 |
| `not_found` | 1 | 1 |
| Cache hits | 0 | 19 |
| Domain lookup requests | 144 | 0 |

Acceptance observations:

- the real finalist cohort completed with `19/19` unique domains checked;
- the semantic result was stable across reruns: `18 observed / 1 not_found` on both passes;
- the first pass exercised the live Common Crawl path with 144 domain lookup requests and no cache hits;
- the second identical pass reused all 19 cached domain results and issued zero new Common Crawl domain lookup requests;
- text and JSON `research:status` completed in the integrated sequence;
- the second pass did not invent a different sampled-history result or require network refetching when the cache was valid;
- the real cohort exercised observed and `not_found` outcomes; the remaining omission/unavailable/error/not-attempted distinctions continue to be enforced by the deterministic integration/regression coverage recorded above;
- Common Crawl evidence remains a separate sampled historical-presence block and is not promoted to exact first-seen/site-age semantics.

The rerun evidence directly demonstrates cache reuse and deterministic semantic behavior for this real cohort. This acceptance does not make a stronger byte-for-byte artifact-immutability claim because no independent file-hash comparison was recorded; no such stronger claim is required for this gate.

No operator defect requiring a code fix was observed.

## 6. Final decision

```text
OPERATOR COMMON CRAWL TRANSPORT SMOKE: PASS
PRODUCTION TRANSPORT/CACHE: PASS
FINALIST-COHORT LIFECYCLE: PASS
FINALIZATION/STATUS/EVIDENCE INTEGRATION: PASS
EXACT-HEAD UBUNTU/WINDOWS CI: PASS
INTEGRATED REAL FINALIST-COHORT OPERATOR RUN: PASS
FULL V2.3 HISTORICAL-PRESENCE ACCEPTANCE: PASS
```

V2.3 historical-presence productionization is accepted and closed. No further work on this track is justified unless new evidence reveals a concrete defect or requirements change.