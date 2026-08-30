# V2.2 Implementation Roadmap

**Status:** implementation-planning source of truth  
**Repository:** `DanilaH/super-converter-parser`  
**Baseline reviewed:** `main @ 975c42f3dc5596a53e5e688d3ceb4126f49eaf4f`  
**Release identity:** `V2.2 — Operator & Evidence Quality`  
**Purpose:** make the already-operational V2.1 runner easier to operate and harder to misread without turning V2.2 into a second methodology expansion or pulling V3 commercial-evidence work forward.

---

## 1. How to use this document

This roadmap is the engineering backlog for V2.2.

Current-state behavior remains documented by `README.md`, `FULL_RUNS.md`, `ARCHITECTURE.md`, `PIPELINE.md`, `RESEARCH_BATCHES.md`, `RESEARCH_LIBRARY.md`, and the implemented CLI/source code. `V3_COMMERCIAL_EVIDENCE_SPEC.md` and `COMMERCIAL_DATA_PROVIDER_MATRIX.md` remain future-planning sources of truth and are explicitly **not** current runtime contracts.

Do not rewrite current-state docs as if a roadmap item were already implemented. Update operator/current-state documentation only when the corresponding behavior is merged.

V2.2 is deliberately small. Its job is to improve operational visibility, uncertainty visibility, immutable-generation usefulness, and—only if live evidence supports it—restore a genuinely working historical web-presence signal.

---

## 2. Release goal

A V2.2 release is successful when, after a real research run, the operator can quickly answer all of the following without reconstructing state manually:

```text
What is the current discovery generation?
What work is complete / partial / failed / repairable?
What is the current enrichment generation and which modules are complete?
What finalist/finalization evidence is current or missing?
What important evidence coverage gaps could change interpretation?
What changed between two immutable research generations?
Do we have a real historical web-presence / first-seen observation,
  and if not, is that absence explicitly unavailable/missing rather than implied negative evidence?
```

This is a better V2.2 definition than “add more metrics”.

---

## 3. Engineering workflow

Every production roadmap item follows:

```text
task
→ implementation
→ cold review
→ fix findings
→ review again
→ merge
→ next task
```

Tests remain required where behavior is deterministic. Hosted CI is useful evidence only when project steps actually execute.

Known infrastructure failure shape:

```text
runner_id = 0
runner_name empty
steps = [] / null
immediate pre-step failure
```

That is not code-failure evidence and must not repeatedly stop V2.2 work. If hosted CI remains unavailable, finish static/cold review and deterministic tests, then use the final local gate:

```bash
npm ci
npm run typecheck
npm test
```

Do not claim tests passed unless they actually ran.

---

## 4. Hard V2.2 scope boundary

V2.2 must not become “V3 minus commercial”.

### Included

```text
bounded historical-source experiment
conditional production first-seen provider
research:status
coverage/uncertainty visibility beyond what V2.1 already exposes
immutable generation diff
small operator polish only when real use proves the friction
final real-run acceptance
```

### Explicitly excluded

```text
commercial query expansion
pricing scraping
commercial SERP collection
marketplace adapters
checkout/payment commercial evidence
EvidenceFact migration
WorkflowEdge implementation
commercial score
commercial inference
automatic BUILD / WATCH / REJECT
product/service recommendation
automatic smoke tests
paid-provider architecture
#25 paid backlink / competitor organic metrics
heavy dashboard / web UI
generic provider/plugin framework
broad persistence rewrite
broad runtime/type cleanup
one giant all-phases command
```

If an implementation idea exists mainly because it may be useful for V3 later, it does not belong in V2.2 unless the current V2.2 requirement independently needs it.

---

## 5. Cold baseline findings from current `main`

The V2.2 plan must build on the following already-implemented surfaces rather than duplicating them.

### 5.1 Discovery already has a quality projection

Discovery already publishes `run-quality.json` with deterministic warnings and explicit denominators for:

```text
Google SERP coverage
Surfer coverage
related-keyword source health
Ahrefs coverage
Google geo quality
```

Therefore V2.2 does **not** need another generic discovery-quality framework.

The new coverage work should concentrate on evidence layers that are currently weaker from an operator perspective: deep enrichment, first-seen/RDAP coverage, caps/omissions, entrant/cohort/finalist evidence, and a research-level summary across generations.

Where discovery coverage needs to appear in `research:status`, reuse the durable facts / existing quality projector semantics rather than inventing a competing warning vocabulary.

### 5.2 Discovery and enrichment already publish status/manifest artifacts

Discovery publishes:

```text
run-quality.json
status.json
manifest.json
```

Deep enrichment also publishes:

