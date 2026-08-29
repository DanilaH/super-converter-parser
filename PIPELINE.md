# PIPELINE.md

## Pipeline overview

```text
INPUT
  ├── Microsoft export
  └── raw seeds
        ↓
validate + normalize + dedupe
        ↓
keyword queue
        ↓
Google + Keyword Surfer
  ├── volume
  ├── CPC
  ├── related ideas
  └── organic SERP + source-specific SERP status
        ↓
optional Surfer expansion
        ↓
normalize SERP domains
        ↓
dedupe domains globally
        ↓
Ahrefs DR
        ↓
aggregate trustworthy keyword-level SERP metrics
        ↓
deterministic scoring
        ↓
CSV + Markdown + JSON outputs
```

## Stage 1 — Input

### Raw seeds

Expected minimal file:

```csv
keyword
compare csv files
zip code county lookup
filter csv by column
```

### Microsoft export

The runner must support a Microsoft Keyword Planner CSV adapter.

Because Microsoft exports may change column names/order, parsing logic should:

1. identify required columns by known header aliases;
2. preserve unknown source columns where practical;
3. fail with a useful schema error if the export cannot be recognized;
4. normalize rows into the internal keyword model.

Microsoft volume is a discovery/prioritization signal, not the final truth.

Do not apply a strict kill threshold based solely on Microsoft volume bucket.

## Stage 2 — Keyword dedupe

Normalize safely:

- trim surrounding whitespace;
- collapse accidental repeated whitespace;
- preserve semantic punctuation;
- case-insensitive dedupe for identical queries;
- retain original source provenance.

If the same keyword appears from seeds, Microsoft, and Surfer expansion, it must become one canonical keyword with multiple sources.

## Stage 3 — Google + Keyword Surfer

For each canonical keyword collect:

```ts
{
  keyword,
  volume,
  cpc,
  googleUrl,
  surferMarket,
  googleHl,
  googleGl,
  detectedGoogleLocation,
  status,
  google: {
    serpStatus,
    serpError
  }
}
```

The browser collector must also collect organic results.

The aggregate keyword `status` is not the source of truth for Google SERP availability because Surfer and Google can succeed or fail independently. Fresh collection persists a Google-specific SERP observation:

```text
ok
empty
fetch_error
parse_error
```

`not_fetched` and `unknown` are also supported by the evidence resolver for incomplete/historical state.

### Organic result rules

Collect up to configured `topN` (default 10).

Do not count:

- ads;
- sponsored results;
- People Also Ask;
- related searches;
- shopping widgets;
- local/map packs;
- knowledge panels;
- Keyword Surfer-injected links;
- navigation links.

Store result type explicitly when uncertain.

If only 9 valid organic results exist on the rendered page, `9` is correct. Never fabricate a 10th result.

A numeric zero is equally strict:

```text
serpStatus=empty + Google explicitly confirmed a zero-results page
→ organic_result_count = 0

serpStatus=fetch_error | parse_error | not_fetched | unknown
→ organic_result_count is missing
```

A Surfer failure does not erase a valid Google zero or valid Google rows. A Google failure does not become zero merely because the aggregate keyword is terminal.

Historical rows that predate source-specific SERP status are interpreted conservatively from persisted state: positive stored rows prove a successful SERP; a clean historical completed zero-row keyword preserves the old collector's confirmed zero-results behavior; ambiguous terminal zero-row rows remain unknown/missing.

## Stage 4 — Surfer related-keyword expansion

The spike proved the sidebar can expose:

```text
keyword
overlap
volume
```

Support optional expansion with the canonical CLI flag:

```bash
--expand
```

`--expand-surfer` remains an implemented alias; operator examples use `--expand`.

Configurable limits:

- max related keywords per seed;
- minimum volume;
- minimum/maximum overlap if desired;
- expansion depth (v1 supports only depth `1`; deeper recursion is not implemented).

v1 depth is fixed at `1`.

Do not recursively explode related keywords indefinitely.

Every expanded keyword must preserve parent/source metadata.

## Stage 5 — Domain normalization

