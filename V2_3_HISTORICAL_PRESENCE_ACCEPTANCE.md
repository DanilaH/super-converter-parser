# V2.3 Historical Presence Acceptance

**Scope:** post-V2.2 Common Crawl sampled historical-presence productionization  
**Acceptance date:** 2026-08-31  
**Operator transport smoke:** PASS  
**Engineering integration:** PASS  
**Integrated finalist-cohort operator acceptance:** PENDING  
**Overall status:** IMPLEMENTED IN `main`; FULL LIVE ACCEPTANCE NOT YET DECLARED

This document keeps three different claims separate:

1. Common Crawl can be reached from the real operator environment under the bounded client policy;
2. the production transport, cache, cohort lifecycle, status projection, finalist evidence integration, and invalidation contracts pass deterministic cross-platform engineering gates;
3. the complete merged `finalize:full` path has been exercised on a real finalist cohort and inspected end to end.

Claims 1 and 2 are demonstrated. Claim 3 is still pending and must not be inferred from GitHub Actions.

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

The merged implementation is now defensible at the code-contract level:

- immutable parent identity is checked on load;
- stale sampled state fails closed after entrant changes;
- stale finalist publication is removed when sampled evidence changes;
- coverage denominators use unique entrant domains;
- uncertainty is not converted into zero or negative evidence;
- cross-platform CI passes on the exact merged PR heads;
- no V3/commercial scoring or generic provider framework was introduced.

This does **not** prove that a complete real finalist-cohort `finalize:full` run behaves acceptably under the operator's current network, Common Crawl latency/rate conditions, cache state, and real cohort size.

## 5. Remaining integrated operator acceptance

Run this on the operator machine from current `main` at or after:

```text
c1add2026f9b55c89a480f11490184b77b5017fc
```

Use a real completed enrichment and a genuine finalist scope. The acceptance path is:

```text
1. run finalize:full on a representative real finalist cohort
2. confirm the sampled historical-presence stage completes or fails truthfully without corrupting downstream state
3. inspect cohort-historical-presence.csv / .json
4. inspect finalist-evidence-matrix.json / .csv
5. run research:status in text and --json modes
6. confirm unique-domain checked/observed denominators are understandable
7. confirm not_found / omitted / not_attempted / unavailable / error remain distinguishable
8. confirm sampled timestamps are visibly labeled bounded/sampled and never appear as exact first-seen
9. rerun the same finalist scope and confirm cache reuse is visible and sane
10. if the sampled snapshot materially changes, confirm stale finalist publication is invalidated and regenerated
11. record any actual operator friction; fix only observed defects
```

Human decisions do not need to be fabricated merely to make this gate pass. If the real research legitimately remains `awaiting_decisions`, that is acceptable provided the evidence matrix/status surfaces are current and truthful.

## 6. Current decision

```text
OPERATOR COMMON CRAWL TRANSPORT SMOKE: PASS
PRODUCTION TRANSPORT/CACHE: PASS
FINALIST-COHORT LIFECYCLE: PASS
FINALIZATION/STATUS/EVIDENCE INTEGRATION: PASS
EXACT-HEAD UBUNTU/WINDOWS CI: PASS
INTEGRATED REAL FINALIST-COHORT OPERATOR RUN: PENDING
FULL V2.3 HISTORICAL-PRESENCE ACCEPTANCE: NOT YET DECLARED
```

No further speculative framework work is justified before the integrated operator pass. The next useful evidence is a real merged-path run, not another abstraction layer.
