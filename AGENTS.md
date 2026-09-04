# AGENTS.md

## Mission

Maintain **Utility Research Runner** as a reliable local-first research CLI for discovering and validating SEO opportunities for small browser utilities.

The repository is an internal research tool. Do not turn it into a generic SEO platform, hosted service, or autonomous product-decision engine without an explicit new requirement.

## Documentation authority

Do not treat every Markdown file in the repository as equally current.

For **implemented/current behavior**, read in this order:

1. `README.md` — current operator entry points and documentation map.
2. `PRODUCT.md` — current product boundary and non-goals.
3. `ARCHITECTURE.md` — durable state, identities, invalidation, locking, and system boundaries.
4. `PIPELINE.md` — current evidence flow and stage semantics.
5. Narrow authoritative contracts when relevant:
   - `SCORING.md`
   - `RESEARCH_BATCHES.md`
   - `RESEARCH_LIBRARY.md`
   - `FULL_RUNS.md`
6. Code, schemas, tests, and current CLI help are the final implementation evidence when documentation is ambiguous.

`*_ACCEPTANCE.md`, release acceptance files, old implementation plans, versioned roadmaps, methodology reports, and PR-specific design documents are **historical evidence unless a current document explicitly names one as active planning**. They must not override current runtime contracts.

In particular:

- `IMPLEMENTATION_PLAN.md` is historical v1 delivery history.
- `V2_1_IMPLEMENTATION_ROADMAP.md` is not the current backlog.
- V2.2 and V2.3 acceptance documents record completed release evidence.
- `CONFIG_FIRST_OPERATOR_UX_PLAN.md` records the now-implemented config-first track through operator acceptance; its old “next PR” language is historical.
- the local GUI track from PR #117 was closed unmerged and is not current work.
- `V3_COMMERCIAL_EVIDENCE_SPEC.md` and `COMMERCIAL_DATA_PROVIDER_MATRIX.md` are future/inactive planning, not current runtime requirements.

If an active document conflicts with merged code/tests, first establish actual behavior from the implementation, then fix the active documentation in the same focused change. Do not silently implement the stale prose.

## Current accepted baseline

The current runner includes:

- durable discovery with Google + Keyword Surfer and optional Ahrefs DR;
- bounded, versioned **Expansion Admission V1** with a global frontier for fresh V1 discovery runs;
- immutable append generations under one stable research identity;
- deep enrichment and clustering/evidence modules;
- representative queries and entrant cohorts;
- bounded Common Crawl sampled historical-presence evidence;
- cohort-history and optional traffic evidence;
- finalist evidence with explicit human decisions;
- immutable Research Library publication;
- config-first planning/execution through stable `researchId` continuation;
- read-only `research:status` and immutable-generation `research:diff`;
- explicit repair of failed or provably incomplete primary discovery checkpoints.

Do not restart completed V2.1/V2.2/V2.3/config-first roadmap work merely because a historical plan still contains unchecked prose.

## Core truth invariants

### Durable state

SQLite is durable truth.

CSV/JSON/Markdown/ZIP files are derived operator/publication surfaces. Never reconstruct resume/currentness truth from generated files when the SQLite state exists.

Historical discovery/enrichment generations are immutable. New append/re-enrichment work creates a new generation rather than rewriting old evidence.

### Research identity and lineage

A research has one stable identity anchored to its first discovery generation.

For a current research container:

```text
research.json.researchId == research.json.batches[0].resultRunId
research.json.currentRunId == research.json.batches[-1].resultRunId
```

Fail closed if those lineage invariants are broken.

Do not infer current research from timestamps, directory order, labels, or “latest” heuristics.

### Evidence honesty

Preserve distinctions such as:

```text
unknown != zero
missing != negative evidence
not_found != unavailable
not_attempted != checked
omitted != measured
error != empty
```

A numeric zero is valid only when the corresponding provider/source actually observed zero.

Google `gl/hl`, Keyword Surfer market, and detected physical Google location are separate facts.

### Human decisions

The runner may collect and project evidence. It must not fabricate:

- finalist scope;
- BUILD/WATCH/REJECT decisions;
- product feasibility conclusions;
- monetization viability;
- launch-success probability.

Human decisions remain explicit and pinned to their current evidence parents.

## Expansion Admission V1

Fresh V1 expansion does **not** append Related candidates immediately per parent.

