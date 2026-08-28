# V2.1 Baseline Gap Matrix

**Status:** implementation-planning evidence  
**Repository:** `DanilaH/super-converter-parser`  
**Reviewed baseline:** `main @ 36e8ab1d19026dd80b631f4c77ee1218be185d96`  
**Roadmap:** `V2_1_IMPLEMENTATION_ROADMAP.md`

---

## 1. Purpose

This document maps V2.1 evidence-quality goals against the current repository.

It exists to prevent three implementation failures:

```text
1. rebuilding functionality that already exists;
2. assuming partially solved correctness problems are fully solved;
3. underestimating genuinely new analytical work.
```

This is current-state evidence, not a claim that roadmap items are already implemented.

---

## 2. Assessment states

```text
ALREADY_SATISFIED
Current implementation materially satisfies the requirement.

PARTIALLY_SATISFIED
Useful infrastructure exists, but an important semantic/functional gap remains.

MISSING
Required capability does not currently exist.

SUPERSEDED
Do not implement the older proposed mechanism because current architecture solves the underlying problem differently.

DEFERRED
Outside the V2.1 core critical path until evidence promotes it.

DROPPED
Explicitly excluded from V2.1 core.
```

---

## 3. Executive result

The repository already contains substantial V2-era infrastructure:

```text
durable SQLite discovery state
durable SQLite enrichment state
versioned migrations
SERP ownership by keyword_idx
persistent cache/resume/checkpoints
Google + Keyword Surfer collection
Ahrefs DR
RDAP registration evidence
first-seen/Wayback evidence
domain caps and explicit omissions
ranking-page inspection
site-structure inspection
domain-overlap clustering v1
query suggestions
structured outputs
broad regression tests
network/SSRF hardening
```

The main V2.1 implementation surface is therefore concentrated in:

```text
1. source-specific SERP truth semantics
2. remaining enrichment keyword ownership
3. explicit failed-keyword repair
4. normalized evidence-quality projection
5. URL-level + cohesion-safe clustering v2
6. representative-query selection
7. entrant cohort model
8. cohort/history projection
9. competitor traffic evidence
10. finalist evidence matrix / human decision layer
11. Hardware/Audio methodology regression corpus
```

RDAP and first-seen/Wayback are not major new provider projects.

Common Crawl is deferred.

Certificate Transparency is dropped from V2.1 core.

---

## 4. GAP-001 — false organic zero

**Status:** OPEN / HIGH correctness impact in published evidence

Current `keywords.csv` semantics use terminal keyword state as eligibility for an organic count:

```text
terminal keyword
+ no stored SERP rows
→ organic_result_count = 0
```

Because `failed` is terminal, a failed collection can publish a valid-looking zero.

The regression suite currently preserves this behavior for a `SURFER_PARSE_ERROR` failed keyword.

### Important refinement

The fix cannot be only:

```text
failed → blank organic count
```

The keyword-level state combines Surfer and Google outcomes. These are valid distinct cases:

```text
Surfer error + Google genuine zero-results page
→ organic_result_count must remain 0

Surfer error + Google valid rows
→ organic_result_count must remain N

Google parse/fetch error
→ organic_result_count must be missing
```

Therefore V2.1 needs a durable source-specific Google SERP observation state.

### Affected projection surface

Audit more than `keywords.csv`.

`candidates.csv` and any report/status feature derived from absent SERP rows must not publish confirmed zero-like evidence when the SERP observation is unavailable.

Scoring currently localizes some harm by producing `score=null` for failed keywords, but that does not make raw/report evidence truthful.

### Size

```text
S–M
```

Persistence/cache semantics are involved.

---

## 5. GAP-002 — keyword identity is only partially closed

**Status:** PARTIALLY_SATISFIED

Discovery/scoring identity is materially repaired:

```text
keywords PRIMARY KEY      = (run_id, idx)
serp_rows PRIMARY KEY     = (run_id, keyword_idx, position)
scoring SERP ownership    = keyword_idx
```

Do not re-open that solved scoring bug.

### Remaining gap: clustering

The enrichment engine loads SERP rows by `keywordIdx`, but the clustering input discards the idx and continues using normalized keyword text for:

- domain-set maps;
- pair ownership;
- adjacency/components;
- cluster member persistence.

### Remaining gap: query suggestions

Parent ownership/checkpointing currently uses `normalizedParent` in durable enrichment records and item IDs.

Suggestion identity itself is different: normalized suggestion text is a legitimate semantic dedupe key.

