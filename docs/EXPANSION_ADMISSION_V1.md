# Expansion admission V1

Discovery expansion remains depth-one, but V1 separates Related collection from SERP admission.

## Lifecycle

1. Collect every original (depth-zero) keyword and persist its raw Surfer Related outcome in `run.sqlite`.
2. Do not append Related candidates while original keywords are still unfinished.
3. When every original keyword is terminal, build one deterministic global frontier from durable `related_keywords` rows.
4. Persist selected flags and append only the final admitted candidates to the discovery keyword queue.
5. Collect SERP evidence for those admitted candidates. Expansion children never expand again.

A pause or crash before frontier materialization leaves only raw Related evidence. Resume rebuilds the frontier from SQLite. Materialization is idempotent and monotonic: already committed V1 expansion keywords are never silently removed; remaining budget may be topped up when durable Related evidence changes through an explicit repair/retry.

## Versioning

Fresh production discovery runs stamp `expansion.admissionVersion = "v1"` into the existing SQLite `config_snapshot`.

- `v1`: use global deterministic admission.
- missing marker: historical run; preserve legacy immediate per-parent expansion on resume.
- unknown marker: fail closed instead of mixing algorithms inside one run.

The marker is an implementation version, not an operator-authored semantic setting. Operator semantic fingerprints continue to be built from their explicit resolved fields.

## V1 policy

The pure policy lives in `src/runs/expansionAdmission.ts`.

- exact existing keywords are rejected;
- single-token automatic expansion candidates are rejected; direct seeds are unrestricted;
- existing `minOverlap`, `minVolume`, and `maxCandidatesPerKeyword` constraints still apply;
- parent support is bucketed at 1 / 2 / 3+;
- strict lexical broadening is deprioritized, not hard-rejected;
- directional phrases remain distinct;
- added-keyword budget is `min(500, ceil(originalKeywordCount * 1.25))`.

For 280 original keywords, V1 can add at most 350 expansion keywords, for at most about 630 discovery keywords total.

## Diagnostics

After frontier materialization discovery publishes:

- `expansion-admission.json`
- `expansion-admission.csv`

They preserve the decision, reason, support, overlap, volume, broadening flag, committed state, and final selection state for every observed candidate. These artifacts are diagnostics; SQLite remains durable truth.

`run-quality.json` version `1.1.0` also projects V1 admission accounting from the same durable Related evidence through the production `buildExpansionAdmission()` policy. It keeps different units explicit:

- `selectedRows` is the historical compatibility field and counts selected parent→child occurrence rows;
- `selectedOccurrenceRows` names that occurrence-level unit explicitly;
- `rawUniqueCandidateCount` and `eligibleUniqueCandidateCount` count normalized unique candidates;
- `policySelectedUniqueKeywordCount` is the current V1 policy selection from durable evidence;
- `selectedUniqueKeywordCount` counts durably committed expansion keywords in the run;
- `policyRejectedUniqueCandidateCount` and `policyRejectionReasonCounts` describe current V1 policy rejections, which can differ from durable final selection after monotonic repair/top-up history.

The V1 projection is emitted only when the persisted run has `expansion.admissionVersion = "v1"`; historical runs do not receive fabricated V1 accounting. The old `explicitOmissionCount` / `omissionAccounting` fields remain compatibility-only and are not redefined.

## Offline comparator replay

`npm run expansion:replay -- --run <run-id>` is a read-only experiment surface for preserved V1 discovery runs. It does not mutate `run.sqlite`, call providers, change admission, or write a new discovery generation.

The replay keeps V1 eligibility, per-parent caps, thresholds, and the global budget fixed. It compares only the position of the existing `broadeningOnly` signal in the global comparator:

- `v1`: broadening → parent support → overlap → bounded specificity → Related volume;
- `broadening_after_support`: parent support → broadening → overlap → bounded specificity → Related volume;
- `broadening_after_overlap`: parent support → overlap → broadening → bounded specificity → Related volume;
- `broadening_last`: parent support → overlap → bounded specificity → Related volume → broadening.

Selection and evaluation are deliberately separate. `buildExpansionReplaySelections()` accepts only the same pre-SERP Related evidence used by admission. Existing child SERP/scoring evidence is connected later by `evaluateExpansionReplay()` and cannot affect any comparator.

Counterfactual evidence is incomplete by construction: candidates rejected by the historical V1 run normally have no collected child SERP. Replay therefore reports post-hoc metrics only for durably collected child keywords and exposes `durableChildCoveragePercent` plus `counterfactualUnknownCount`. Missing counterfactuals stay unknown; they are never converted to zero or treated as negative evidence.

The replay reports deterministic pre-SERP selection/churn metrics and observed-only child evidence, but it does not compute or recommend an automatic winner. A production admission version change requires a separate decision after reviewing replay coverage and candidate-level churn.