The accepted lifecycle is:

```text
collect primary evidence + raw Related for every root
        ↓
all roots terminal
        ↓
build deterministic global admission frontier from durable Related evidence
        ↓
append only selected candidates
        ↓
collect SERP evidence for selected expansion children
```

Important V1 rules include:

- expansion depth remains 1;
- single-token automatic expansion candidates are rejected; explicit seeds are unrestricted;
- existing `minOverlap`, `minVolume`, and per-parent cap remain inputs;
- strict lexical broadening is deprioritized rather than universally rejected;
- global additions are bounded by `min(500, ceil(originalKeywordCount * 1.25))`;
- directional queries remain distinct;
- `expansion-admission.json` / `.csv` expose deterministic decisions and reasons;
- unsupported persisted admission versions fail closed;
- historical snapshots without the marker keep their historical semantics.

Do not add embeddings, LLM ranking, large blacklists, arbitrary new thresholds, or semantic dedupe unless real run evidence demonstrates a concrete need.

## Repair and resume

Ordinary resume continues unfinished work and does not reopen terminal checkpoints.

The explicit primary-repair surface is:

```bash
npm run research -- --resume <run-id> --retry-failed
```

Despite the historical flag name, the current repair surface includes:

- failed primary keyword checkpoints; and
- provably incomplete `partial` primary checkpoints where persisted source evidence establishes a repairable primary failure.

Do not reduce this contract back to “failed only”. Prior attempt evidence must remain durably journaled.

## Config-first operator contract

The accepted primary orchestration layer is config-first:

```bash
npm run research:plan -- --config research.config.json
npm run research:run -- --config research.config.json
npm run research:plan -- --research <research-id> [--continue continuation.json]
npm run research:run  -- --research <research-id> [--continue continuation.json]
```

Key rules:

- `ResolvedExecutionPlan` is an ephemeral projection, never a second durable state store;
- continuation targets an explicit stable `researchId`;
- stage semantic fingerprints do not replace existing evidence-parent fingerprints;
- authored relative paths resolve relative to the declaring JSON file;
- machine paths, CDP URL, cache path, credentials, timeouts, and secrets are not semantic research identity;
- human gates remain explicit;
- legacy specialist CLIs remain supported and should share the same underlying services/semantics where implemented.

Do not resurrect the closed local GUI work unless the user explicitly asks for it.

## Locking and concurrency

Do not weaken the current serialization boundaries.

Relevant lock order for research mutations is:

```text
execution -> batch -> discovery
```

Direct finalization commands and config-first finalization share the research execution boundary. Discovery execution is serialized per canonical durable output root. Enrichment execution is serialized per durable enrichment generation.

Lock identity must use canonical durable identity, not a path spelling alias, mutable label, or stale locator file.

## Browser and provider behavior

Use the dedicated Research Chrome profile.

Do not use or modify the user's daily Chrome profile.

If CAPTCHA appears, pause for manual completion. Do not add CAPTCHA-solving services, stealth frameworks, fingerprint spoofing, or proxy rotation intended to evade controls.

Use official Ahrefs API access only; do not scrape Ahrefs UI.

Provider calls must remain bounded in retries, time, bytes, redirects, and rate where the existing adapter contract requires it.

## Engineering workflow

For non-trivial runtime changes, use the repository's established loop:

```text
focused task
→ implementation
→ independent cold review
→ fix findings
→ re-review
→ exact-head Ubuntu + Windows CI
→ merge
```

Do not combine unrelated cleanup with analytical/runtime behavior changes.

Documentation-only changes should still receive a cold semantic review when they can influence agent behavior.

## Scope discipline

Do not add without explicit evidence/requirement:

- React/Next/dashboard;
- hosted service architecture;
- remote DB/Redis/queue infrastructure;
- LLM calls or AI opportunity scoring;
- generic provider/plugin frameworks;
- automatic finalist/business verdicts;
- deeper recursive Surfer expansion;
- V3 commercial evidence collection;
- a local GUI.

Prefer a small explicit implementation over a speculative generalized framework.

## Documentation maintenance rule

When merged behavior changes an operator command, durable invariant, evidence semantic, or workflow stage, update the relevant **current** contract in the same PR.

Do not rewrite historical acceptance evidence to pretend it always described the new behavior. Preserve history; keep current truth current.