### Required distinction

```text
RELATIONAL OWNERSHIP
source keyword relation
→ source_run_id + keyword_idx

SEMANTIC DEDUPE/CACHE
query/suggestion semantics across collection attempts/runs
→ normalized text where intentional

USER LOOKUP
shortlist input
→ normalized text can resolve to source keyword identity

DISPLAY
→ raw/normalized text is fine
```

### Architecture decision

A new global keyword UUID migration is not required.

Use the durable discovery identity consistently instead of creating another identity system.

### Size

```text
M
```

Additive migrations and compatibility reads are likely.

---

## 6. GAP-003 — explicit terminal repair

**Status:** MISSING

Current failed keyword state is terminal. Normal `--resume` does not retry it.

A repair workflow must add:

```text
--retry-failed
attempt history
controlled reopen of eligible terminal run
failed-cache bypass for explicit retry
idempotent same-run republication
no duplicate rows
preservation of prior failure metadata
```

A direct `failed → pending` DB reset is not the V2.1 solution because it erases attempt history and requires manual mutation.

### Size

```text
L
```

This is the most state-machine-sensitive block.

---

## 7. GAP-004 — normalized evidence-quality projection

**Status:** PARTIALLY_SATISFIED

Provider-specific state is already strong in several modules, but there is no single operator-facing projection that makes coverage and source health comparable.

Needed projection includes:

- SERP observation coverage/status;
- Surfer coverage;
- related-source health;
- Ahrefs coverage;
- caps/omissions;
- geo evidence grade;
- warnings and denominators.

Do not replace provider-native state machines with one giant universal status enum.

Prefer an explicit `run-quality` projection over existing facts.

### Size

```text
M
```

---

## 8. GAP-005 — clustering v1 is not clustering v2

**Status:** PARTIALLY_SATISFIED

Current algorithm is:

```text
top-N registrable domains
→ Set<domain>
→ shared-domain count + Jaccard
→ threshold edge
→ connected components
```

This is useful V1 infrastructure but lacks two required analytical properties.

### URL-level overlap

Current pair evidence has domain overlap only.

No normalized ranking-URL overlap is stored or used.

### Cluster-wide cohesion / anti-chaining

Connected components allow:

```text
A strongly overlaps B
B strongly overlaps C
A weakly overlaps C
→ one A+B+C component
```

V2.1 requires a conservative cluster-wide cohesion rule so transitive connectivity alone cannot define one intent cluster.

### Required v2 surface

```text
source keyword identity
URL normalization/version
URL overlap
registrable-domain overlap
pair evidence
cluster-wide cohesion
algorithm version bump
audit output
```

This should be treated as an analytical-core replacement, not a threshold tweak.

### Size

```text
L
```

---

## 9. GAP-006 — representative queries

**Status:** MISSING

Finalist/cohort analysis must not depend on one head keyword.

Need a small explicit representative set per cluster, normally 3–10 where the cluster permits it.

Required properties:

```text
deterministic selection
medoid/central query
useful demand representation
coverage expansion
persisted/versioned set
visible changes between reruns
lightweight manual override
```

### Size

```text
M
```

---

## 10. GAP-007 — entrant cohort

**Status:** MISSING

This is likely the highest-decision-value new V2.1 block.

For each finalist cluster, use representative-query top-10 SERPs to build a registrable-domain cohort while preserving every ranking URL/position.

Needed descriptive evidence:

```text
best/median rank
queries present
query coverage
ranking URLs
same-page repetition
same-domain/different-page repetition
weak/young/repeated entrant counts
transparent denominators
survivorship warning
```

Do not turn observed successful entrants into a probability that a new site will succeed.

### Size

```text
L
```

---

## 11. Existing RDAP/first-seen subsystem

**Status:** ALREADY_SATISFIED for provider foundation

The current `domain_age` path already separates registration and first-seen facts and preserves:

```text
source-specific status
source provenance
registration rule/events
first-seen source/reason
independent fetchedAt/TTL
HTTP status
request count
errors
checkpoint/resume
cache status
source keyword/rank provenance
domain cap omissions
```

V2.1 should not rebuild these providers.

Remaining work is cohort/history integration and coverage-aware interpretation.

### Size of remaining integration

```text
S–M
```

---

## 12. Common Crawl

**Status:** DEFERRED

Current repository already has:

```text
RDAP
first-seen/Wayback
ranking-page inspection
site-structure/sitemap evidence
```

