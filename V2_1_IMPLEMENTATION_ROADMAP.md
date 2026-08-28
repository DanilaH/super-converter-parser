# V2.1 Implementation Roadmap

**Status:** current engineering backlog  
**Repository:** `DanilaH/super-converter-parser`  
**Baseline reviewed:** `main @ 36e8ab1d19026dd80b631f4c77ee1218be185d96`  
**Purpose:** turn the V2.1 evidence-quality requirements into an implementation sequence grounded in the current repository rather than the older proposal-era architecture.

---

## 1. How to use this document

This is the current implementation backlog for V2.1.

`PRODUCT.md`, `ARCHITECTURE.md`, `PIPELINE.md`, `README.md`, and `ACCEPTANCE.md` continue to describe product constraints and implemented behavior. This roadmap describes work that is not necessarily implemented yet.

Do not rewrite current-state documentation as if a roadmap item were already complete. Update current-state docs only when the corresponding behavior is merged.

`IMPLEMENTATION_PLAN.md` remains historical v1 delivery history.

---

## 2. Engineering workflow

Every roadmap item follows the same loop:

```text
task
→ implementation
→ independent review
→ fix
→ review
→ CI on Ubuntu + Windows
→ merge
→ next task
```

A PR is not complete because its first implementation compiles. Review must check semantic correctness, persistence compatibility, output truthfulness, resume/cache behavior, and regression coverage.

Prefer focused PRs. Do not combine unrelated cleanup with analytical changes.

---

## 3. V2.1 foundation decisions

### 3.1 Source keyword identity

Do not introduce a new global keyword UUID migration.

Within a discovery run, durable keyword ownership is:

```text
(source_run_id, keyword_idx)
```

`run_id + idx` already defines the persisted keyword identity in discovery SQLite and SERP ownership uses `keyword_idx`.

Use source keyword identity for relational ownership across enrichment.

Text fields remain valid for specific non-relational purposes:

```text
normalized text  → semantic dedupe
normalized text  → cross-run cache identity where semantics require it
text              → user-facing shortlist lookup
text              → display/export labels
```

Do not use raw or normalized text as the durable parent/member/pair ownership key when a source keyword relation exists.

### 3.2 Missing is not zero

Numeric zero is valid only when the corresponding source observation successfully proved a zero value.

For Google organic SERP evidence, the implementation must preserve a source-specific observation state. A general keyword `status` is not sufficient because Surfer and Google can succeed/fail independently.

Target semantics:

```text
SERP successfully parsed with rows
→ serp_status = ok
→ organic_result_count = N

Google explicitly confirms a genuine zero-results page
→ serp_status = empty
→ organic_result_count = 0

SERP fetch/parse did not produce trustworthy evidence
→ serp_status = fetch_error | parse_error | not_fetched
→ organic_result_count = null / blank in CSV
```

A Surfer failure must not erase a valid Google zero or valid Google SERP. A Google failure must not become a valid-looking zero because the overall keyword is terminal.

### 3.3 Existing history providers

RDAP and first-seen/Wayback are existing subsystems, not new V2.1 provider projects.

V2.1 work should reuse their persisted provenance, independent source statuses, TTLs, checkpoint/resume behavior, request metadata, and omission/cap handling.

Only cohort/history projection or concrete missing semantics should be added.

### 3.4 Common Crawl and Certificate Transparency

Common Crawl is deferred from the V2.1 critical path until a bounded experiment demonstrates incremental decision value beyond existing RDAP, first-seen, page and site-structure evidence.

Certificate Transparency is dropped from V2.1 core.

Neither may block the core implementation sequence below.

### 3.5 Clustering is a real analytical version bump

Current clustering v1 is domain-set Jaccard + threshold edges + connected components.

V2 clustering is not a threshold tweak. It must add source keyword identity, URL-level evidence and cluster-wide cohesion/anti-chaining semantics under a new algorithm version.

### 3.6 Research-method regression corpus

The repository currently lacks durable Hardware/Audio research fixtures sufficient to reproduce prior real research conclusions.

A compact sanitized corpus must be captured before clustering v2 is merged so V1 → V2 changes can be explained rather than reconstructed after the fact.

---

## 4. PR-01A — SERP truth semantics

### Goal

Make false numeric SERP negatives structurally difficult to publish.

### Required work