```text
status.json
manifest.json
```

and its summary already includes useful counts such as domain-age processed/omitted domains, domains with registration evidence, domains with first-seen evidence, page errors, site-structure omissions, query-suggestion errors, and cache/network counts.

`research:status` therefore must be a **research-level read-only projection/navigation surface**, not a third run state machine.

SQLite/checkpoint state remains durable truth. Derived `status.json`/`manifest.json` are publication artifacts and may be used as corroborating operator metadata where their publication contract is relevant, but must not replace the persisted state model.

### 5.3 Browser preflight already exists

`src/browser/preflight.ts` already verifies the critical browser-backed Google/Keyword Surfer path.

Do not create a separate `research:doctor` subsystem in V2.2 merely to have another command. A future doctor/preflight task is evidence-triggered only: first identify concrete missing diagnostics, then extend/expose existing checks.

### 5.4 First-seen abstraction already exists

Current first-seen architecture already has:

```text
FirstSeenClient
FirstSeenResult
provider factory
Wayback/CDX implementation
explicit ok / not_found / unavailable / error semantics
per-source TTL/cache provenance
resume/checkpoint integration
Wayback circuit breaker
```

Do not redesign `domain_age` from scratch.

### 5.5 Wayback is not a working live baseline

The implementation exists, but current project history shows Wayback is environment-dependent and has been effectively unreachable in the real operator environment. Its circuit breaker is a correctness/operability feature, not proof that live first-seen coverage exists.

Current truthful baseline:

```text
RDAP registration evidence works.
First-seen abstraction works.
Wayback implementation exists.
Stable live first-seen coverage is not proven.
```

### 5.6 Adding a second first-seen provider has two concrete compatibility hazards

The current single-provider implementation contains assumptions that are harmless while only Wayback exists but must be fixed **only if** a second provider is productionized:

1. a fresh cached first-seen fact can currently be reused without checking that `cached.firstSeenSource` matches the configured provider;
2. the defensive `fetchFirstSeen(...)` exception fallback currently hardcodes `source: 'wayback'`.

`FIRST_SEEN_QUERY_VERSION` is also currently a shared first-seen query-contract version, not a provider-aware contract identity.

The spike must not mutate production cache semantics. If PR-02 is promoted, provider-compatible cache reuse/provenance becomes part of its acceptance gate. Fix this narrowly; do not build a generic provider framework.

### 5.7 Immutable research generations already exist

A top-level research already contains immutable discovery and enrichment generations. `research.json` preserves a stable `researchId` and points to `currentRunId`; append creates `discovery-NN`, later enrichment creates `enrichment-NN`, and older generations remain audit history.

The architecture already pays the storage/lineage cost. V2.2 should expose factual comparison value from that history rather than adding another versioning system.

### 5.8 Research Library is already cumulative immutable history

The Library already preserves immutable publication versions and supersedes lineage. V2.2 generation diff should primarily compare generations **inside one logical research**. It must not quietly grow into a general Library analytics/dashboard project.

---

## 6. Planned sequence

```text
PR-01  Historical-source spike
  ↓
PR-02  Production historical first-seen provider
       ONLY if PR-01 passes its evidence gate
  ↓
PR-03  research:status
  ↓
PR-04  Deep/finalist evidence coverage warnings
  ↓
PR-05  Immutable generation diff
  ↓
PR-06  Integration + live acceptance + targeted polish
  ↓
V2.2
```

`PR-02` is conditional. If no legitimate source provides enough trustworthy live value, skip it. V2.2 is still valid if it improves the explicit unavailable/missing state instead of forcing a weak provider into production.

Small repair/import/doctor polish is not automatically a seventh feature PR. Promote it only from real friction discovered while executing this sequence or the final real research run.

---

## 7. PR-01 — Bounded historical-source spike

### Goal

Answer one question with real evidence:

> Does Common Crawl or another legitimate free historical source provide enough trustworthy independent web-presence / first-seen information in the real operator environment to justify production integration?

This is an evidence experiment, not a production provider implementation.

### Dataset

Use approximately 50–100 **real entrant domains** drawn from at least two existing research datasets where available.

Prefer diversity:

```text
old domains
young domains
small utility sites
large established sites
multiple TLDs
subdomain-heavy cases where relevant
```

Do not use only hand-picked famous domains.

The current production `domain_age` module has a deliberate 30-domain cap. The spike must not weaken that production cap simply to reach the experimental sample size. Use a bounded spike-specific input path/read-only dataset extraction.

### Providers / comparison context

At minimum collect:

```text
RDAP registration context
Wayback current live reality
Common Crawl
```