Common Crawl may add independent historical/footprint evidence, but its incremental decision value has not been demonstrated enough to place a production subsystem on the V2.1 critical path.

Required action before promotion:

```text
bounded experiment after V2.1 core
```

---

## 13. Certificate Transparency

**Status:** DROPPED

Do not implement CT/crt.sh for V2.1 core.

---

## 14. GAP-008 — competitor traffic evidence

**Status:** MISSING

Need a provider-neutral snapshot/import model with explicit entity scope and provenance.

Minimum concerns:

```text
domain vs URL scope
manual/import path
observed/provider dates
market/source
snapshot compatibility
history/velocity
target-intent validation
low-base warning
```

Domain-level traffic must never silently become page-level traffic evidence.

### Size

```text
L
```

---

## 15. GAP-009 — finalist evidence matrix

**Status:** MISSING as a complete layer

Many underlying facts already exist, so this should primarily be a projection, not a new inference framework.

Required independent evidence blocks:

```text
A. Demand
B. SERP accessibility
C. Organic traffic proof
D. Entrant repeatability
E. Moat
F. Monetization / geography
G. Product feasibility
```

Keep raw evidence, coverage and warnings inspectable separately.

Do not add a universal finalist score.

Keep human decisions separate:

```text
build / watch / reject / unknown

acquisition_anchor
strong_supporting_tool
completeness_tool
experimental
not_applicable
```

Existing Score v1 should remain a broad-discovery priority signal, not become the finalist verdict.

### Size

```text
M–L
```

---

## 16. GAP-010 — real Hardware/Audio research regression corpus

**Status:** MISSING

Current repository has synthetic/generic clustering acceptance inputs, but not enough durable Hardware/Audio research evidence to reproduce the prior real research method.

Therefore the final V2 regression gate cannot honestly be:

```text
run Hardware and Audio again
```

without first freezing the old evidence.

### Required foundation before clustering v2 acceptance

Capture a compact sanitized corpus containing enough source evidence to replay V1 and V2 analysis without live Google.

At minimum:

```text
keyword_idx
raw/normalized keyword
market
SERP top-10 URL/domain/position
volume/CPC where available
DR where available
selected history facts where available
V1 cluster/key analytical expectations
```

This corpus must be prepared before PR-04 is accepted, not reconstructed after the V2 clustering algorithm has replaced V1 behavior.

### Size

```text
M
```

---

## 17. Testing assessment

Current automated testing architecture is already strong.

Existing strengths include:

```text
Node test runner
typecheck
SQLite/cache/CLI regressions
network/provider tests
RDAP fixtures
Wayback/first-seen tests
clustering v1 tests
aggregation/snapshot tests
Ubuntu + Windows CI
```

V2.1 does not need a new test framework.

The missing layer is research-method regression and new semantic regressions.

Required additions include:

```text
false-zero/source-specific SERP truth
identity ownership
retry-failed lifecycle
chain cluster rejection
URL vs domain overlap
representative-set determinism
cohort repeatability
traffic scope/compatibility
Hardware/Audio before/after analytical diff
```

---

## 18. Recommended engineering sequence

Canonical sequence is maintained in `V2_1_IMPLEMENTATION_ROADMAP.md`:

```text
PR-01A SERP truth semantics
PR-01B durable enrichment ownership
PR-02 failed-keyword repair
PR-03 quality projection
Hardware/Audio baseline fixture foundation
PR-04 clustering v2
PR-05 representative queries
PR-06 entrant cohort
PR-07 history integration
PR-08 traffic evidence
PR-09 finalist evidence matrix
PR-10 methodology regression
```

PR-02 and PR-03 may run independently after the foundation if they do not delay the clustering/cohort critical path.

---

## 19. Immediate implementation gate

Do not begin the large clustering/cohort work until the two foundation conditions are true:

```text
1. unavailable Google SERP evidence cannot publish a false zero;
2. enrichment relational ownership no longer depends on mutable normalized keyword text.
```

After PR-01A and PR-01B, perform an independent cold review before proceeding into the analytical core.

---

## 20. Scope discipline

Do not use V2.1 as justification for unrelated platform expansion.

No core requirement exists for:

```text
React/Next/dashboard
hosted SaaS architecture
remote DB/queues
LLM scoring
proxy/stealth infrastructure
CAPTCHA bypass
generic provider plugin framework
rule DSL
global keyword UUID migration
new RDAP/Wayback replacement subsystem
Common Crawl production subsystem
Certificate Transparency subsystem
```

The desired result is stronger and more honest evidence, not a larger product surface.