- add explicit durable Google SERP observation status;
- preserve source-specific Google error/status independently from Surfer outcome;
- persist/cache the new semantics;
- bump the relevant Google/cache semantic version when required;
- update `keywords.csv` so unavailable SERP evidence is blank, not zero;
- update candidate/report projections so unavailable SERP-derived numeric evidence is not serialized as confirmed zero;
- keep genuine zero-result pages as numeric zero;
- preserve current Playwright → Google → Surfer collection mechanism.

### Required regression cases

```text
Google rows + Surfer ok       → count N
Google rows + Surfer error    → count N
Google real zero + Surfer ok  → count 0
Google real zero + Surfer err → count 0
Google parse error            → count missing
Google fetch error            → count missing
not fetched / pending         → count missing
```

### Explicit non-goals

- no scoring formula rewrite;
- no clustering changes;
- no selector redesign without evidence;
- no retry-failed workflow yet.

### Gate

Independent review must search all published SERP-derived numeric fields, not only `keywords.csv`.

---

## 5. PR-01B — Durable enrichment keyword ownership

### Goal

Finish the identity surface without inventing a second global identity system.

### Required work

Audit every use of:

```text
normalizedKeyword
normalizedParent
parentKeyword
keywordA
keywordB
```

Classify each use as one of:

```text
relational ownership
semantic dedupe
cache identity
user lookup
display only
```

Relational ownership must use source keyword idx.

At minimum, new enrichment writes must carry source keyword identity for:

- clustering inputs;
- cluster members;
- pairwise clustering evidence;
- query-suggestion parent occurrences;
- query-suggestion per-parent/source checkpoints.

Keep normalized suggestion text as semantic suggestion dedupe. Keep semantic normalized parent text where it is intentionally part of cross-run cache identity.

Use additive schema migration and compatibility reads where practical. Do not destructively rewrite historical enrichment data.

### Gate

After implementation, a repository-wide identity audit must leave no unexplained text-based relation.

---

## 6. PR-02 — Explicit failed-keyword repair

### Goal

Repair terminal discovery failures without manual SQLite edits and without losing history.

### Required work

- explicit `--retry-failed` flow with resume;
- controlled reopen of eligible terminal run state;
- append-only or otherwise durable attempt/error history;
- retry attempt count and timestamps;
- bypass stale failed keyword cache for explicitly retried keywords;
- idempotent republication into the same logical run;
- no duplicate keyword/SERP/output rows;
- successful previously completed keywords remain untouched.

Do not implement this as a naked `failed → pending` reset with overwritten error truth.

---

## 7. PR-03 — Normalized run-quality projection

### Goal

Expose evidence quality without replacing every provider-native state machine with a universal framework.

### Output

Introduce a machine-readable quality artifact, expected shape such as `run-quality.json`, that projects:

- Google SERP coverage/status;
- Surfer coverage/status;
- related-query source health;
- Ahrefs coverage;
- cap/omission accounting;
- geo evidence grade;
- warnings and denominators.

Prefer explicit deterministic projectors/selectors over a generic rule DSL or provider framework.

---

## 8. Regression fixture foundation — before PR-04 merge

Capture compact sanitized Hardware and Audio research corpora from real prior research evidence.

Minimum useful fixture data:

```text
keyword_idx
raw keyword
normalized keyword
market
organic top-10 URL/domain/position
volume/CPC where available
DR where available
selected domain-history evidence where available
V1 cluster/result expectations used during prior decisions
```

Tests must not require live Google to reproduce the baseline.

This fixture foundation may be prepared in its own focused PR or alongside test-only preparation immediately before clustering v2, but it must exist before PR-04 is accepted.

---

## 9. PR-04 — Clustering v2

### Goal

Replace connected-component chaining with auditable URL/domain overlap and cohesion-safe clustering.

### Pair evidence

At minimum persist/report:

```text
keyword_a_idx
keyword_b_idx
shared_urls
url_union_count
url_jaccard
shared_domains
domain_union_count
domain_jaccard
pair classification / edge decision
```

Ranking URLs remain raw evidence. Any comparison normalization must be explicit and versioned.

### Grouping

A cluster must not be valid merely because every member is connected through some path.

Implement a conservative cluster-wide cohesion rule. Start with a complete-link/minimum-pair style rule unless fixture evidence shows a better transparent deterministic alternative.

Required chain regression:

```text
A strongly overlaps B
B strongly overlaps C
A weakly overlaps C

→ no silent A+B+C merge solely through transitive connectivity
```

### Cluster audit

Expose at least mean/median/min cohesion for URL and domain evidence plus the underlying pair rows.

Do not tune thresholds blindly against one live run.

---

## 10. PR-05 — Representative queries

### Goal

