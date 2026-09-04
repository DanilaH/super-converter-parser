# FULL_RUNS.md

## Purpose

This file describes the current operator orchestration surfaces.

The accepted normal path is **config-first**. Direct stage CLIs remain supported for specialist/manual operation and debugging.

## 1. Config-first normal flow

Start from a versioned operator config:

```bash
npm run research:plan -- --config research.config.json
npm run research:run -- --config research.config.json
```

A canonical example is available at:

```text
configs/examples/research.config.json
```

The first successful config-driven creation returns a stable `researchId`.

Continue that exact logical research with:

```bash
npm run research:plan -- --research <research-id> [--continue continuation.json]
npm run research:run  -- --research <research-id> [--continue continuation.json]
```

Do not copy generated discovery/enrichment IDs into continuation files. The runner resolves current generated identities from durable research state.

### Human gates

The config describes the maximum desired workflow target. It does not bypass human requirements.

The workflow may stop at states such as:

```text
awaiting_shortlist
awaiting_finalist_scope
awaiting_decisions
```

Supply only the explicit continuation input requested by the current plan/status.

### Resume without new human input

For a configured existing research with recoverable unfinished work:

```bash
npm run research:run -- --research <research-id>
```

The executor acquires the relevant execution boundary, re-reads durable state, and replans before continuing. It does not infer the target from folder order or label.

## 2. Plan/status before mutation

Read-only planning:

```bash
npm run research:plan -- --research <research-id> --json
```

Read-only status:

```bash
npm run research:status -- --research <research-id> --json
```

Use these to determine current discovery/enrichment/finalization/publication state and the next explicit operator input.

Neither surface should invent a product/business recommendation.

## 3. Direct full discovery

The legacy/direct convenience alias remains:

```bash
npm run discovery:full -- --seeds input/seeds.csv --name my-research
```

or:

```bash
npm run discovery:full -- --microsoft input/microsoft.csv --name my-research
```

`discovery:full` is the direct discovery CLI with depth-one expansion enabled.

Current fresh expansion uses **Expansion Admission V1**:

```text
all roots collect primary + raw Related evidence
        ↓
all roots terminal
        ↓
global deterministic admission frontier
        ↓
selected expansion children only
```

The global additions budget is:

```text
min(500, ceil(originalKeywordCount * 1.25))
```

Current diagnostics include `expansion-admission.json` and `.csv` for V1 runs.

Ahrefs remains optional unless `--require-ahrefs` is explicitly supplied.

## 4. Discovery resume and repair

Ordinary unfinished-run resume:

```bash
npm run research -- --resume <run-id>
```

Explicit repair:

```bash
npm run research -- --resume <run-id> --retry-failed
```

Despite the historical flag name, the current repair path covers failed primary checkpoints and provably incomplete repairable partial primary checkpoints. It preserves prior attempt evidence.

## 5. Append another seed batch

```bash
npm run research:append -- --to <research-id-or-run-id> --seeds input/more-seeds.csv
```

Append advances one logical research through immutable combined discovery generations.

A new generation may result from:

- genuinely new keywords; or
- explicit promotion of a prior expansion child into a root seed.

A promotion-only append can therefore have `addedKeywordCount = 0` while still creating a new generation.

For V1 expansion forks, raw Related evidence may carry forward, but previous-generation selection flags are not current truth and the new generation recomputes its own frontier.

See [`RESEARCH_BATCHES.md`](./RESEARCH_BATCHES.md).

## 6. Direct full enrichment

```bash
npm run enrich:full -- --run <current-run-id> --shortlist-file input/shortlist.txt
```

The current full module set is:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

Shortlist-dependent work requires an explicit 5–200 source-run keyword shortlist.

Resume the same enrichment generation with:

```bash
npm run enrich -- --resume <enrichment-id>
```

A persisted `running` generation is not blindly assumed dead. Recovery is guarded by the per-enrichment execution lock so a live concurrent owner is not reset.

## 7. Direct full finalization

After current enrichment, the accepted finalization chain is:

```text
representative queries
        ↓
entrant cohort
        ↓
bounded Common Crawl sampled historical presence
        ↓
cohort history
        ↓
optional/reused compatible traffic evidence
        ↓
finalist evidence matrix
        ↓
human decisions
        ↓
Research Library publication when allowed
```

