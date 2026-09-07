# Current Runner Development Roadmap

## Status and authority

This file is the **current development-sequencing document** for Utility Research Runner.

It answers:

```text
what should we improve next?
why is that work worth doing?
what existing mechanisms should it reuse?
what observable result should the operator get?
```

It is **not runtime truth**. Implemented behavior remains authoritative in the active contracts, code, schemas, tests, and CLI help described by `AGENTS.md`. If this roadmap disagrees with merged behavior, do not reinterpret the implementation to fit the roadmap; re-establish actual behavior and update the roadmap.

Files under `docs/history/` remain frozen history. Files under `docs/plans/` remain inactive future planning unless explicitly activated. In particular, V3 commercial evidence is not activated by this roadmap.

## Current position

The runner already has a substantial accepted baseline:

- config-first `research:plan` / `research:run` orchestration through a stable `researchId`;
- read-only `research:status` with current lifecycle state, evidence gaps, and next operator action;
- read-only `research:audit` integrity/degradation checklist over existing status/evidence-health projections;
- immutable-generation `research:diff`;
- durable SQLite truth, immutable discovery/enrichment generations, and explicit lineage;
- explicit human gates for shortlist, finalist scope, and decisions;
- canonical copy/edit continuation examples for the normal human gates;
- repair of failed or provably incomplete primary discovery checkpoints;
- bounded retry/rate-limit/circuit-breaker behavior in existing provider paths, including sustained Google availability failures;
- Expansion Admission V1.1 plus version-compatible historical behavior;
- deep enrichment, finalization, evidence coverage, and immutable Research Library publication;
- run-quality accounting and derived Research Library snapshot-health checks;
- read-only Research Library navigation through logical research and publication lineage views;
- bounded first-party Search Console ZIP import into a separate immutable search-traction evidence store.

Therefore the next roadmap must **not** restart already completed V2/config-first work under new names.

## Decision filters for roadmap work

A roadmap item should survive all of these questions before implementation:

1. **Operator value** — does it remove repeated manual work, make a run easier to trust, or materially improve research throughput?
2. **Evidence honesty** — does it preserve `missing != zero`, `unknown != negative`, provider-specific semantics, and explicit provenance?
3. **Reuse before abstraction** — can it compose current status, run-quality, checkpoints, Library, or planner contracts rather than inventing a parallel framework?
4. **Bounded complexity** — is the implementation smaller than the operational problem it solves?
5. **Measured need** — for speculative optimizations, do real runs demonstrate the bottleneck?
6. **No autonomous business decisions** — does the runner remain an evidence engine rather than a product/monetization recommender?

If an item fails these filters, defer or drop it.

---

# Sequenced backlog

## R0 — Documentation consolidation and roadmap authority

**Status:** complete; merged in PR #155.

### Why

Previous implementation roadmaps are intentionally frozen under `docs/history/`, while `docs/plans/` is intentionally inactive. Without one current sequencing surface, conversational backlog can accidentally duplicate implemented features or reactivate stale plans.

A fresh audit already found two such false gaps:

- `research:status` already exists and is part of the accepted baseline;
- `research:diff` already exists, and config-first planner/status already expose human-gate state and next actions.

### Means

- keep runtime contracts in the existing root documents;
- add this root `ROADMAP.md` as current **planning-only** sequencing;
- link it from the active documentation map and agent instructions;
- keep `docs/history/` frozen;
- keep `docs/plans/v3/` explicitly inactive;
- do not copy implementation details into multiple documents merely to make the roadmap look complete.

### Result

There is one obvious answer to “what are we building next?” without weakening the existing documentation-authority model.

---

## R1 — Read-only research integrity audit surface

**Status:** complete; merged in PR #156 and implemented by `research:audit`.

### Why

`research:status` already answers the operational question:

> What state is this research in, what evidence is missing, and what should I do next?

That should not be replaced.

The remaining gap was a different question:

> Before I hand this research to analysis, is its current durable/projection state internally trustworthy, and what exactly is degraded?