A fourth legitimate free historical source may be included only if there is a concrete reason to believe it can close a measured gap.

RDAP registration date is comparison context, **not** a substitute for web first-seen. Agreement/disagreement may be useful, but the two facts remain semantically different.

### Required measurements

Per provider/source:

```text
attempted
ok
not_found
unavailable
error
coverage percent
p50 latency
p95 latency
request count
rate-limit / retry behavior
earliest observed timestamp
domain-vs-subdomain semantics
suspicious / obviously wrong timestamp cases
access/automation constraints
maintenance complexity
```

Across sources:

```text
earliest-date agreement/disagreement
incremental web-presence observations
cases where archive evidence materially changes interpretation relative to registration-only context
redirect / parked-domain / subdomain anomalies
```

### Output

Produce deterministic machine-readable spike evidence plus a concise decision report. Exact filenames may follow existing spike conventions, but the result must be reviewable without reading terminal logs.

The spike output must preserve raw source/provenance needed to audit suspicious dates.

### Safety / truth constraints

```text
archive presence != domain registration
archive presence != original product launch
first capture != guaranteed first existence
not_found != proven absence from the web
unavailable != not_found
provider failure != old/established domain
```

No proxy rotation, stealth networking, CAPTCHA bypass, or evasion work.

### Production isolation

The spike must not:

```text
change domain_age production schema
change current first-seen cache rows
change finalization evidence semantics
make Common Crawl a runtime dependency
write experimental observations into normal enrichment checkpoints
```

### Gate

PR-01 ends with an explicit decision:

```text
PROMOTE <provider>
DEFER historical provider
```

Promotion requires **real live operator-environment evidence**, not only mocked tests or successful parsing of saved fixtures.

A provider is worth promotion only when its incremental trustworthy information is meaningful enough to justify its runtime/maintenance/access cost.

There is intentionally no arbitrary “must hit X% coverage” rule before the data is seen. The review must explain the trade-off using the measured dataset.

---

## 8. PR-02 — Production historical first-seen provider (conditional)

### Entry condition

Do not start this PR unless PR-01 explicitly promotes a provider.

### Goal

Integrate the promoted source into the existing first-seen/domain-age architecture with truthful provenance, bounded behavior, cache correctness, and resume semantics.

### Reuse

Prefer the existing shape:

```text
FirstSeenClient abstraction
  ↓
provider implementation
  ↓
runDomainAgeModule
  ↓
existing enrichment checkpoints / domain-age outputs
```

Do not rewrite RDAP, domain selection, or the entire domain-age module.

### Required provider contract

The implementation must return existing first-seen semantics truthfully:

```text
ok
not_found
unavailable
error
```

and preserve:

```text
source
sourceReason
fetchedAt
requestCount
httpStatus where meaningful
```

If the promoted source needs additional raw provenance that cannot fit the current contract without loss, make the smallest additive change justified by the spike evidence.

### Provider/cache compatibility gate

Before a second provider is considered production-safe:

- a cached first-seen observation from provider A must not be silently served as a fresh provider-B observation merely because its TTL is valid;
- provider/source identity must participate in cache-validity semantics;
- query/contract versioning must invalidate incompatible first-seen observations without invalidating unrelated RDAP facts;
- provider-switch regression coverage is required;
- defensive error fallback must never hardcode `wayback` provenance for another provider.

Do not solve this with a giant provider-cache framework. A narrow source/contract compatibility check is preferred.

### Required runtime behavior

```text
bounded timeout/retry/rate behavior
truthful unavailable/missing state
cross-run cache
resume from enrichment checkpoints
no refetch of completed checkpoint merely because cache changes
no registration/first-seen aliasing
explicit source provenance in CSV/JSON
```

### Wayback policy

Keep the existing Wayback implementation and circuit breaker unless the spike provides a concrete reason to remove it.

Possible post-spike strategies:

```text
promoted provider as configured primary; Wayback still optional
```

or, only if evidence truly justifies it:

```text
multiple separately identified archive observations
```

Do not automatically build fallback chains or consensus logic.

### Gate

A provider is not “working” until a real enrichment in the operator environment records legitimate live observations with correct source/missing/error semantics.

---

## 9. PR-03 — `research:status`

### Goal

One command should explain where a **logical research** currently stands without requiring the operator to remember run/enrichment IDs or manually open several JSON/SQLite files.

Expected surface:

```bash
npm run research:status -- --research <research-id-or-name>
```

Exact ID/name resolution should reuse current output-index/research-container rules rather than introducing another locator system.

### Read-only rule

`research:status` is a pure projection/navigation command.

It must not:

