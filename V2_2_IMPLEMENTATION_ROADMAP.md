# V2.2 Implementation Roadmap

**Status:** engineering implementation complete; release pending operator live acceptance  
**Repository:** `DanilaH/super-converter-parser`  
**Release identity:** `V2.2 — Operator & Evidence Quality`  
**Detailed planning history:** preserved in git history prior to this closeout revision  
**Release acceptance:** [`V2_2_RELEASE_ACCEPTANCE.md`](./V2_2_RELEASE_ACCEPTANCE.md)

## 1. Purpose

V2.2 improves the already-operational V2.1 runner in three narrow areas:

- operator visibility into the current logical research state;
- explicit visibility of important evidence gaps and uncertainty;
- factual comparison of immutable discovery/enrichment generations.

V2.2 does **not** expand into V3 commercial evidence, product/business recommendations, automatic BUILD/WATCH/REJECT decisions, a dashboard, a generic provider framework, or broad persistence redesign.

## 2. Current implementation state

```text
PR-01  Historical-source spike                 COMPLETE -> DEFER provider
PR-02  Production historical provider          SKIPPED by evidence gate
PR-03  research:status                         COMPLETE
PR-04  Deep/finalist evidence coverage         COMPLETE
PR-05  Immutable generation diff               COMPLETE
PR-06  Deterministic integration/cold review   COMPLETE
LIVE   Real operator research acceptance       PENDING
```

The engineering work is complete on `v2.2-work`. V2.2 must not be called released until the remaining real operator-machine acceptance pass is executed and reviewed.

## 3. PR-01 — Historical-source spike

Result: [`V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md`](./V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md).

Decision:

```text
DEFER historical provider
```

The bounded experiment found strong incremental value from Common Crawl on GitHub-hosted live runs, but the required operator-machine access proof was not performed. Therefore production integration was deliberately not started.

Important semantics remain:

- RDAP registration date is not web first-seen;
- Wayback implementation exists but is not a proven stable live operator baseline;
- Common Crawl annual/bounded observations are sampled historical presence, not exact first-seen;
- unavailable / not_found / error remain distinct;
- no provider is promoted merely because fixture parsing or GitHub-hosted access works.

## 4. PR-02 — Production historical provider

State: **SKIPPED / DEFERRED**.

This is a successful evidence-gate outcome, not an unfinished implementation task. V2.2 may ship with explicit missing/unavailable first-seen evidence rather than forcing a weak or unproven provider into production.

A future operator-machine Common Crawl smoke may reopen this decision. If it does, use the smallest production historical-presence representation justified by the evidence; do not alias sampled presence into the existing exact-looking `firstSeenDate` semantics.

## 5. PR-03 — `research:status`

State: **COMPLETE**.

Current command:

```bash
npm run research:status -- --research <research-id-or-any-run-id>
```

Implemented contract:

- resolves a stable research id or historical discovery run id to `research.json.currentRunId`;
- reads durable discovery/enrichment SQLite state;
- reports immutable discovery/enrichment generations;
- reuses existing discovery quality and repairability semantics;
- reports persisted finalization/human-decision progress;
- checks Research Library publication against the exact current public snapshot fingerprint;
- provides deterministic workflow navigation only, never a business/opportunity recommendation;
- remains read-only.

## 6. PR-04 — Deep evidence coverage

State: **COMPLETE**.

`research:status` now exposes deep evidence uncertainty from already-persisted finalist/downstream state, including where available:

- representative URL coverage;
- entrant DR coverage;
- page-identity coverage;
- cohort-history checked / omitted / unobserved state;
- RDAP registration coverage;
- first-seen coverage and provider unavailable/error state;
- traffic evidence presence/currentness/mismatch/domain-scope coverage.

Hard rule:

```text
coverage warning = uncertainty explanation
coverage warning != negative evidence
```

Missing, unavailable, omitted, mismatched, or unobserved evidence is never silently converted to zero or absence.

## 7. PR-05 — Immutable generation diff

State: **COMPLETE**.

Current surface:

```bash
npm run research:diff -- --research <research-id-or-run-id> --from discovery:1 --to discovery:2
npm run research:diff -- --research <research-id-or-run-id> --from enrichment:1 --to enrichment:2
```

Generation refs are explicit and same-kind. Bare numbers and discovery-vs-enrichment comparisons fail closed instead of guessing.