The repository already contained most of the underlying evidence in separate mechanisms, including run-quality accounting, deep evidence coverage, current-parent/finalization freshness checks, research-container invariants, sampled historical-presence coverage, and Research Library derived-snapshot health. The correct implementation therefore composes existing truth rather than creating a second quality model.

### Implemented means

Read-only operator commands:

```bash
npm run research:audit -- --research <research-id>
npm run research:audit -- --research <research-id> --json
```

The audit reuses `research:status` and its existing evidence-health projections. It does not call providers, mutate SQLite, repair checkpoints, publish artifacts, or persist a new quality store.

The checklist covers the currently applicable high-value integrity/degradation facts:

- successful durable/status projection and modern-vs-legacy audit coverage;
- discovery terminal/open/partial/failed/repairable state;
- existing run-quality warnings;
- latest enrichment state and persisted module error/open/not-attempted counts;
- finalization state and derived-artifact currentness warnings already exposed by status;
- deep evidence-coverage warnings;
- sampled historical-presence warnings under bounded sampled-presence semantics;
- current Research Library publication lookup and derived-snapshot health.

Output states are:

```text
PASS
WARN
FAIL
NOT_APPLICABLE
UNKNOWN
```

with deliberately conservative semantics:

- `PASS` means no degradation was observed among currently applicable checks, not that every downstream stage has run;
- `WARN` preserves incomplete/degraded/optional evidence and stale/repairable derived artifacts without pretending durable truth is corrupted;
- `FAIL` is reserved for a failed durable/status projection or an internally contradictory projected current-state relationship;
- `NOT_APPLICABLE` means the downstream check does not apply at the current workflow stage;
- `UNKNOWN` means a relevant integrity fact could not be established.

Warnings do not fail the process. Audit failures return non-zero; invalid input/unknown targets remain a separate invalid-input class.

### Constraints retained

- read-only;
- no provider/network calls;
- no state repair as a side effect;
- no new scoring/recommendation model;
- no duplicate durable truth;
- existing status/run-quality/health functions remain authoritative;
- machine-readable JSON plus concise human output;
- incomplete optional evidence does not masquerade as success, but also does not become corruption.

### Result

Before analyzing a run or sharing its ZIP, the operator has one deterministic checklist that distinguishes a clean current-stage projection from warning-level evidence degradation and from hard inability to establish a trustworthy current projection.

---

## R2 — Operator-friction audit and targeted continuation polish

**Status:** complete; merged in PR #157.

### Why

A conversational backlog previously assumed continuation was still highly manual. Current implementation evidence showed otherwise:

- `research:status` exposes a durable next action and command where appropriate;
- `research:plan` validates continuation against durable state;
- `research:run --research <id>` replans/resumes recoverable unfinished work without inventing human input;
- shortlist/finalist/decision gates remain explicit by design.

The concrete remaining friction was narrower: operators still had to remember the exact continuation envelope/action shape even after the runner identified the unresolved human gate.

### Implemented means

- canonical copy/edit examples for shortlist continuation;
- canonical explicit/all finalist-scope examples;
- canonical human-decisions continuation example;
- declaring-file-relative path semantics documented alongside the examples;
- tests that run the normal-gate examples through the authoritative `OperatorContinuationV1` validator.

No new CLI, planner schema, durable continuation subsystem, generated human decision, or weakened gate was added.

### Result

The runner now supplies safe canonical shapes for the normal human gates while keeping the human input itself explicit and auditable.

---

## R3 — Provider resilience consistency audit and targeted fixes

**Status:** complete for the evidence-backed defect found; merged in PR #158.

### Why

The runner already had retries, repairable partial checkpoints, rate limiting, circuit breakers, browser preflight, durable resume, and provider-specific error handling. A generic resilience rewrite would have rebuilt mature infrastructure.

