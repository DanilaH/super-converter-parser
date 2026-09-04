# V2.2 Release Acceptance

**Release identity:** `V2.2 — Operator & Evidence Quality`  
**Acceptance date:** 2026-08-31  
**Engineering integration status:** PASS  
**Operator live acceptance:** PASS  
**Overall release status:** RELEASED / READY TO MERGE

This document records what has actually been demonstrated for V2.2. Automated CI evidence and operator-machine live evidence are kept distinct: GitHub-hosted CI proves deterministic/code behavior; the operator live pass proves the real Research Chrome / Keyword Surfer workflow.

## 1. Acceptance summary

V2.2 satisfies its release gate:

- the historical-source experiment has a recorded evidence-backed decision;
- no historical provider was promoted without the required evidence;
- `research:status` projects the current logical research and deep evidence gaps;
- missing / omitted / unavailable evidence stays explicit instead of becoming zero or negative evidence;
- `research:diff` compares immutable discovery or enrichment generations factually;
- deterministic integration exercises append -> current status/coverage -> generation diff and proves older generations stay immutable;
- strict TypeScript and the complete automated test suite pass on Ubuntu and Windows;
- a representative operator-machine research pass exercised the real Research Chrome / Keyword Surfer path, append/resume, real CAPTCHA handling, enrichment, finalization, status and diff surfaces without finding a blocking product defect.

V2.2 is therefore ready for the release PR to merge to `main`.

## 2. Roadmap release gates

| Gate | State | Evidence / note |
| --- | --- | --- |
| Historical-source spike has a recorded decision | PASS | `V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md` records `DEFER historical provider`. |
| PR-02 promoted provider or explicitly skipped | PASS | PR-02 is intentionally skipped; V2.2 does not force an unproven historical provider into production. |
| `research:status` resolves current logical state without invented lineage | PASS | Deterministic tests, V2.2 integration fixture, and real operator run. |
| Deep/finalist evidence gaps are visibly denominated | PASS | Evidence coverage projector plus real dataset observations. |
| Immutable generations have deterministic factual diff | PASS | Append/re-enrichment fixtures plus real discovery generation 1 -> 2 diff. |
| Representative real research workflow exercised | PASS | Operator-machine research recorded below. |
| Final cold review finds no V3 scope theft / unnecessary framework | PASS | V2.2 remained operator/evidence-quality work; no commercial collector, score, provider framework, or automatic business decision was introduced. |
| Typecheck/tests actually ran | PASS | Constituent and cumulative release-candidate GitHub Actions passed Ubuntu + Windows `npm ci`, strict typecheck, and full test suite. |

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

The fixture verifies stable research-id resolution, deterministic current/latest lineage, explicit uncertainty, factual diff output, workflow navigation, and immutable historical generations.

This is an integration contract test, not the live-browser evidence. The live-browser evidence is recorded separately below.

## 4. Cross-platform finding found during PR-06

The first PR-06 Windows run (`33398391920`) found one pre-existing CAPTCHA/SIGINT test race. The V2.2 integration fixture itself passed.

The failure was:

```text
expected interrupted keyword status: running
observed on Windows: pending
```

The fixed test had used a 400 ms wall-clock timer to send SIGINT. On a slower Windows run, that timer could fire before collection began, making `pending` valid and the test premise false.

The production pause/resume contract was not changed. The tests now synchronize SIGINT to actual collector entry, after the keyword has been durably marked `running`.

Follow-up and final exact-head workflows passed the complete suite on Ubuntu and Windows.

## 5. Historical web-presence status

V2.2 ships with the truthful historical-evidence boundary:

```text
RDAP registration evidence: implemented and usable
Wayback first-seen implementation: exists, but not a proven stable live operator baseline
Common Crawl spike: high incremental value on GitHub-hosted live runs
Common Crawl production integration: DEFERRED
```

Common Crawl bounded/sampled observations must not be aliased to exact Wayback-style first-seen. Explicit missing/unavailable first-seen evidence is an acceptable and truthful V2.2 state.

## 6. Operator-machine live acceptance

### Identity

```text
Git HEAD:
  d1492f7c90019e5221d5c05eacd248916ddef2a1

Research ID:
  20260831143913996_357a43e8-597f-4da1-8eb0-30faee966303

Discovery generation 1:
  run 20260831143913996_357a43e8-597f-4da1-8eb0-30faee966303
  30 keywords

Discovery generation 2 (current):
  run 20260831144905330_e02ba8a3-799b-49d8-a45e-3a9db3d5ddca
  44 keywords

Enrichment generation 1 (current/latest):
  20260831150111426_14b5a777-3aac-447a-96e7-41f1da3ebe71

Finalization state:
  awaiting_decisions
  0 / 2 current human decisions
```

### Real discovery and append

The initial live discovery used five real utility queries:

```text
json diff
compare csv files
hex to rgb converter
regex tester online
cron expression generator
```

