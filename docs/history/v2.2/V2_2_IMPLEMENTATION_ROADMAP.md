# V2.2 Implementation Roadmap

**Status:** COMPLETE / RELEASE ACCEPTED  
**Repository:** `DanilaH/super-converter-parser`  
**Release identity:** `V2.2 — Operator & Evidence Quality`  
**Detailed planning history:** preserved in git history prior to the closeout revisions  
**Release acceptance:** [`V2_2_RELEASE_ACCEPTANCE.md`](./V2_2_RELEASE_ACCEPTANCE.md)

## 1. Purpose

V2.2 improves the already-operational V2.1 runner in three narrow areas:

- operator visibility into the current logical research state;
- explicit visibility of important evidence gaps and uncertainty;
- factual comparison of immutable discovery/enrichment generations.

V2.2 does **not** expand into V3 commercial evidence, product/business recommendations, automatic BUILD/WATCH/REJECT decisions, a dashboard, a generic provider framework, or broad persistence redesign.

## 2. Final implementation state

```text
PR-01  Historical-source spike                 COMPLETE -> DEFER provider
PR-02  Production historical provider          SKIPPED by evidence gate
PR-03  research:status                         COMPLETE
PR-04  Deep/finalist evidence coverage         COMPLETE
PR-05  Immutable generation diff               COMPLETE
PR-06  Deterministic integration/cold review   COMPLETE
LIVE   Real operator research acceptance       PASS
RC     Cumulative Ubuntu + Windows CI           PASS
V2.2   Release                                 READY TO MERGE
```

The final operator-machine acceptance used the actual Research Chrome / Keyword Surfer path and is recorded with exact run/enrichment IDs in `V2_2_RELEASE_ACCEPTANCE.md`.

## 3. Historical-source decision

Result: [`V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md`](./V2_2_HISTORICAL_SOURCE_SPIKE_RESULT.md).

Decision:

```text
DEFER historical provider
```

The bounded experiment found strong incremental value from Common Crawl on GitHub-hosted live runs, but production integration was not justified under the V2.2 evidence gate. This is a completed gate outcome, not unfinished V2.2 work.

Important semantics remain:

- RDAP registration date is not web first-seen;
- Wayback implementation exists but is not a proven stable live operator baseline;
- Common Crawl bounded/sampled observations are not exact first-seen;
- unavailable / not_found / error remain distinct;
- no provider is forced into production simply to eliminate missing evidence.

## 4. `research:status`

State: **COMPLETE**.

```bash
npm run research:status -- --research <research-id-or-any-run-id>
```

Implemented contract:

- resolves a stable research id or historical discovery run id to the current logical research;
- reads durable discovery/enrichment state;
- reports immutable generations and current/latest enrichment only when deterministically resolvable;
- reuses existing discovery quality and repairability semantics;
- reports deep evidence coverage and finalization/human-decision progress;
- verifies Research Library publication against the exact current public snapshot fingerprint;
- provides deterministic workflow navigation only, never a business/opportunity recommendation;
- remains read-only.

The real operator pass confirmed that historical run IDs resolve to the current discovery generation without requiring the operator to remember enrichment IDs.

## 5. Deep evidence coverage

State: **COMPLETE**.

`research:status` exposes persisted uncertainty including representative URL, entrant DR/page identity, cohort history, RDAP, first-seen/provider state, traffic presence/currentness/mismatch, caps and omissions where available.

Hard rule:

```text
coverage warning = uncertainty explanation
coverage warning != negative evidence
```

The live dataset exercised unsupported RDAP, unavailable first-seen, cap omissions, a real page network error and incomplete human decisions. These remained explicit missing/error states rather than becoming zero or fabricated evidence.

## 6. Immutable generation diff

State: **COMPLETE**.

```bash
npm run research:diff -- --research <research-id-or-run-id> --from discovery:1 --to discovery:2
npm run research:diff -- --research <research-id-or-run-id> --from enrichment:1 --to enrichment:2
```

The diff is factual only. It does not infer opportunity strength, semantic cluster continuity, split/merge narratives, or business decisions.

The real operator append produced discovery generation 1 with 30 keywords and generation 2 with 44 keywords. The live diff reported 14 additions, zero removals and Google SERP coverage 30/30 -> 44/44 while the older generation remained unchanged.

## 7. Engineering integration

State: **COMPLETE**.

The deterministic integration fixture exercises:

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

During PR-06, Windows CI exposed a pre-existing timing race in CAPTCHA/SIGINT tests. The production pause/resume contract was not changed; the tests were synchronized to actual collector entry rather than a fixed wall-clock delay.

Final constituent and cumulative release-candidate CI passed `npm ci`, strict TypeScript, and the complete test suite on Ubuntu and Windows.

## 8. Operator live acceptance

State: **PASS**.

The final live acceptance research was:

```text
research:
  20260831143913996_357a43e8-597f-4da1-8eb0-30faee966303

current discovery:
  generation 2
  20260831144905330_e02ba8a3-799b-49d8-a45e-3a9db3d5ddca
  44/44 completed keywords

current enrichment:
  generation 1
  20260831150111426_14b5a777-3aac-447a-96e7-41f1da3ebe71

finalization:
  awaiting_decisions
  0/2 current human decisions
```

The run exercised real Search Chrome/Keyword Surfer collection, Surfer expansion, append, an actual CDP process death followed by resume, a real Google CAPTCHA pause/manual solve/resume, enrichment, finalist/finalization state, status, diff and truthful Library blocking.

No blocking product defect or operator friction requiring a V2.2 fix was found.

See `V2_2_RELEASE_ACCEPTANCE.md` for the complete evidence record.

## 9. Hard scope boundary preserved

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

- [`V3_COMMERCIAL_EVIDENCE_SPEC.md`](../../plans/v3/V3_COMMERCIAL_EVIDENCE_SPEC.md)
- [`COMMERCIAL_DATA_PROVIDER_MATRIX.md`](../../plans/v3/COMMERCIAL_DATA_PROVIDER_MATRIX.md)

Neither document is a current V2.2 runtime contract.

## 10. Preserved invariants

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

`research:status` and `research:diff` remain read-only.

## 11. Release decision

Final state:

```text
ENGINEERING IMPLEMENTATION: COMPLETE
DETERMINISTIC INTEGRATION: PASS
CUMULATIVE CROSS-PLATFORM CI: PASS
OPERATOR LIVE ACCEPTANCE: PASS
HISTORICAL PROVIDER: DEFER
V3 COMMERCIAL WORK: OUT OF V2.2 SCOPE
V2.2 RELEASE: READY TO MERGE
```

The next release action is the existing release PR `#94: v2.2-work -> main`. No additional V2.2 feature work is required unless the final merge itself exposes a concrete repository integration problem.