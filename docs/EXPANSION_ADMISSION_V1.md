# Expansion admission V1 / V1.1

Discovery expansion remains depth-one, but versioned global admission separates Related collection from SERP admission.

## Lifecycle

1. Collect every original (depth-zero) keyword and persist its raw Surfer Related outcome in `run.sqlite`.
2. Do not append Related candidates while original keywords are still unfinished.
3. When every original keyword is terminal, build one deterministic global frontier from durable `related_keywords` rows.
4. Persist selected flags and append only the final admitted candidates to the discovery keyword queue.
5. Collect SERP evidence for those admitted candidates. Expansion children never expand again.

A pause or crash before frontier materialization leaves only raw Related evidence. Resume rebuilds the frontier from SQLite using the **persisted admission version**. Materialization is idempotent and monotonic: already committed expansion keywords are never silently removed; remaining budget may be topped up when durable Related evidence changes through an explicit repair/retry.

## Versioning

Fresh production discovery runs stamp `expansion.admissionVersion = "v1.1"` into the existing SQLite `config_snapshot`.

- `v1.1`: current global deterministic admission, using support before the broadening penalty.
- `v1`: preserved global deterministic admission with the original broadening-first comparator.
- missing marker: historical pre-global run; preserve legacy immediate per-parent expansion on resume.
- unknown marker: fail closed instead of mixing algorithms inside one run.

The marker is an implementation version, not an operator-authored semantic setting. Operator semantic fingerprints continue to be built from their explicit resolved fields.

A software update must never reinterpret an existing `v1` run as `v1.1`. Frontier materialization, resume, and run-quality replay all dispatch from the persisted marker.

## Shared eligibility and budget

V1 and V1.1 deliberately share the same eligibility gates and budget. The only production-policy change in V1.1 is the position of the existing `broadeningOnly` signal in the global comparator.

Shared rules:

- exact existing keywords are rejected;
- single-token automatic expansion candidates are rejected; direct seeds are unrestricted;
- existing `minOverlap`, `minVolume`, and `maxCandidatesPerKeyword` constraints still apply;
- parent support is bucketed at 1 / 2 / 3+;
- strict lexical broadening is deprioritized, not hard-rejected;
- directional phrases remain distinct;
- added-keyword budget is `min(500, ceil(originalKeywordCount * 1.25))`.

For 280 original keywords, either global policy can add at most 350 expansion keywords, for at most about 630 discovery keywords total.

## Comparator versions

The pure policy lives in `src/runs/expansionAdmission.ts`.

### V1 — preserved compatibility policy

```text
broadening
→ parent support tier
→ best overlap
→ bounded specificity
→ Related volume
→ lexical tie-break
```

This policy remains available only because persisted V1 generations must resume and regenerate diagnostics without semantic drift.

### V1.1 — current fresh policy

```text
parent support tier
→ broadening
→ best overlap
→ bounded specificity
→ Related volume
→ lexical tie-break
```

The change is intentionally narrow. Repeated support from multiple roots can now outrank one-parent non-broadening noise, while broadening still remains a penalty inside the same support tier.

No new provider, threshold, blacklist, embedding, LLM, semantic classifier, depth, cap, or budget was introduced by V1.1.

## Why V1.1 changed the order

The read-only V1 replay compared several placements of `broadeningOnly` over preserved V1 runs while keeping eligibility and budget fixed.

The selected production change was `parent support → broadening → overlap ...` because it produced small frontier churn while repeatedly replacing one-parent generic/noisy candidates with broadening candidates corroborated by multiple roots. Moving broadening later than overlap caused materially more churn without comparable evidence of benefit.

This is evidence for the comparator change only. It is not an automatic SEO-opportunity verdict.

## Diagnostics

After frontier materialization discovery publishes:

- `expansion-admission.json`
- `expansion-admission.csv`

They preserve the admission `version`, decision, reason, support, overlap, volume, broadening flag, committed state, and final selection state for every observed candidate. These artifacts are diagnostics; SQLite remains durable truth.

`run-quality.json` version `1.2.0` projects versioned admission accounting from the same durable Related evidence through `buildExpansionAdmission()` using the **persisted policy version**. It keeps different units explicit:

- `selectedRows` is the historical compatibility field and counts selected parent→child occurrence rows;
- `selectedOccurrenceRows` names that occurrence-level unit explicitly;
- `rawUniqueCandidateCount` and `eligibleUniqueCandidateCount` count normalized unique candidates;
- `policySelectedUniqueKeywordCount` is the persisted admission policy selection from durable evidence;
- `selectedUniqueKeywordCount` counts durably committed expansion keywords in the run;
- `policyRejectedUniqueCandidateCount` and `policyRejectionReasonCounts` describe persisted-policy rejections, which can differ from durable final selection after monotonic repair/top-up history;
- `admissionAccounting` distinguishes `v1_replayed_from_durable_evidence` from `v1_1_replayed_from_durable_evidence`.

Versioned admission projection is emitted only for supported persisted global-admission markers. Historical no-marker runs do not receive fabricated V1/V1.1 accounting. The old `explicitOmissionCount` / `omissionAccounting` fields remain compatibility-only and are not redefined.

## Offline comparator replay

`npm run expansion:replay -- --run <run-id>` remains a read-only experiment surface for **preserved V1 discovery runs only**. It does not mutate `run.sqlite`, call providers, change admission, or write a new discovery generation.

The replay is intentionally pinned to the original V1 eligibility, per-parent caps, thresholds, budget, and baseline comparator. V1.1 becoming current must not silently rewrite the experiment that justified it.

The replay variants are:

- `v1`: broadening → parent support → overlap → bounded specificity → Related volume;
- `broadening_after_support`: parent support → broadening → overlap → bounded specificity → Related volume;
- `broadening_after_overlap`: parent support → overlap → broadening → bounded specificity → Related volume;
- `broadening_last`: parent support → overlap → bounded specificity → Related volume → broadening.

The `v1` baseline is explicitly a **persisted V1 policy replay over durable Related evidence**. It is not a claim that the replayed selected set must equal a historical monotonic final frontier after repair/top-up history.

Selection and evaluation remain deliberately separate. `buildExpansionReplaySelections()` accepts only the same pre-SERP Related evidence used by V1 admission. Materialized child rows plus their SERP/scoring evidence are connected later by `evaluateExpansionReplay()` and cannot affect any comparator.

Counterfactual evidence is incomplete by construction: candidates rejected by the historical V1 run normally were never materialized as child keywords, and therefore normally have no collected child SERP. Replay keeps these units separate:

- `durableChildKeywordCount` / `durableChildKeywordCoveragePercent` report whether a replay-selected candidate exists as a durable expansion child row;
- `counterfactualUnmaterializedCount` reports replay-selected candidates that were never materialized historically;
- `trustworthySerpCount` / `trustworthySerpCoveragePercent` separately report trustworthy child SERP observations.

A materialized child with failed, pending, or otherwise untrustworthy SERP evidence is not mislabeled as observed. Unmaterialized or unobserved counterfactual outcomes stay unknown; they are never converted to zero or treated as negative evidence.

The replay reports deterministic pre-SERP selection/churn metrics and observed-only child evidence. It does not compute an automatic winner or opportunity conclusion.