The audit found one concrete inconsistency in discovery: `GOOGLE_UNAVAILABLE` was the only retryable discovery error and exhausted its bounded per-keyword retry budget, but an exhausted availability failure did not count toward the existing run-level Google consecutive-failure breaker. A sustained navigation/availability outage could therefore repeat the full retry budget across a large remaining corpus.

### Implemented means

- keep `GOOGLE_UNAVAILABLE` retry eligibility and retry budget unchanged;
- after that per-keyword budget is exhausted, count it together with `GOOGLE_SERP_PARSE_ERROR` in the existing `googleConsecutiveThreshold` sequence;
- retain one existing Google breaker setting rather than introduce a parallel threshold;
- reset the streak on a healthy collection result as before;
- add policy tests for availability-only, mixed Google failure sequences, and reset semantics;
- add an engine-level regression proving the run pauses before outage fan-out reaches untouched later keywords.

Persisted breaker state, repair semantics, Ahrefs/RDAP/first-seen behavior, and provider abstractions were not changed.

### Result

A sustained Google outage now becomes a bounded resumable pause after repeated exhausted keyword-level failures instead of multiplying retry work across the remaining corpus.

Further R3 work requires another concrete provider inconsistency; do not keep normalizing provider code for aesthetics.

---

## R4 — Cost-aware progressive enrichment

**Status:** measurement complete on the available representative deep-enrichment corpus; no implementation change justified.

### Why

The runner already bounds expensive deep work through explicit shortlists, explicit configured modules, finalist scope, and bounded domain allocation. That is already a real form of progressive enrichment.

The available completed 30-keyword deep-enrichment/finalization corpus was inspected against durable SQLite and derived operator artifacts rather than inferred from ZIP size or later intuition. The full enrichment generation took about 16.4 minutes wall-clock, so additional deterministic skips could matter operationally if a valid pre-call predicate existed; this measurement does not attribute that duration to individual modules.

The measured downstream relationships did **not** expose such a skip:

- all 30 shortlisted keywords produced 30 clusters and all 30 clusters entered representative/finalist scope;
- all 30 query-suggestion parent keywords were also representative keywords;
- all 87 fetched page targets were present in entrant-cohort ranking URLs;
- all 30 domains actually selected for `domain_age` were present in entrant cohorts;
- all 30 domains actually selected for `site_structure` were present in entrant cohorts;
- 194 candidate domains were observed for bounded domain evidence; the 164 beyond the cap were persisted as explicit omissions without provider work (`domain_age`: `not_attempted` / `domain_cap`; `site_structure`: omitted `maxDomains` checkpoints), rather than provider fan-out.

`query_suggestions`, `pages`, and `domain_age` are also explicit standalone enrichment evidence surfaces with their own durable/exported artifacts. The fact that a later finalist-matrix projection does not directly consume every field is therefore not a valid pre-call skip predicate. Treating later non-consumption as waste would be hindsight and would silently change configured enrichment semantics.

### Re-activation gate

Do not build a progressive-enrichment scheduler from this corpus.

Re-open R4 only when another representative real corpus demonstrates **material avoidable provider work that can be identified before the provider call** from evidence already available at that point. A valid future predicate may use facts such as:

```text
required parent evidence exists?
target entity actually materialized?
current human shortlist/finalist scope includes it?
provider/module is configured for this stage?
```

A later artifact merely failing to consume earlier evidence is not enough. Any future skip must also be durably explainable (`skipped` + reason/policy provenance where appropriate), not converted into missing/zero evidence.

This track must not introduce opaque opportunity scoring or automatically decide which product/niche deserves research.

### Result

R4 is closed with **no scheduler implementation** on current evidence. Existing shortlist/module/domain caps remain the correct cost guards. The track becomes active again only if a later real corpus proves a deterministic, material pre-call waste pattern.

---

## R5 — Research Library navigation surfaces

**Status:** complete; merged in PR #159 and implemented via `library:list` and `library:inspect`.

### Why