Direct command example:

```powershell
npm run finalize:full -- --enrichment <enrichment-id> `
  --clusters cluster-1,cluster-2 `
  --young-domain-max-age-days 730 `
  --recent-web-presence-max-age-days 730 `
  --repurpose-gap-min-days 365 `
  --decisions .\decisions.json
```

The threshold values are example methodology policy, not universal SEO truth.

### Finalist scope

The first representative generation requires explicit scope:

```bash
--clusters cluster-1,cluster-2
```

or deliberate all-cluster selection:

```bash
--all-clusters
```

A compatible persisted representative scope may be reused on later reruns. `finalize:full` never silently treats all clusters as finalists on first use.

### Sampled historical presence

Current `finalize:full` automatically executes the bounded Common Crawl sampled-presence stage after entrant cohort.

This evidence means:

```text
bounded sampled web presence in selected collections
```

It does **not** mean exact first-ever web presence or exact site age.

The stage preserves distinct `not_found`, `not_attempted`, `unavailable`, `error`, omission, and incomplete-traversal semantics.

### Cohort-history policy

The first compatible cohort-history projection requires the explicit supported methodology thresholds. Later reruns may reuse compatible persisted policy.

### Traffic

Traffic remains optional external evidence.

Example import during direct finalization:

```powershell
npm run finalize:full -- --enrichment <id> ... `
  --traffic .\traffic.csv `
  --low-base-organic-traffic-threshold 1000 `
  --decisions .\decisions.json
```

If compatible traffic snapshots/policy already exist, finalization may reuse/reproject them. If no traffic exists, traffic remains missing rather than fabricated.

### Human decisions

`--decisions <path>` uses the existing strict finalist-decision contract.

If current decisions are incomplete, finalization stops successfully after rebuilding current evidence and reports the unresolved decisions.

For deliberate evidence-only publication:

```bash
--publish-without-decisions
```

This escape hatch is explicit and never implied by full mode.

## 8. Direct specialist finalization commands

The individual commands remain supported:

```bash
npm run representatives -- ...
npm run entrant-cohort -- ...
npm run cohort-historical-presence -- ...
npm run cohort-history -- ...
npm run traffic-evidence -- ...
npm run finalist-evidence -- ...
npm run library:publish -- ...
```

These direct finalization entrypoints share the research execution serialization boundary with config-first finalization. They must not mutate the same research concurrently with another finalization workflow.

## 9. Manual Research Library publication

```bash
npm run library:publish -- --enrichment <completed-enrichment-id>
```

`library.sqlite` is durable publication truth.

Publication is immutable/idempotent for one public fingerprint. Later current versions of the same logical research form a superseding lineage.

Derived `library.json`, `library.zip`, and per-publication archives can be repaired without rerunning upstream evidence when durable Library truth already exists.

See [`RESEARCH_LIBRARY.md`](./RESEARCH_LIBRARY.md).

## 10. Compare immutable generations

```bash
npm run research:diff -- --research <research-id> --from discovery:1 --to discovery:2
npm run research:diff -- --research <research-id> --from enrichment:1 --to enrichment:2
```

The diff reports factual changes only. It does not decide whether a generation is semantically better or an opportunity became stronger.

## Why stages are still separable

Config-first orchestration reduces remembered IDs/flags, but the underlying stages remain intentionally separable because they have different inputs and evidence boundaries:

- discovery can run from deterministic input and provider configuration;
- append explicitly mutates one research lineage;
- enrichment may require a human shortlist;
- finalization requires explicit finalist/methodology choices and may require human decisions;
- Library publication has its own immutable publication contract.

The orchestrator forwards those choices. It does not invent them.

## Recommended operator sequence

For normal new work:

```text
1. author/choose config
2. research:plan
3. research:run
4. record stable researchId
5. research:status / research:plan
6. provide only the requested continuation input
7. research:run --research ... --continue ...
8. repeat until completed/published or intentionally stopped
```

Use direct stage CLIs when you specifically need lower-level control, debugging, repair, or an existing legacy workflow.