Implemented factual comparison includes:

Discovery:

- keyword additions/removals;
- persisted keyword status changes;
- Google SERP evidence coverage changes.

Enrichment:

- module changes;
- persisted cluster additions/removals;
- same-`clusterId` membership/canonical changes;
- representative-query changes;
- entrant-domain changes;
- history coverage/omissions;
- traffic snapshot presence/currentness.

The diff is descriptive only. Persisted `clusterId` matching does not imply semantic continuity, and the command does not infer split/merge narratives, opportunity strength, or business conclusions.

## 8. PR-06 — Engineering integration

State: **COMPLETE**.

The deterministic integration fixture exercises one persisted logical research through:

```text
discovery generation 1
  -> enrichment generation 1
  -> real prepareResearchAppend()
  -> discovery generation 2
  -> enrichment generation 2
  -> research:status
  -> discovery diff
  -> enrichment diff
  -> verify old generations remain unchanged
```

During PR-06, Windows CI exposed a pre-existing timing race in CAPTCHA/SIGINT tests. The production pause/resume contract was not changed. The tests were fixed to synchronize SIGINT to actual collector entry instead of assuming a fixed 400 ms delay represented the same lifecycle point on every OS.

Final exact-head PR-06 CI passed `npm ci`, strict TypeScript, and the complete test suite on Ubuntu and Windows.

See [`V2_2_RELEASE_ACCEPTANCE.md`](./V2_2_RELEASE_ACCEPTANCE.md) for the evidence record and workflow IDs.

## 9. Remaining release gate — operator live research

This is now the **only mandatory V2.2 release task**.

Run a representative research in the actual operator environment using the real Research Chrome / Keyword Surfer path:

```text
1. discovery:full
2. research:append if a useful second batch exists
3. --retry-failed only if real primary failures are repairable
4. enrich:full against the current discovery run
5. choose real finalist scope
6. finalize:full with explicit history policy
7. research:status
8. research:diff for real immutable generations
9. Research Library publication only when genuine current human decisions are complete
```

The live pass must answer:

- Can current research state be understood without remembering enrichment IDs?
- Are repairable failures distinguishable from non-repairable terminal state?
- Are important evidence gaps clear on a real dataset?
- Can omitted/unavailable evidence be mistaken for zero or negative evidence?
- Is generation diff useful on real append/re-enrichment history?
- Does any concrete operator friction justify a **small** targeted fix?

If the run exposes a defect, fix that defect and repeat the affected gate. Do not invent extra V2.2 features merely because a release pass exists.

## 10. Hard scope boundary

Still out of V2.2:

```text
commercial query expansion
pricing scraping
commercial SERP collection
marketplace adapters
checkout/payment commercial evidence
EvidenceFact / WorkflowEdge implementation
commercial score or commercial inference
automatic BUILD / WATCH / REJECT
product/service recommendation
automatic smoke tests
paid-provider architecture
#25 paid backlink / competitor organic metrics
heavy dashboard / web UI
generic provider/plugin framework
broad persistence rewrite
one giant all-phases command
```

Future commercial-evidence planning remains in:

- [`V3_COMMERCIAL_EVIDENCE_SPEC.md`](./V3_COMMERCIAL_EVIDENCE_SPEC.md)
- [`COMMERCIAL_DATA_PROVIDER_MATRIX.md`](./COMMERCIAL_DATA_PROVIDER_MATRIX.md)

Neither document is a current V2.2 runtime contract.

## 11. Preserved invariants

```text
SQLite durable truth -> CSV/JSON/MD/ZIP derived
immutable generations
explicit fingerprints/revisions
fail closed on stale parents
deterministic outputs
unknown != zero
missing != negative evidence
visible caps/omissions
no automatic BUILD/WATCH/REJECT
no fake provenance
derived ZIP failure does not roll back durable truth
```

`research:status` and `research:diff` remain read-only and must not mutate research state.

## 12. Release decision

Current state:

```text
ENGINEERING IMPLEMENTATION: COMPLETE
DETERMINISTIC INTEGRATION: PASS
HISTORICAL PROVIDER: DEFER
OPERATOR LIVE ACCEPTANCE: PENDING
V2.2 RELEASE: NOT YET DECLARED
```

The next action is **not another implementation PR by default**. It is the real operator-machine research pass documented in `V2_2_RELEASE_ACCEPTANCE.md`.
