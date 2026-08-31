# V2.2 Historical Source Spike Result

**Status:** PR-01 evidence decision  
**Date:** 2026-08-31  
**Scope:** bounded historical web-presence source experiment only  
**Production code changed by this decision:** no

## Decision

```text
DEFER historical provider
```

This is a **gate result, not a rejection of Common Crawl**.

Common Crawl is the preferred production candidate based on the live benchmark evidence below. However, `V2_2_IMPLEMENTATION_ROADMAP.md` requires a promoted provider to be proven in the **real operator environment**. The live network runs available during PR-01 executed on GitHub-hosted Ubuntu runners, not on the operator machine. Therefore PR-02 must not be started or merged as if the production gate had passed.

When an operator-machine smoke becomes available, Common Crawl is the source to test first. If that smoke confirms legitimate access and bounded behavior, PR-01 may be reclassified to:

```text
PROMOTE common_crawl
```

without repeating the broad source-discovery exercise.

## What the spike established

### Dataset

The decision-sized fixture contained:

- 60 persisted observation rows;
- 59 unique real observed domains;
- two prior research datasets:
  - `hardware-audio-2026-08-27`;
  - `utility-market-scan-2026-08-30`;
- persisted RDAP registration evidence for 51/59 domains (86.4%).

The sample was not a hand-picked list of famous domains; it reused real entrant evidence already produced by the runner.

### Common Crawl live evidence

Primary annual benchmark:

- GitHub Actions run: `33374267917`;
- 34 selected crawl indexes from 127 available indexes;
- annual mode = oldest selected crawl per year plus recent crawls;
- planned upper bound: 2,006 collection checks;
- observed before provider circuit opened: 32/59;
- requests executed: 294;
- p50 request latency: 356 ms;
- p95 request latency: 5,013 ms;
- one domain ended as HTTP 504 error;
- 26 later domains became `unavailable` only after the protective circuit opened following consecutive network failures.

The first run therefore did **not** demonstrate only 54.2% underlying Common Crawl coverage. It demonstrated that the experimental client correctly stopped a long scan after transient provider/network failures.

Recovery annual benchmark after cooldown:

- GitHub Actions run: `33375216772`;
- exactly the 26 domains made unavailable by the first Common Crawl circuit;
- Common Crawl observed: **26/26 (100%)**;
- `error`: 0;
- `unavailable`: 0;
- requests executed: 284;
- p50 request latency: 448 ms;
- p95 request latency: 5,596 ms.

Across the primary run plus recovery, Common Crawl produced a legitimate sampled historical observation for **58 of the 59 unique domains**. The remaining domain, `100printswith.me`, ended the primary run with an HTTP 504 and was not part of the 26-domain recovery fixture. This combined 58/59 figure is a multi-run recovery result, not a claim that one uninterrupted 59-domain scan achieved 98.3% coverage.

### Wayback comparison

Primary annual benchmark:

- observed: 10/59 (16.9%);
- unavailable: 48;
- error: 1;
- requests: 14;
- p50 latency: 2,292 ms;
- p95 latency: 34,587 ms.

Recovery benchmark:

- observed: 8/26 (30.8%);
- unavailable: 17;
- error: 1;
- requests: 9;
- p50 latency: 457 ms;
- p95 latency: 10,168 ms.

Wayback therefore remained substantially less reliable under these automated GitHub-runner conditions. This does **not** contradict the existing project baseline that Wayback is unavailable in the real operator environment; GitHub-hosted access is a different network environment.

## Incremental value

Before the first Common Crawl circuit opened, the primary run already contained:

- both archive sources observed: 9 domains;
- Common Crawl only: 23 domains;
- Wayback only: 1 domain.

The recovery run added Common Crawl observations for all 26 previously circuit-blocked domains, while Wayback observed only 8 of them.

This is enough to conclude that Common Crawl supplies material independent historical web-presence evidence rather than duplicating RDAP or the current Wayback path.

## Critical semantic finding

Common Crawl annual mode is **sampled historical presence**, not exact first-seen.

In the primary run, where both Common Crawl and Wayback returned archive dates:

- Common Crawl earlier: 0/9;
- Wayback earlier: 9/9.

In the recovery run:

- Common Crawl earlier: 0/8;
- Wayback earlier: 8/8.

Some gaps were measured in years. Therefore `earliestSampledCaptureAt` must not be written into the existing `FirstSeenResult.firstSeenDate` field and treated as equivalent to a Wayback first-capture observation.

That would be materially misleading because current downstream cohort history uses `firstSeenDate` to compute:

- web-presence age;
- `isRecent`;
- registration-versus-first-seen gap;
- possible history conflicts.

A future production integration must preserve Common Crawl's bounded/sample precision explicitly. Acceptable shapes include a separate historical web-presence fact or the smallest additive precision/interval semantics justified by the implementation. A transparent separate fact is preferred over pretending the existing exact-looking first-seen contract is stronger than the evidence.

## RDAP comparison anomalies

The experiment also reinforced that RDAP registration date and archive web presence answer different questions.

Examples from the primary run included archive observations earlier than the currently persisted registration date, including:

- `attackshark.com`;
- `bannerbear.com`.

Possible explanations include domain re-registration or historical use by a different site. These are evidence conflicts to surface, not errors to "correct" by selecting one source.

## Operational findings

The spike client correctly needed:

- `404 No Captures found` => `not_found`, not generic error;
- separate CDX request HTTP status from archived capture HTTP status;
- a descriptive User-Agent;
- explicit rate limiting;
- bounded retries and circuit breaking;
- preserved `ok` / `not_found` / `unavailable` / `error` distinctions.

The first long scan demonstrated why the circuit breaker matters. The successful recovery demonstrated why a circuit-open result must not be reinterpreted as missing historical coverage.

## Production implications

Do **not** merge the ~2k-line PR-01 experimental harness into the V2.2 production workstream merely because it produced useful evidence.

If operator-machine access later passes:

1. implement the smallest production Common Crawl historical-presence collector justified by this evidence;
2. reuse existing bounded cache/checkpoint/provenance patterns where they fit;
3. do not rewrite `domain_age` broadly;
4. do not alias sampled Common Crawl presence to registration date or exact first-seen;
5. keep Wayback optional and truthfully unavailable where it cannot be reached;
6. require a real operator-environment run before declaring the source production-ready.

Until then, PR-02 is deferred and V2.2 proceeds with operator/evidence-quality work (`research:status`, coverage visibility, generation diff).

## Evidence provenance

The primary and recovery machine-readable JSON/CSV/Markdown outputs were produced by the experimental PR-01 harness on GitHub-hosted Ubuntu runners. The important workflow run IDs are retained above so the experiment can be audited without converting those temporary artifacts into production truth.

This document records the engineering conclusion. It does not turn benchmark observations into business conclusions and does not change existing V2.1 runtime semantics.