```text
resume work
repair checkpoints
advance generations
publish the Library
change decisions
change currentRunId
rewrite status artifacts
```

### Durable truth

The command should resolve the logical research container, then read current/historical SQLite and persisted generation metadata as needed.

Do not define truth by parsing terminal logs. Do not make derived CSV files authoritative.

Existing `status.json`, `manifest.json`, and `run-quality.json` may be reused where their publication contract is exactly the fact being reported, but the new command must not become dependent on a derived artifact when the underlying durable state is already available.

### Minimum output

Discovery:

```text
current generation / run id
keyword total
completed / partial / failed / pending/running where relevant
repairable primary checkpoints
current discovery terminal state
high-signal discovery warnings from existing quality semantics
```

Enrichment:

```text
current enrichment generation associated with currentRunId
modules requested
module/target completion state
first-seen / RDAP observed coverage where available
caps / omissions
current enrichment state
```

Finalization/evidence:

```text
representative-query state/revision
entrant-cohort state/fingerprint
cohort-history current/stale/missing
traffic current/unavailable/missing
finalist-evidence current/stale/missing
human decision coverage
```

Library:

```text
published current research version? yes/no
if no, a factual workflow reason when deterministically known
```

### Next operator action

A deterministic workflow-navigation hint is allowed, for example:

```text
repair 4 repairable discovery checkpoints
resume current enrichment
select finalist scope
record 2 missing finalist decisions
publish current completed research
```

It must never become business advice:

```text
BUILD this niche
REJECT this market
```

### Machine-readable mode

Provide a stable JSON mode if it can reuse existing CLI conventions cleanly. The human-readable CLI should be a formatting layer over the same deterministic projection, not separate logic.

### Gate

Given fixture research states covering incomplete discovery, repairable failures, partial enrichment, stale downstream evidence, incomplete decisions, and a fully publishable research, the command must produce deterministic state and next-action output without network access.

---

## 10. PR-04 — Deep/finalist evidence coverage warnings

### Goal

Make uncertainty that can materially change interpretation visible at the research/enrichment/finalist level.

### Do not duplicate discovery `run-quality`

V2.1 already has discovery quality warnings. Reuse those semantics where needed.

V2.2 coverage work should focus on gaps such as:

```text
RDAP coverage
first-seen coverage
first-seen provider unavailable/error state
domain-age cap omissions
representative-query coverage
entrant cohort/history coverage
traffic evidence coverage / absence
page-identity / fetch evidence coverage where it affects downstream interpretation
finalist evidence currentness
provider failures
physical Google geo warnings already surfaced by discovery quality
```

### Example

```text
Entrant domains:             47
RDAP observed:               43 / 47
web first-seen observed:     18 / 47
traffic evidence:             0 / 47
domains omitted by cap:      10

WARNING HISTORICAL_WEB_PRESENCE_SPARSE:
Only 18/47 entrant domains have observed web first-seen evidence.
Do not interpret the unobserved domains as established/old.
```

### Semantics

```text
coverage warning = uncertainty explanation
coverage warning != negative evidence
```

Never translate:

```text
missing first-seen -> old domain
missing traffic -> zero traffic
not observed -> absent
omitted by cap -> negative result
```

### Representation

Prefer:

```text
stable machine-readable warning code
explicit affected count
explicit denominator where meaningful
human-readable message
```

Use small feature-owned projectors/selectors over existing durable facts. Do not introduce a generic rule DSL or universal evidence framework unless the actual implementation demonstrates unavoidable repeated logic.

### Publication surfaces

At minimum, warnings must be visible through `research:status` and the relevant generated evidence/report artifact where an operator is most likely to misread the incomplete dataset.

Do not force every warning into every artifact.

### Gate

Regression cases must prove that missing/unavailable/omitted evidence remains outside known-evidence denominators and never becomes implicit zero/negative evidence.

---

## 11. PR-05 — Immutable generation diff

### Goal

Expose the factual value of immutable discovery/enrichment generations already stored inside one logical research.

Expected surface:

```bash
npm run research:diff -- --research <id-or-name> --from <generation> --to <generation>
```

The command may infer adjacent/current generations only where unambiguous. Explicit `--from`/`--to` must remain available for auditability.

### Scope

Primary scope is generation comparison **within one logical research**.

Do not turn this PR into:

```text
cross-portfolio analytics
Research Library dashboard
opportunity scoring
semantic AI diff
```

### Factual diff candidates

Discovery:

```text
keywords added/removed
keyword terminal-state changes
repaired checkpoints
SERP evidence coverage changes
```

Enrichment:

```text
cluster additions/removals
cluster membership changes
cluster split/merge facts when deterministically derivable
representative-query changes
entrant-domain additions/removals
history coverage changes
caps/omissions changes
```

Finalist/downstream:

```text
current/stale evidence generation changes
traffic snapshot presence/currentness
human decision current/stale/retired state
```

### Output rule

The diff is descriptive, not evaluative.

Allowed:

```text
web first-seen coverage: 72% -> 81%
entrant cohort: +3 domains / -1 domain
representative query X removed; Y added
```

Not allowed without an already-existing transparent metric whose semantics exactly support it:

```text
the opportunity improved by 18%
this niche is now stronger
```

### Identity / matching

Reuse existing durable identities and fingerprints:

```text
source run id + keyword idx within a generation
normalized text only for intentional semantic matching across generations
cluster/member persisted identities where available
representative revisions / entrant fingerprints / parent fingerprints
```

Do not create a global UUID migration for diffing.

### Gate

Fixture tests must cover append-generated discovery generations and re-enrichment generations. Diff output must be deterministic, stable in ordering, and reproducible without network access.

---

## 12. PR-06 — Integration, live acceptance, and targeted polish

### Goal

Validate V2.2 as an operator workflow, not as a collection of isolated commands.

### Required real research pass

Run a real representative research through the current normal workflow:

```text
discovery:full
research:append if useful
repair if real primary failures exist
enrich:full
finalist/finalization flow
research:status
research:diff
Library publication where human decisions are genuinely complete
```

If PR-02 was promoted, the run must include live historical-source evidence.

### Acceptance questions

The final review should be able to answer yes to:

```text
Can the operator find the current research state without remembering IDs?
Are repairable failures distinguished from terminal-but-not-repairable partial state?
Are important evidence gaps visibly denominated?
Are omitted/capped/unavailable facts impossible to mistake for zero/negative evidence?
Can two immutable generations be compared factually?
Does historical first-seen work live if a provider was promoted?
If no provider was promoted, is missing first-seen explicit and non-misleading?
Did V2.2 avoid commercial/V3 scope?
Did V2.2 avoid a new framework where existing status/quality/preflight infrastructure was enough?
```

### Targeted polish only

During this pass, small friction may be fixed when directly observed, for example:

```text
repair diagnostics explaining why a checkpoint is/is not repairable
traffic import --validate / --dry-run if the real importer workflow proves painful
small preflight visibility gaps
```

Do not pre-schedule these as mandatory features. A real observed operator problem is the entry condition.

### Documentation

After behavior is merged, update only the current docs needed for the actual runtime surface:

```text
README.md
FULL_RUNS.md where workflow changes
PIPELINE.md / ARCHITECTURE.md where contracts change
.env.example if a promoted provider adds configuration
```

Do not rewrite V3 planning docs merely because V2.2 shipped.

---

## 13. Source-of-truth relationship

Use these documents for different purposes:

```text
README / FULL_RUNS
  current operator workflow

ARCHITECTURE / PIPELINE
  implemented runtime and evidence contracts

V2_2_IMPLEMENTATION_ROADMAP
  current V2.2 backlog and gates

V3_COMMERCIAL_EVIDENCE_SPEC
COMMERCIAL_DATA_PROVIDER_MATRIX
  future V3 commercial-evidence planning
```

A V2.2 roadmap item is not a current contract until its implementation merges and current-state docs are updated.

---

## 14. Failure and rollback semantics

Preserve existing invariants:

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

New read-only status/diff commands must fail without mutating research state.

A failed experimental historical-source spike must not contaminate production caches/checkpoints.

A production first-seen provider failure must degrade to explicit missing/unavailable/error evidence according to the provider contract; it must not block independent RDAP/history work merely because archive evidence is unavailable.

---

## 15. Release gate

V2.2 is releasable when:

1. PR-01 has a recorded evidence-backed promote/defer decision;
2. PR-02 is either merged with real live evidence or explicitly skipped because the spike did not justify productionization;
3. `research:status` reliably projects the current logical research state;
4. important deep/finalist evidence gaps are visibly denominated and never converted into negative evidence;
5. immutable generations have a deterministic factual diff;
6. a real research workflow has exercised the integrated operator surfaces;
7. final cold review finds no V3 scope theft or unnecessary general framework;
8. tests/typecheck have actually run locally or in working CI before calling the release verified.

---

## 16. Immediate next task

Start **PR-01 — Bounded historical-source spike**.

Before implementing Common Crawl access, re-check the source's current official access/index documentation and define the narrowest query needed for domain-level historical web-presence evidence. Then collect the real multi-research domain sample and measure the source before making any production architecture decision.
