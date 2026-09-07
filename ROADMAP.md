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
- immutable-generation `research:diff`;
- durable SQLite truth, immutable discovery/enrichment generations, and explicit lineage;
- explicit human gates for shortlist, finalist scope, and decisions;
- repair of failed or provably incomplete primary discovery checkpoints;
- bounded retry/rate-limit/circuit-breaker behavior in existing provider paths;
- Expansion Admission V1.1 plus version-compatible historical behavior;
- deep enrichment, finalization, evidence coverage, and immutable Research Library publication;
- run-quality accounting and derived Research Library snapshot-health checks.

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

**Status:** delivered by the roadmap/documentation consolidation in PR #155; complete once that PR is merged.

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

**Status:** committed next runtime track, subject to normal PR review/CI.

### Why

`research:status` already answers the operational question:

> What state is this research in, what evidence is missing, and what should I do next?

That should not be replaced.

The remaining gap is a different question:

> Before I hand this research to analysis, is its current durable/projection state internally trustworthy, and what exactly is degraded?

The repository already contains much of the underlying evidence in separate mechanisms, including run-quality accounting, deep evidence coverage, current-parent/finalization freshness checks, research-container invariants, and Research Library derived-snapshot health. The useful change is to **compose existing truth**, not create a second quality model.

### Intended means

Add a read-only operator command, tentatively:

```bash
npm run research:audit -- --research <research-id>
npm run research:audit -- --research <research-id> --json
```

The exact check set must be derived from current contracts during implementation. The bounded target is to cover existing high-value integrity facts such as:

- stable research/container lineage and current generation identity;
- current discovery terminal/open/repairable state;
- current run-quality/provider coverage and warnings without rounding missing evidence into success;
- current enrichment parent identity and completion/error state;
- stale/current finalization parent projections already detectable by current code;
- evidence-coverage warnings and explicit unavailable/missing states;
- Research Library publication/derived-snapshot consistency when applicable.

Output should use explicit states such as:

```text
PASS
WARN
FAIL
NOT_APPLICABLE
UNKNOWN
```

where the semantics genuinely differ. A warning must not silently become failure, and missing optional evidence must not be presented as corruption.

### Constraints

- read-only;
- no provider/network calls;
- no state repair as a side effect;
- no new scoring/recommendation model;
- no duplicate durable truth;
- reuse existing status/run-quality/health functions where possible;
- machine-readable JSON plus concise human output;
- tests must prove that incomplete evidence cannot masquerade as a clean audit.

### Result

Before analyzing a run or sharing its ZIP, the operator can run one deterministic integrity check and distinguish:

```text
structurally trustworthy but evidence-partial
```

from:

```text
internally stale/inconsistent and unsafe to interpret
```

This should reduce manual artifact inspection while strengthening measurement honesty.

---

## R2 — Operator-friction audit and targeted continuation polish

**Status:** evidence-gated; do not implement a generic continuation layer by default.

### Why

A conversational backlog previously assumed continuation was still highly manual. Current implementation evidence shows otherwise:

- `research:status` exposes a durable next action and command where appropriate;
- `research:plan` validates continuation against durable state;
- `research:run --research <id>` replans/resumes recoverable unfinished work without inventing human input;
- shortlist/finalist/decision gates remain explicit by design.

So “build continuation UX” is not currently a justified standalone project.

### Means

Use real operator runs after R1 and record only repeated mechanical friction that remains, for example:

- repeatedly authoring structurally identical continuation envelopes;
- copying an identifier/path that the runner could resolve safely from durable state;
- unclear next-action output despite sufficient persisted context.

Only then implement the smallest targeted convenience. Generated templates or a shorthand command are acceptable **only if** they preserve explicit human input and declaring-file path semantics.

### Result

If a real repeated friction point exists, remove it without weakening the human gates. If none exists, close this track with no code.

---

## R3 — Provider resilience consistency audit and targeted fixes

**Status:** evidence-gated audit first; not a rewrite.

### Why

The runner already has retries, repairable partial checkpoints, rate limiting, circuit breakers, browser preflight, durable resume, and provider-specific error handling. A generic “resilience project” would risk rebuilding mature infrastructure.

The remaining useful question is whether individual provider paths classify equivalent failures inconsistently or force unnecessary operator intervention on large runs.

### Means

Audit current provider paths and real run diagnostics for concrete inconsistencies around classes such as:

```text
auth / configuration
rate limit / quota
timeout / transient transport
provider 5xx
browser preflight / CAPTCHA
parse / schema failure
deterministic provider rejection
```

For each proven inconsistency, define the smallest correction to:

- retry-now vs retry-later semantics;
- circuit-breaker behavior;
- `partial` / `failed` / `unavailable` representation;
- repair eligibility;
- attempt-history preservation;
- operator diagnostics.

Do **not** introduce a generic provider/plugin framework merely to normalize names.

### Result

Large runs become more boring to operate: isolated provider failures remain explicit and repairable without corrupting unrelated evidence or requiring broad reruns.

If the audit finds current behavior already consistent enough, this track closes without architectural churn.

---

## R4 — Cost-aware progressive enrichment

**Status:** design/evidence gate before implementation.

### Why

The runner already bounds expensive deep work through explicit shortlists and finalist scope. That is a real existing form of progressive enrichment.

A further optimization is useful only if real runs show that expensive provider/module work is still being executed for entities that cannot contribute useful downstream evidence.

### Means

First measure provider/module cost and skip opportunities on representative large runs. If material waste is demonstrated, design deterministic stage predicates such as:

```text
required parent evidence exists?
target entity actually materialized?
current human shortlist/finalist scope includes it?
provider/module is configured for this stage?
```

Any skip must be durably explainable (`skipped` + reason/policy provenance where appropriate), not converted into missing/zero evidence.

This track must not introduce opaque opportunity scoring or automatically decide which product/niche deserves research.

### Result

If justified, expensive work is concentrated on entities that can actually influence the requested evidence package, reducing runtime/provider cost without hiding omissions.

If measured savings are marginal, do not implement the extra scheduler complexity.

---

## R5 — Research Library navigation surfaces

**Status:** planned after integrity/operational work; scope must remain read-only and local-first.

### Why

`library.sqlite` already provides cumulative durable publication truth, and `research:diff` already compares explicit immutable discovery/enrichment generations. The missing potential value is easier **navigation of accumulated research**, not another comparison engine.

### Means

Audit current Library access patterns, then consider small read-only CLI surfaces such as:

```text
list published logical researches
inspect one publication lineage
show current/superseded publication history
locate source research/enrichment IDs and snapshot fingerprints
```

Names and exact commands are implementation decisions. Reuse `library.sqlite`; do not introduce another index/database, dashboard, server, embedding store, or destructive deduplication.

`research:diff` remains the factual generation-diff surface and should not be duplicated under a new `compare` command unless a distinct Library-level use case is proven.

### Result

The cumulative Library becomes easier to browse and reuse as the research corpus grows, while preserving its immutable publication model.

---

## R6 — Expansion quality evaluation telemetry

**Status:** future evidence-gated observation track. **Do not change V1.1 now.**

### Why

Expansion V1.1 was adopted from preserved evidence through offline replay and deliberately made the minimal comparator change. There is currently no evidence-backed reason to invent V1.2.

Future real runs can, however, tell us whether the admitted frontier is actually useful downstream.

### Means

Reuse persisted expansion decisions and later durable evidence to evaluate facts such as:

```text
candidate source / parent support / overlap / broadening
selected vs rejected reason
child materialized?
trustworthy SERP obtained?
entered a human shortlist?
contributed to a finalist cluster?
```

Keep this as evaluation/telemetry. Do not use post-SERP evidence to retroactively rewrite historical admission decisions, and do not silently change fresh-run policy.

Only a repeated, quantified defect across representative corpora can justify proposing another admission version.

### Result

Expansion evolves from observed failure modes rather than comparator experimentation for its own sake.

---

## R7 — First-party search-traction import

**Status:** later, when real project data is sufficient to justify it.

### Why

Existing `traffic evidence` is competitor/domain-or-URL traffic evidence around finalist cohorts. It is **not** the same thing as first-party search-query traction from our own launched tools.

Once projects accumulate useful Search Console data, real queries and landing pages can provide stronger feedback than only estimated keyword demand:

```text
Google actually showed/clicked our page for this problem
```

### Means

Start free and explicit with CSV/JSON import rather than a live connector. Preserve source semantics such as:

```text
query
landing page
country
device
period
impressions
clicks
position
```

Do not force this into the existing competitor `TrafficSnapshot` schema simply because both involve “traffic”. Link first-party facts to research keywords/clusters only where the relation is explicit and auditable.

A direct GSC integration is a later convenience decision after the import contract proves useful.

### Result

Research can be triggered or enriched by problems that demonstrably bring our own projects impressions/clicks, while keeping first-party observations distinct from third-party estimates.

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

## Immediate next action after R0

Begin R1 by auditing the existing status/run-quality/evidence-health functions and writing a bounded `research:audit` contract. If that implementation audit reveals that current surfaces already answer the integrity question completely, close R1 without redundant code and advance to the next evidence-backed item.