For every organic URL derive:

```text
hostname
registrable domain (eTLD+1)
```

Use a Public Suffix List-aware library.

Examples:

```text
www.example.com       → example.com
blog.example.com      → example.com
foo.example.co.uk     → example.co.uk
```

Do not implement this with a naive split on dots.

## Stage 6 — Ahrefs DR

Collect DR once per unique registrable domain, subject to cache TTL.

One domain may occur in dozens of keyword SERPs. It must not trigger dozens of API calls.

## Stage 7 — Aggregation

For keywords with trustworthy SERP evidence, compute observable metrics such as:

```text
organic_result_count
unique_domains
min_dr
max_dr
median_dr
top3_median_dr
top5_median_dr
very_weak_domains_count
weak_domains_count
strong_domains_count
very_strong_domains_count
missing_dr_count
niche_domain_count
exact_match_domain_count
serp_diversity
```

If the SERP observation is unavailable or ambiguous, SERP-derived candidate metrics are missing instead of a bundle of valid-looking zeros.

Thresholds belong in configuration, not scattered through code.

Initial defaults may be:

```text
very weak: DR < 10
weak:      DR < 30
strong:    DR >= 60
very strong: DR >= 75
```

These are research heuristics, not SEO laws.

## Stage 8 — Candidate scoring

See `SCORING.md`.

The arithmetic formula, weights, thresholds, and tier boundaries are unchanged, but `SCORING_VERSION` is `1.1.0` because score eligibility now requires trustworthy SERP evidence. A partial keyword with valid Surfer demand and a Google parse/fetch failure remains visible but receives `score=null` rather than being scored as an empty/easy SERP. Trustworthy SERP evidence is necessary but the existing keyword-status rule still applies: failed/non-terminal keywords remain unscored.

## Explicit failed-keyword repair

A normal `--resume` never reopens terminal failed keyword checkpoints. Repair is an explicit operator action:

```bash
npm run research -- --resume <run-id> --retry-failed
```

Only failed discovery keywords are eligible. Previously completed/partial keywords stay untouched, and `completed`, `failed`, and `cancelled` run states remain immutable. A `completed_with_errors` run may be reopened only through this explicit repair path.

The repair control flow is deliberately ordered:

```text
read-only repair plan
→ validate persisted parser/config contract
→ validate refresh/Ahrefs/cache/output writability
→ atomically journal old keyword + SERP evidence and reset failed checkpoints to pending
→ mark run paused/resumable
→ force cache bypass for open repair checkpoints
→ browser collection / ordinary executeRun
→ close retry journal from terminal current checkpoints
→ republish artifacts from reconciled SQLite state
```

Rejected config/cache/output preflight leaves `run.sqlite` unchanged because mutation happens only at the atomic apply step. Once applied, the open retry attempt is durable before browser work begins, so a browser/CAPTCHA interruption can continue with ordinary `--resume` without losing operator intent.

Retry history is append-only per `(run_id, keyword_idx, retry_no)`: it preserves the previous keyword record and SERP rows and, after completion, the resulting record and rows. Retry numbers are monotonic. Old SERP rows are replaced rather than appended, stale domain membership is removed, and a domain's previous first-seen keyword owner is retained while that owner still has current SERP evidence.

An open repair is its own transient reason to bypass the ordinary keyword cache. This bypass is not persisted into the run's normal `refresh_keywords`, so completing a one-time repair does not turn the keyword into a permanently forced refresh. Independent successful related-keyword evidence is not erased merely because the primary keyword checkpoint is repaired.

## Stage 9 — Output

Write all run artifacts even if some keywords failed.

A partial run must be inspectable.

New discovery artifacts are written under
`<RESEARCH_OUTPUT_ROOT>/<date>-<label>/discovery`. The sibling research directory
holds parser debug evidence under `debug/` and the atomically refreshed
`results.zip`. Legacy `runs/<uuid>` directories are resume-compatible only; they
are not created for new work.

Generate:

```text
manifest.json
keywords.json
serp.json
keywords.csv
related-keywords.csv
serp.csv
domains.csv
candidates.csv
report.md
status.json
```

Errors must not disappear from output. Source-specific Google SERP status/error is retained in the per-keyword JSON and surfaced in the failed/incomplete section of `report.md`. Existing CSV column contracts remain stable; unavailable numeric SERP evidence is represented as an empty cell rather than `0` or the string `null`.

---

## CLI and progress UX

The CLI is the user interface of the product. Progress visibility is required.

## Preflight

Before a large run:

```text
Utility Research Runner

[preflight]
✓ Research Chrome connected
✓ Keyword Surfer detected
✓ Surfer market: United States
✓ Google reachable
• Ahrefs DR: configured, or skipped honestly when no key is supplied
✓ Cache writable
✓ Research output directory writable

Input: 217 rows
Unique keywords: 184
Ready.
```

If any required dependency is broken, stop before processing hundreds of keywords.

## Stage progress

Example:

```text
[1/6] Loading input
✓ 217 rows loaded
✓ 184 unique keywords

[2/6] Google + Keyword Surfer
[47/184] json diff
✓ volume: 8,100
✓ cpc: $10.55
✓ organic results: 10
✓ related ideas: 20

Keywords 47/184 | Cache 61% | Errors 2 | ETA ~14m

[3/6] Normalizing domains
✓ 932 unique domains

[4/6] Ahrefs DR
[381/932] example.com → DR 17
Domains 381/932 | Cache 74% | API requests 99 | ETA ~3m

[5/6] Aggregating
✓ metrics calculated

[6/6] Writing outputs
✓ candidates.csv
✓ report.md
✓ status.json

Done in 21m 42s
```

## Waiting/retry states

```text
[74/184] randomize list
⚠ Surfer data missing
retry 1/3 in 4s
```

## CAPTCHA

```text
⚠ Google CAPTCHA detected.

Solve the CAPTCHA in Research Chrome.
The runner polls the page and continues automatically after the challenge disappears.

Ctrl+C pauses safely and leaves the active keyword resumable.
```

No CAPTCHA bypass, Enter prompt, or marker-file handshake.

## Geo warning

If target market and detected Google location disagree:

```text
⚠ SERP GEO WARNING
Target: United States
Google detected location: Chelyabinsk Oblast, Russia

Keyword Surfer metrics use the configured US market,
but organic rankings may still be influenced by physical location.
```

This warning should be visible once prominently and recorded per run.

## Logging modes

```text
default
--verbose
--debug
```

Default:
- stage progress;
- current keyword/domain;
- retries;
- warnings;
- final summary.

Verbose:
- cache hits/misses;
- API status;
- timing;
- parser decisions.

Debug:
- selectors;
- parser internals;
- diagnostic artifact paths;
- browser/frame details.

## Agent-friendly mode

```bash
npm run research -- ... --json-status
```

The final stdout line must be valid machine-readable JSON. Artifact paths point at
the allocated discovery directory, for example:

```json
{
  "status": "completed_with_errors",
  "runId": "<run-id>",
  "keywords": 184,
  "processedKeywords": 184,
  "errors": 3,
  "candidateReport": "<RESEARCH_OUTPUT_ROOT>/2026-08-28-example/discovery/candidates.csv",
  "report": "<RESEARCH_OUTPUT_ROOT>/2026-08-28-example/discovery/report.md",
  "statusFile": "<RESEARCH_OUTPUT_ROOT>/2026-08-28-example/discovery/status.json"
}
```

## Exit codes

The research CLI has a stable exit-code contract:

```text
0   success, including completed_with_errors
1   unexpected internal failure
2   invalid input/configuration
3   preflight/infrastructure failure
130 gracefully paused by Ctrl+C
```

---

## Scoring

## Purpose

Scoring is a sorting heuristic, not a final business verdict.

The system must expose the raw features used so the score never becomes an opaque magic number.

## Observable inputs

Possible v1 inputs:

```text
Surfer volume
Surfer CPC
Microsoft bucket/value
organic result count
min DR
median DR
top3 median DR
top5 median DR
weak-domain count
very-weak-domain count
strong-domain count
very-strong-domain count
SERP domain diversity
exact-match/niche-domain count
missing-DR ratio
```

SERP-derived inputs participate only when the Google SERP observation is trustworthy.

## Important methodological constraints

### Do not sum synonym volumes automatically

Queries such as:

```text
compare lists
list comparison
compare two lists
```

may heavily overlap.

Each keyword should retain its own demand signal. Cluster-level volume is not a simple sum.

### Microsoft is not truth

Microsoft data is useful for broad discovery. A low Microsoft bucket must not automatically kill a keyword.

### DR is not truth

DR alone does not determine accessibility.

A low-DR spam domain with zero traffic is not proof of opportunity.

The runner only has DR in v1, so scoring should use it as a coarse filter, while final validation still requires manual Ahrefs traffic/backlink inspection.

## Suggested score structure

Keep weights in config.

Example:

```text
Demand                  0–30
SERP accessibility      0–40
Commercial proxy        0–10
SERP diversity          0–10
Data completeness       0–10
```

Do not include subjective implementation complexity unless it is supplied manually.

## Candidate tiers

The report may expose neutral tiers:

```text
A — inspect first
B — inspect if time
C — weak/uncertain
D — probably saturated/low-demand
```

Avoid calling these automatically `BUILD` or `KILL`.

## Explainability

For each scored candidate provide a short machine-generated rationale using raw facts, e.g.:

```text
Score 84
- volume 27,100
- 4/9 ranking domains have DR < 30
- min DR 3
- top3 median DR 19
- CPC $2.40
```

An unscored candidate with unavailable SERP evidence must remain visibly incomplete rather than receive a zero-like rationale.

Do not generate speculative prose.

---

## Output contracts

## keywords.csv

Suggested columns:

```text
keyword
sources
microsoft_volume
microsoft_bucket
surfer_volume
surfer_cpc
surfer_market
google_hl
google_gl
detected_google_location
geo_warning
organic_result_count
status
error_code
```

`organic_result_count` is blank when Google SERP evidence is unavailable/ambiguous and `0` only for a confirmed genuine empty SERP. Source-specific SERP status/error is retained in `keywords.json` and the report without changing the established CSV column list.

## related-keywords.csv

```text
parent_keyword
keyword
overlap
volume
selected_for_expansion
```

## serp.csv

```text
keyword
position
title
url
hostname
registrable_domain
result_type
dr
```

## domains.csv

```text
domain
dr
ahrefs_status
first_seen_in_run
cache_hit
fetched_at
```

## candidates.csv

```text
keyword
surfer_volume
surfer_cpc
microsoft_volume
organic_result_count
unique_domains
min_dr
median_dr
top3_median_dr
top5_median_dr
very_weak_domains
weak_domains
strong_domains
very_strong_domains
exact_match_domains
niche_domains
score
tier
status
```

When a candidate lacks trustworthy SERP evidence, its SERP-derived numeric cells and score/tier are blank. Genuine observed zeros remain numeric zero. Exact-match and niche-domain classification must be documented if implemented.

## report.md

Human-readable summary:

```text
Run overview
Input summary
Environment/geo warnings
Top candidates
Failed/incomplete keywords + source-specific SERP status
Cache statistics
Ahrefs statistics
Parser health
Next manual checks
```

Do not hide errors.

## status.json

Machine-readable final status.

## Historical behavior

Ordinary completed runs are historical artifacts and are never reopened by normal resume. The one narrow exception is an explicit `--resume <run-id> --retry-failed` repair of a `completed_with_errors` discovery run, which mutates that same logical run while preserving append-only retry evidence. Fully `completed`, `failed`, and `cancelled` discovery states remain immutable.

New runs use the durable research layout under `RESEARCH_OUTPUT_ROOT`; terminal discovery/enrichment directories are historical artifacts. Legacy `runs/<uuid>` / `enrichments/<uuid>` directories remain readable and resumable only where explicitly supported, but are not the layout for new work.
