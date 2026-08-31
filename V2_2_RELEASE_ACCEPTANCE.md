# V2.2 Release Acceptance

**Release identity:** `V2.2 — Operator & Evidence Quality`  
**Acceptance date:** 2026-08-31  
**Engineering integration status:** PASS  
**Overall release status:** PENDING OPERATOR LIVE RESEARCH PASS

This document records what has actually been demonstrated for V2.2 and what has not. It must not be read as proof of live browser/provider behavior that was only exercised through deterministic fixtures or GitHub-hosted CI.

## 1. Acceptance summary

V2.2 has completed its deterministic engineering/integration gate:

- the historical-source experiment has a recorded evidence-backed decision;
- no historical provider was promoted without operator-machine evidence;
- `research:status` projects the current logical research and deep evidence gaps;
- missing / omitted / unavailable evidence stays explicit instead of becoming zero or negative evidence;
- `research:diff` compares immutable discovery or enrichment generations factually;
- an integration fixture exercises append -> current status/coverage -> generation diff while proving older discovery/enrichment generations remain unchanged;
- strict TypeScript and the complete automated test suite pass on both Ubuntu and Windows after the final PR-06 test-race fix.

V2.2 is **not yet declared released**, because the roadmap also requires a representative real operator research pass using the actual Research Chrome / Keyword Surfer environment. That live workflow has not been executed as part of this acceptance record.

## 2. Roadmap release gates

| Gate | State | Evidence / note |
| --- | --- | --- |
| Historical-source spike has a recorded decision | PASS | `V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md` records `DEFER historical provider`. |
| PR-02 promoted provider or explicitly skipped | PASS | PR-02 is intentionally skipped while the operator-machine Common Crawl smoke is unproven. |
| `research:status` resolves current logical state without invented lineage | PASS | Deterministic status tests plus V2.2 integration fixture. |
| Deep/finalist evidence gaps are visibly denominated | PASS | Evidence coverage projector + DB-to-status integration regression. |
| Immutable generations have deterministic factual diff | PASS | `research:diff` discovery/re-enrichment fixtures plus V2.2 integration fixture. |
| Representative real research workflow exercised | **PENDING** | Must run on the operator machine with the real Research Chrome / Keyword Surfer environment. |
| Final cold review finds no V3 scope theft / unnecessary framework | PASS | V2.2 remained read-only/operator/evidence-quality work; no commercial collector, score, provider framework, or automatic business decision was introduced. |
| Typecheck/tests actually ran | PASS | GitHub Actions workflow `33398933012`: Ubuntu and Windows both completed `npm ci`, `npm run typecheck`, and `npm test` successfully. |

## 3. Deterministic PR-06 integration gate

`src/research/v22Integration.test.ts` exercises one persisted logical research through:

```text
completed discovery generation 1
  -> immutable enrichment generation 1
  -> real prepareResearchAppend() fork
  -> completed discovery generation 2
  -> immutable enrichment generation 2
  -> research:status
  -> discovery generation diff
  -> enrichment generation diff
  -> reopen generation 1 state and prove it was not mutated
```

The fixture specifically verifies:

- stable research-id resolution through append;
- current discovery generation selection;
- current/latest enrichment selection without mtime inference;
- an explicit `ENTRANT_COHORT_NOT_COLLECTED` uncertainty warning instead of invented downstream evidence;
- workflow navigation remains `run_finalization` when finalization evidence is genuinely absent;
- discovery additions and Google SERP coverage changes are factual;
- enrichment module/cluster/representative changes are factual;
- historical discovery and enrichment SQLite state remains unchanged.

This is an integration contract test. It is not a synthetic claim that a complete real SEO research was performed.

## 4. Cross-platform finding found during PR-06

The first PR-06 Windows run (`33398391920`) found one real automated-test failure in the pre-existing CAPTCHA/SIGINT test. The new V2.2 integration fixture itself passed.

The failure was investigated rather than dismissed as CI infrastructure:

```text
expected interrupted keyword status: running
observed on Windows: pending
```

The fixed test had used a 400 ms wall-clock timer to send SIGINT. On the slower Windows run, that timer could fire before the active keyword entered collection, so `pending` was a valid lifecycle state and the test's premise was false.

The production pause/resume contract was not changed. Both CAPTCHA/SIGINT tests were made deterministic by synchronizing the signal to the actual collector-entry lifecycle boundary, after `executeRun` has durably marked the keyword `running`.

The follow-up workflow `33398933012` passed the complete suite on both Ubuntu and Windows.

## 5. Historical web-presence status

Current truthful V2.2 state remains:

```text
RDAP registration evidence: implemented and usable
Wayback first-seen implementation: exists, but not a proven stable live operator baseline
Common Crawl spike: high incremental value on GitHub-hosted live runs
Common Crawl production integration: DEFERRED
```

Common Crawl must not be aliased to exact Wayback-style first-seen. The spike measured bounded/sampled historical presence and demonstrated materially different timestamp semantics.

A future operator-machine Common Crawl smoke may reopen the provider-promotion decision, but it is not required to force a historical provider into V2.2. Explicit missing/unavailable first-seen evidence is an acceptable release state.

## 6. Required operator live acceptance

Before changing this document's overall status to `RELEASED`, execute a representative real research from the operator environment using the normal workflow and preserve the resulting run/enrichment IDs for audit.

Minimum flow:

```text
1. discovery:full with real Research Chrome + Keyword Surfer
2. research:append if a useful second batch exists
3. --retry-failed only if real primary failures are repairable
4. enrich:full against the current discovery generation
5. choose real finalist scope
6. finalize:full with explicit history policy
7. research:status
8. research:diff for the immutable generations that actually exist
9. Research Library publication only if genuine current human decisions are complete
```

During that pass confirm:

- the operator can identify current state without remembering enrichment IDs;
- repairable failures are distinguishable from non-repairable terminal state;
- important coverage gaps are understandable in the real dataset;
- omitted/unavailable evidence cannot be mistaken for zero or negative evidence;
- generation diff is useful on real append/re-enrichment history;
- no unexpected operator friction justifies additional V2.2 scope.

If the real run exposes a concrete defect, fix that defect and repeat the affected gate. Do not add speculative polish merely because the release pass exists.

## 7. Release decision

Current decision:

```text
ENGINEERING INTEGRATION: PASS
V2.2 RELEASE: PENDING OPERATOR LIVE RESEARCH PASS
HISTORICAL PROVIDER: DEFER
V3 COMMERCIAL WORK: OUT OF V2.2 SCOPE
```

No automated evidence in this document should be interpreted as a business/opportunity verdict or as proof that unmeasured evidence is absent.