`library.sqlite` already provides cumulative durable publication truth, and `research:diff` already compares explicit immutable discovery/enrichment generations. The missing value was easier **navigation of accumulated research**, not another comparison engine.

### Implemented means

Read-only operator commands:

```bash
npm run library:list
npm run library:list -- --json
npm run library:inspect -- --research-path <persisted-research-path>
npm run library:inspect -- --research-path <persisted-research-path> --json
```

The navigation surface:

- reads `research-library/library.sqlite` directly;
- groups immutable publications by persisted `research_relative_path` rather than display name;
- shows logical research version count and current publication;
- exposes source run, enrichment id, publication time, fingerprint, and normalized counts;
- inspects the full immutable publication lineage for one exact logical research;
- uses persisted `published_at, rowid` ordering, matching Library lineage relinking including equal-timestamp ties;
- treats an uninitialized Library as an honest empty `library:list` state;
- fails explicitly for unsupported schema or an unknown inspect target.

It does not read derived `library.json` as truth, publish/repair/regenerate snapshots, introduce another index/database, add embeddings/search infrastructure, or create a dashboard/server.

`research:diff` remains the factual generation-diff surface and is not duplicated by Library navigation.

### Result

The cumulative Library can be browsed and traced through immutable versions without leaving the local-first SQLite truth model.

---

## R6 — Expansion quality evaluation telemetry

**Status:** first downstream-lineage pilot complete; observation/analysis remains active, but no implementation or policy change is justified. **Do not change V1.1 now.**

### Why

Expansion V1.1 was adopted from preserved evidence through offline replay and deliberately made the minimal comparator change. The persistence linkage needed for downstream evaluation already existed, so no new telemetry subsystem was required.

One completed lineage can now be evaluated end to end. Its persisted V1 source run contained 240 deliberate roots, 652 raw unique admission candidates, 558 eligible candidates, and a 300-keyword expansion budget. All 300 selected expansion children materialized with observed organic-result counts, known Score, complete scoring, and known Surfer volume, so the downstream pilot is not distorted by missing child evidence.

The later human-selected 30-keyword enrichment/finalization scope contained:

- 25 deliberate roots;
- 5 selected expansion children;
- 30 resulting clusters, all carried into representative/finalist scope.

Those five observed expansion contributions were all B-tier candidates. However, shortlist inclusion must not be treated as a universal binary quality label: the human shortlist overlapped the raw top-30-by-Score set on only 10/30 keywords, so it also encoded selection/diversity judgment. The observed 5/300 expansion-child shortlist rate versus 25/240 for roots is therefore descriptive lineage evidence, not a causal policy-quality comparison.

The support-first replay that motivated V1.1 changes only 2/300 selections on this corpus. It retains all five observed expansion children that later entered finalist scope. Its two newly admitted broadening candidates were not materialized in the historical V1 run, so their post-SERP outcome remains unknown; the two displaced V1 children were materialized and did not enter the later shortlist. More aggressive replay positions change 5/300 or 7/300 selections and also retain the five observed downstream hits, but their newly admitted counterfactuals are likewise unmaterialized. That is more churn without evaluable evidence of downstream improvement.

### Evaluation rule

Continue R6 only as post-hoc evaluation over preserved immutable evidence:

```text
fix selection from pre-SERP admission evidence
→ attach only later observed child/SERP/scoring evidence
→ attach human shortlist/finalist outcomes
→ keep unmaterialized counterfactuals unknown
```

Do not use post-SERP evidence to retroactively rewrite historical admission decisions. Do not interpret absence from one human shortlist as proof that a keyword was bad. Do not silently change fresh-run policy.

Additional independent downstream corpora are still needed before generalizing the pilot. Only a repeated, quantified failure mode that survives those semantic caveats can justify proposing another versioned admission policy.

### Result

The existing persisted evidence is sufficient for R6 evaluation without extra telemetry implementation. The first end-to-end downstream pilot gives no evidence-backed reason for V1.2 or for a more aggressive comparator. V1.1 remains current while future real research naturally accumulates additional independent downstream corpora.

