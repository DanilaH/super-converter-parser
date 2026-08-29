# SCORING.md — Aggregation, deterministic scoring, and outputs

This document is the **authoritative contract** for the candidate scoring and
output suite (TASK-007 / issue #14). The implementation in `src/scoring/` and
`src/runs/` must match it exactly. The shared version is:

```ts
export const SCORING_VERSION = '1.1.0';
```

Code and this document use the same `SCORING_VERSION`. Any change to a formula,
threshold, tier boundary, or score-eligibility rule must bump the version **and**
update this file in the same change.

## Principles

- Every candidate number is derived only from persisted run records
  (`run.sqlite`, never from the mutable cross-run cache state).
- No LLM scoring. No automatic BUILD/KILL verdicts.
- Missing numeric data never makes a candidate look stronger; it lowers evidence
  and completeness (it can only add `0` to a feature).
- Missing, failed, or ambiguous **SERP observation** is different from a missing
  numeric feature: the candidate remains observable but is not assigned a numeric
  score until the SERP evidence itself is trustworthy.
- Output ordering is fully deterministic.

## 1. Aggregation (per canonical keyword)

For every canonical keyword with trustworthy SERP evidence, the following
features are computed from its organic SERP rows (every `serp_rows` entry has
`result_type = 'organic'`):

- `organic_result_count` — number of organic SERP rows.
- `unique_domains` — number of distinct `registrable_domain` values.
- `min_dr`, `max_dr`, `median_dr` — over the **unique** registrable domains that
  have a known DR (see below).
- `top3_median_dr`, `top5_median_dr` — median DR over the **actual organic rows**
  in positions 1–3 / 1–5 that have a known DR.
- `very_weak_domains_count`, `weak_domains_count`, `strong_domains_count`,
  `very_strong_domains_count` — counts over the **unique** domains with a known
  DR, classified by the thresholds in §2.
- `missing_dr_count` — number of unique domains whose DR is `null` (this
  includes `not_found` and `error` Ahrefs outcomes, which have no numeric DR).
- `exact_match_domain_count` — number of unique domains that exactly match the
  normalized keyword.
- `niche_domain_count` — number of unique non-exact-match domains that satisfy
  the naming heuristic in §3.
- `serp_diversity` — `unique_domains / organic_result_count` (0 when there are
  no organic results).

If SERP evidence is unavailable or ambiguous, SERP-derived candidate fields are
published as missing rather than as synthetic zeros.

### Domain representative occurrence

Domain counts and the overall DR distribution use **unique registrable domains
per keyword**, taking the **first organic position** as that domain's
representative occurrence (its DR is the value used for the domain). If the same
domain appears at positions 1 and 5, only the position-1 row's DR counts for the
domain.

### Known DR vs missing DR

- Known DR = `dr !== null`.
- Missing DR (`dr === null`) is **excluded** from `min_dr`, `max_dr`, and
  `median_dr`. It never becomes `0`.
- `missing_dr_count` counts unique domains with `dr === null`.
- `known_unique_domains = unique_domains - missing_dr_count`.

### Median

Median of an even set is the arithmetic mean of the two middle values. Median of
an odd set is the single middle value. Median is computed only over the relevant
known-DR values; an empty set yields `null`.

### Top-3 / Top-5

Take the organic rows with `position` in 1–3 (or 1–5), keep those with a known
DR, and take their `dr` values (one value per row, including repeated domains).
Median over that list; `null` if the list is empty.

## 2. DR thresholds (centralized in config)

| Class        | Condition                |
| ------------ | ------------------------ |
| very weak    | `DR < 10`                |
| weak         | `10 <= DR < 30`          |
| neutral      | `30 <= DR < 60` (no dedicated count required) |
| strong       | `60 <= DR < 75`          |
| very strong  | `DR >= 75`               |

Thresholds live in `config.scoring.drThresholds`
(`veryWeakMax`, `weakMax`, `strongMin`, `strongMax`) with environment overrides
`SCORING_DR_VERY_WEAK_MAX`, `SCORING_DR_WEAK_MAX`, `SCORING_DR_STRONG_MIN`,
`SCORING_DR_STRONG_MAX`.

## 3. Exact-match and niche-domain classification

Normalization for both keyword and domain label:

1. Unicode NFKD normalize;
2. lowercase;
3. remove every non-alphanumeric character.

- **Exact match**: a unique domain whose normalized label equals the normalized
  keyword (both non-empty).
- **Niche domain** (observable naming heuristic only — **not** a topical
  relevance verdict): a unique domain that is **not** an exact match and where
  at least one normalized keyword token of length `>= 4` occurs as a substring of
  the normalized domain label. This is documented as a heuristic so it is never
  mistaken for a semantic niche signal.

## 4. Score v1.1 (0–100)

### SERP evidence eligibility gate

The arithmetic formula is unchanged from score v1.0. What changed in v1.1 is
whether the formula is allowed to run.

SERP trust is a **necessary** score-eligibility gate, not a sufficient condition.
The existing keyword-status rule still also applies: only `completed` and
`partial` keywords may receive a numeric score. Failed and non-terminal keywords
remain unscored even if a sibling source produced trustworthy Google evidence.

A candidate passes the SERP-evidence gate only when its persisted SERP observation
is trustworthy:

- `ok` with one or more stored organic rows; or
- `empty` with zero stored rows, where zero was explicitly observed.

The following SERP states fail that gate and produce `score = null`, `tier = null`,
blank SERP-derived numeric fields, and degraded completeness:

- `fetch_error`;
- `parse_error`;
- `not_fetched`;
- `unknown` / ambiguous legacy evidence;
- an internally inconsistent explicit state (for example `ok` with zero rows).

This prevents an unavailable SERP from being interpreted as a weak/empty
competitive set. A genuine observed zero-result SERP remains real numeric-zero
SERP evidence and passes the SERP gate; it receives a numeric score only when the
keyword status is also `completed` or `partial`.

For candidates that pass both eligibility rules, `clamp(x, 0, 1)`. Missing
numeric inputs contribute `0` to their feature; missing numeric data never
increases a score.

### Demand — 0–30

```text
30 * clamp( log1p(surfer_volume) / log1p(100000) )
```

Missing Surfer volume → `0`.

### SERP accessibility — 0–40

```text
15 * (1 - clamp(median_dr / 80))                  # a missing median component contributes 0
15 * ((very_weak_domains + weak_domains) / known_unique_domains)   # 0 when known_unique_domains == 0
10 * (1 - clamp(top3_median_dr / 80))             # a missing top3 component contributes 0
```

### Commercial proxy — 0–10

```text
10 * clamp( log1p(surfer_cpc) / log1p(20) )
```

Missing Surfer CPC → `0`.

### SERP diversity — 0–10

```text
10 * serp_diversity
```

### Data completeness — 0–10

```text
6 * (known_unique_domains / unique_domains)   # 0 when unique_domains == 0
+ 2 when Surfer volume is present
+ 2 when at least one organic result is present
```

### Rounding

Sum the unrounded components, then round the final score to two decimal places.

## 5. Tiers

| Tier | Condition              |
| ---- | ---------------------- |
| A    | `score >= 75`          | inspect first |
| B    | `55 <= score <= 74.99` | inspect if time |
| C    | `35 <= score <= 54.99` | weak / uncertain |
| D    | `score < 35`           | probably saturated / low-demand |

Failed / non-terminal keywords remain observable in outputs but have
`score = null` and `tier = null`. Partial terminal keywords may be scored only
when their SERP evidence is trustworthy; for example a Surfer failure may coexist
with successfully observed Google rows, while a Google parse/fetch failure is
not score-eligible.

## 6. Deterministic ordering

Candidates are sorted by:

1. `score` descending (`null` last);
2. `surfer_volume` descending (`null` last);
3. `normalized_keyword` ascending.

## 7. Rationale

Rationale strings are generated from fixed raw facts only (e.g. volume, weak
domain ratio, min / top3 median DR, CPC). No speculative prose, no LLM text.
Example shape:

```text
volume=49500 cpc=7.90 organic=9 uniqueDomains=7 known=5 weak=0 minDr=12 top3MedianDr=20 medianDr=34
```

## 8. Output artifacts

Every publishable snapshot contains:

- `manifest.json`
- `keywords.json`
- `serp.json`
- `keywords.csv` (existing column contract preserved)
- `related-keywords.csv`
- `serp.csv` (preserves existing columns; appends `registrable_domain`, `dr`, `dr_status`)
- `domains.csv`
- `candidates.csv`
- `report.md`
- `status.json`

`related-keywords.csv`: `parent, keyword, overlap, volume, selected, status, error`.

`domains.csv`: `domain, dr, status, error, source, fetched_at, first_seen_keyword, first_seen_position`.

`candidates.csv`: all aggregation features, `score`, `tier`, `scoring_version`,
keyword `status`/`error`, and a deterministic `rationale`. When SERP evidence is
not trustworthy, SERP-derived numeric cells and score/tier are blank rather than
synthetic zero values.

`status.json`: stable machine-readable run status, counts, error total, scoring
version, and paths to every artifact.

`--json-status` prints this status object as the final stdout line (one compact
JSON, no ANSI / surrounding prose).

## 9. Provenance & idempotency

- Observed related keywords are persisted at the run level (parent, keyword,
  overlap, volume, selected-for-expansion, status/error).
- Unique domains are persisted at the run level (DR, Ahrefs status/error,
  `source` = cache | fresh, `fetched_at`, first-seen keyword/position).
- Replaying a completed keyword must not duplicate related/domain records
  (primary keys on `(run_id, parent_idx, related_keyword)` and
  `(run_id, domain)`).
- `AHREFS_API_KEY` is never persisted.

## 10. Scoring completeness metadata (TASK-009)

Score v1.1 keeps the v1.0 arithmetic formula, weights, thresholds, and tier
boundaries. The version bump records the new SERP-evidence eligibility rule.
Completeness metadata remains adjacent evidence; it never boosts a score.

Each candidate carries a `scoring_completeness` field:

- `complete` — the candidate passes the keyword-status and SERP-evidence
  eligibility rules and every SERP domain has numeric DR
  (`missing_dr_count === 0` and at least one known domain). The score is fully
  evidenced.
- `degraded` — some domains have missing DR, Ahrefs was skipped/not-attempted,
  there are no known domains, the keyword status is not score-eligible, or SERP
  evidence itself is unavailable/ambiguous.

Missing DR stays missing; it is never treated as `0`. A numeric score remains
deterministic under the v1.1 formula but must not be presented as fully evidenced
without the adjacent `scoring_completeness` status. Untrustworthy SERP evidence
produces no numeric score at all.

### Per Ahrefs summary

The run exposes an Ahrefs summary sufficient for truthful reporting:

```text
total discovered / attempted / not_attempted
source cache / fresh
status ok / not_found / error
numeric DR coverage
stage mode required / optional
stage state complete / degraded / skipped / failed
```

- **discovered**: unique registrable domains observed in organic SERPs
- **attempted**: domains with terminal Ahrefs status `ok | not_found | error`
- **not_attempted**: DR stage skipped or stopped before lookup
- **numeric DR coverage**: unique domains with `status=ok` and numeric `dr`

`domains.csv`, `manifest.json`, `status.json`, and `report.md` must agree on these
totals. The report must never say "N domains resolved" when they were merely
discovered. The summary is computed from **persisted** domains so it survives
resume correctly.

### Required vs optional mode

- `--require-ahrefs` (or `REQUIRE_AHREFS=true`): missing/blank key fails before
  keyword collection with `AHREFS_REQUIRE_CONFIG`; unusable key/auth rejection
  becomes an explicit `failed` stage, never clean `completed`.
- optional mode (default): without a key, DR is skipped; outputs explicitly say
  `skipped/not_attempted` and scoring completeness is visibly `degraded`.

### Output updates

`candidates.csv` contains a `scoring_completeness` column (`complete | degraded`).