`discovery:full` produced 30 keywords: five seeds plus 25 real Keyword Surfer depth-one expansions. All 30 completed.

Observed real evidence included:

- Ahrefs numeric DR for 103/103 observed domains;
- Google geo mismatch warning for 30/30 keywords: target US vs detected `Chelyabinsk Oblast, Russia`;
- 2 cache hits / 28 misses on the initial run;
- completed terminal state with generated artifacts.

A real append then added:

```text
json to csv
yaml to json
unit converter online
```

During this live append the Research Chrome/CDP process died completely. The runner was resumed with the existing run and correctly continued only the pending work and subsequent expansion work; completed checkpoints were not repeated.

A real Google CAPTCHA then appeared on the expanded query `web whatsapp`. The runner paused, the CAPTCHA was solved manually, and the run resumed correctly.

The current generation completed with 44 keywords and 139 observed domains; Ahrefs numeric DR was present for 139/139 domains. `research.json` retained the stable original research ID while advancing `currentRunId` to discovery generation 2 and preserving both batch provenances.

No repairable failed checkpoints occurred. `repairable=0` was therefore accepted as the truthful real state; failures were not fabricated for the acceptance pass.

### `research:status`

The live pass confirmed that `research:status`:

- resolves both the stable research ID and historical discovery run IDs to discovery generation 2;
- reports 44/44 completed keywords and zero partial/failed/repairable checkpoints;
- surfaces the 44/44 geo mismatch with an explicit denominator;
- identifies the enrichment as `current-discovery, latest` without requiring the operator to remember its ID;
- tracks finalization progression from `not_started` to `awaiting_decisions`;
- reports real deep evidence coverage including 19/19 URL/DR/page-identity coverage, 9/19 history checked, and 0/19 known first-seen;
- surfaces five coverage warnings with explicit denominators and non-negative-evidence semantics;
- reports Research Library state truthfully as finalization/decision state changes;
- provides exact workflow navigation rather than business advice.

Both text and JSON output were exercised.

### `research:diff`

The real discovery diff for generation 1 -> 2 reported:

```text
keywords: 30 -> 44
added: 14
removed: 0
Google SERP coverage: 30/30 -> 44/44
```

An enrichment generation 1 -> 1 comparison remained stable and produced no spurious change.

The diff remained factual and did not emit opportunity-strength claims or automatic BUILD/WATCH/REJECT conclusions.

The historical generation-1 `keywords.csv` remained unchanged after append: 31 lines including the header and 30 original keyword rows.

### Real evidence-gap semantics

The live data exercised important V2.2 truth cases:

- RDAP `ok`, `unsupported`, and `not_attempted` remained distinct;
- first-seen stayed unavailable/deferred rather than becoming a fabricated date;
- `colordesigner.io` and `cronhub.io` had unsupported RDAP and empty `domain_age_days`, not zero;
- `crontab.guru` preserved RDAP redaction evidence;
- one page network failure preserved `fetch_status=error` and `fetch_error`, with qualitative evidence left empty rather than inferred;
- cohort history recorded `first_seen_known_domain_count=0` with explicit first-seen status counts;
- finalist evidence retained empty product feasibility and unrecorded human decisions rather than inventing conclusions.

### Finalization and Library

The live finalist scope used two real clusters:

```text
cluster-4: json diff
cluster-6: regex tester online
```

Finalization produced:

- representative-query revision 1;
- entrant cohort of 19 domains with survivorship warning;
- cohort history checked for 9/19 domains, with 10 cap-omitted;
- known web first-seen 0/19, explicitly unavailable/deferred;
- traffic evidence missing by design because no traffic import was supplied;
- two finalists, zero current decisions, two unrecorded decisions, and explicit audit flags.

Research Library publication was correctly blocked because 0/2 finalists had current human decisions. No fake decisions or publication were created merely to satisfy the release test.

### Operator friction and defects

No operator friction requiring a V2.2 code change was observed.

The two disruptive real-environment events were handled correctly:

```text
Research Chrome/CDP process death -> normal resume preserved completed checkpoints
real Google CAPTCHA -> graceful pause -> manual solve -> resume
```

No product defect was found and no live-acceptance fix commit was required.

## 7. Release decision

Final decision:

```text
ENGINEERING IMPLEMENTATION: COMPLETE
DETERMINISTIC INTEGRATION: PASS
CROSS-PLATFORM CI: PASS
OPERATOR LIVE ACCEPTANCE: PASS
HISTORICAL PROVIDER: DEFER
V3 COMMERCIAL WORK: OUT OF V2.2 SCOPE
V2.2 RELEASE: READY TO MERGE
```

The release is accepted because the real workflow confirmed the intended operator/evidence semantics, including failure/resume behavior and genuine missing-evidence cases. This is not a business/opportunity verdict and does not turn unmeasured evidence into absence.