---

## R7 — First-party search-traction import

**Status:** complete in the current implementation baseline via `search-traction:import`.

### Why

Existing `traffic evidence` is competitor/domain-or-URL traffic evidence around finalist cohorts. It is **not** the same thing as first-party search-query traction from our own launched tools.

Real Search Console ZIP exports from two live projects now provide enough first-party evidence to establish the import contract from observed files rather than guesses.

### Implemented means

The bounded V1 surface is:

```bash
npm run search-traction:import -- \
  --input <gsc-performance-export.zip> \
  --property <explicit-search-console-property>
```

It:

- accepts the observed English Search Console Performance ZIP contract (`Chart`, `Queries`, `Pages`, `Countries`, `Devices`, `Search appearance`, `Filters`);
- requires explicit property identity rather than inferring it from filenames;
- keeps daily/query/page/country/device/search-appearance aggregates separate rather than fabricating joint rows;
- preserves export filter descriptors separately from the actual date range present in `Chart.csv`;
- retains source labels and null numeric states without silent semantic normalization;
- exposes neutral per-dimension totals/ratios to Chart totals, explicitly allowing ratios above or below 100% rather than mislabelling them as universal coverage;
- persists immutable normalized snapshots in a dedicated `first-party-search/search-traction.sqlite`;
- retains/restores the exact source ZIP for auditability;
- identities snapshots by explicit property + source SHA-256 + parser semantics version, so later parser semantics cannot silently reinterpret old evidence.

See `SEARCH_TRACTION.md` for the runtime contract.

### Non-goals retained

No live GSC connector/OAuth, automatic research attachment, automatic cluster matching, cross-dimensional synthesis, scoring, or expansion-policy change is included.

A direct GSC integration remains a later convenience decision only if repeated manual ZIP export/import becomes a measured problem.

### Result

The Runner can accumulate first-party Search Console evidence from real launched projects while keeping it semantically and durably separate from competitor traffic estimates.

---

# Explicitly deferred / inactive tracks

## Wordstat

Wordstat API integration is deferred. Localization research does not currently justify adding another provider, and manual/existing research paths are sufficient for the present need.

Do not implement Wordstat merely because an earlier handoff listed it as the next task. Re-activate only when automated Yandex-specific evidence solves a measured repeated problem; re-verify access, pricing, quotas, and semantics at that time.

## V3 commercial evidence

`docs/plans/v3/` remains **inactive future planning**.

The direction is retained because it is useful: combine current SEO evidence with observable commercial ecosystem evidence and, when available, first-party traction. The planned baseline remains free-first and evidence-oriented rather than an automatic business recommendation engine.

Activation requires an explicit future decision. When activated, current provider access/pricing/terms must be re-audited before implementation.

## Expansion V1.2

No V1.2 is planned. V1.1 remains current unless R6 produces new repeatable evidence that justifies a versioned policy change.

## Generic provider/plugin framework, GUI, autonomous scoring

Still non-goals unless a concrete future requirement proves that the existing architecture cannot support the needed work economically.

---

# Delivery workflow for every implementation item

Use the repository's established engineering workflow:

```text
implementation
→ PR
→ cold independent review
→ fixes
→ exact-head CI on Ubuntu + Windows
→ final re-review
→ squash merge
→ next item
```

Rules:

- one bounded technical scope per PR;
- after any code/test fix, previous CI evidence is stale and exact-head CI must be rerun;
- check base drift and unresolved review threads before merge;
- update active documentation in the same PR when merged behavior changes;
- do not let roadmap wording override evidence found during implementation.

## Immediate next action after R7

Use the completed R1–R7 surfaces on real research work rather than manufacturing another implementation item.

R4 measurement is complete and does not justify scheduler work. R6 now has one end-to-end downstream lineage pilot and still does not justify telemetry code or V1.2; accumulate additional independent downstream corpora through normal research before reconsidering policy. Wordstat and V3 remain inactive without a new measured need.