Create a stable explicit representative query set per finalist cluster.

Recommended deterministic v1 selection:

1. overlap medoid;
2. useful high-demand non-duplicate representative;
3. greedy coverage expansion over cluster SERP evidence;
4. deterministic tie-break on source keyword idx;
5. normally 3–10 representatives where cluster size permits.

Persist:

```text
cluster_id
representative keyword ids
set version
selection reason
manual override
manual override reason
```

A changed representative set must be visible between reruns.

---

## 11. PR-06 — Entrant cohort

### Goal

Move from isolated weak-domain examples to repeatable observed entrant evidence across representative queries.

Construct the cohort from representative-query top-10 SERPs.

Deduplicate by registrable domain while preserving every ranking occurrence:

```text
keyword_idx
position
ranking_url
```

Per domain derive transparent descriptive metrics such as:

- best rank;
- median rank;
- queries present;
- query coverage;
- ranking URL set;
- same-page repetition;
- same-domain/different-page repetition.

Every ratio exposes its denominator.

Never transform observed competitor success into a launch-success probability.

---

## 12. PR-07 — Cohort history integration

Reuse existing RDAP and first-seen evidence for cohort domains.

Add coverage-aware projections for:

- young-domain observations;
- recent web presence;
- possible repurposed/history conflict signals;
- missing/unsupported/error evidence;
- omission by cap.

If history is checked for 30 of 47 cohort domains, the output must say `30/47` and identify 17 omitted/unobserved rather than treating them as negative history evidence.

---

## 13. PR-08 — Competitor traffic evidence

### Goal

Add provider-neutral, explicitly scoped traffic snapshots without introducing paid runtime dependencies.

Support manual/imported evidence first.

Persist at minimum:

```text
entity scope: domain | url
entity
observed_at
provider_data_date
market/source
organic traffic when available
traffic value when available
source/provenance
```

Add:

- target-intent validation;
- compatible snapshot history;
- transparent velocity deltas;
- low-base warning.

Invariant:

```text
domain-level traffic must never silently populate page-level traffic evidence
```

---

## 14. PR-09 — Finalist evidence matrix

Project existing evidence into independent human-review blocks:

```text
A. Demand
B. SERP accessibility
C. Organic traffic proof
D. Entrant repeatability
E. Moat
F. Monetization / geography
G. Product feasibility
```

Preserve raw facts, coverage and warnings.

Do not introduce an opaque finalist opportunity score or automatic success probability.

Keep human decisions separate:

```text
build decision: build | watch | reject | unknown
SEO/product role: acquisition_anchor | strong_supporting_tool | completeness_tool | experimental | not_applicable
```

Existing Score v1 remains a broad-discovery priority signal, not the finalist verdict.

---

## 15. PR-10 — Methodology regression

Run the V2 analytical path against the frozen Hardware/Audio corpus.

Produce an explainable V1 → V2 diff covering:

- cluster splits/merges;
- representative query sets;
- entrant repetition;
- history coverage;
- traffic/intent evidence where available;
- warnings;
- finalist human-review surface.

A changed conclusion is not automatically a regression.

A regression is an analytical/output change that cannot be traced to explicit pair/cohort/source evidence or that violates a documented truth invariant.

---

## 16. Dependency map

```text
PR-01A SERP truth
      ↓
PR-01B identity
      ├────────────→ PR-02 repair
      ├────────────→ PR-03 quality
      ↓
Hardware/Audio baseline corpus
      ↓
PR-04 clustering v2
      ↓
PR-05 representatives
      ↓
PR-06 cohort
      ├────────────→ PR-07 history
      └────────────→ PR-08 traffic

PR-03 + PR-06 + PR-07 + PR-08
      ↓
PR-09 evidence matrix
      ↓
PR-10 methodology regression
```

PR-02 and PR-03 may proceed independently after the foundation if doing so does not delay the clustering/cohort critical path.

---

## 17. Stop conditions / scope discipline

Do not add during V2.1 core unless new evidence requires it:

- React/Next/dashboard;
- hosted service architecture;
- LLM/AI opportunity scoring;
- proxy/stealth/CAPTCHA bypass;
- a universal provider plugin framework;
- a rule DSL;
- global keyword UUID migration;
- Common Crawl production subsystem;
- Certificate Transparency subsystem;
- new RDAP/Wayback subsystem replacing the working one.

The roadmap is complete when the implementation produces repeatable, provenance-preserving evidence that improves human SEO/product decisions without converting unknowns into negative numbers or isolated winners into fake probabilities.
