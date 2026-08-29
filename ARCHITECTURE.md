# ARCHITECTURE.md

## Principles

1. Local-first.
2. CLI-first.
3. Strict TypeScript.
4. Reuse the browser/Surfer/SERP integration proven by the spike.
5. Persistent cache and resumability are core functionality, not polish.
6. No frontend framework.
7. No unnecessary service architecture.
8. Provider integrations stay isolated behind small adapters.
9. Raw/debug evidence is retained when parser health fails.
10. User-facing artifacts must distinguish measured, unavailable, failed, and intentionally omitted data.

## Implemented stack

```text
Node.js >= 20
TypeScript 5
Playwright Core over CDP
better-sqlite3
csv-parse
undici
TLDTS
CSV / JSON / Markdown artifacts
```

SQLite is the implemented durable persistence layer. It is not an optional proposal:

```text
Discovery run        -> <research>/discovery/run.sqlite
Deep enrichment     -> <research>/enrichment*/enrichment.sqlite
Cross-run cache     -> data/cache/cache.sqlite (configurable)
```

JSON/CSV/Markdown files are publication artifacts derived from durable state; they are not the resume source of truth. Do not introduce a remote database unless the product architecture changes materially.

## High-level modules

```text
src/
├── ahrefs/          # Domain Rating provider adapter
├── browser/         # CDP connection, collection, CAPTCHA/preflight
├── cache/           # Persistent cross-run cache + identities/TTL
├── cli/             # research / enrich entry points
├── config/          # typed runtime configuration
├── db/              # SQLite schema, migrations, RunStore
├── diagnostics/     # parser-failure evidence
├── domains/         # hostname / registrable-domain normalization
├── enrichment/      # clusters, suggestions, pages, site structure, HTTP safety
├── exports/         # generic CSV/export helpers
├── firstseen/       # first-seen provider adapter (Wayback path)
├── google/          # SERP, autocomplete, PAA, related-search parsing
├── input/
│   ├── seeds/
│   └── microsoft/
├── outputs/         # research layout, archive/publication paths
├── rdap/            # registration-date provider adapter
├── runs/            # discovery engine, snapshots, domain-age enrichment
├── scoring/         # candidate scoring/ranking
├── shared/          # intentionally small cross-cutting utilities
└── surfer/          # Keyword Surfer parsing/selectors
```

Keep `shared` intentionally small. Provider-specific behavior belongs in its provider module; durable state belongs behind `RunStore`/cache abstractions rather than ad-hoc files.

## Runtime shape

The product has two durable phases.

### Discovery

```text
Seeds / Microsoft CSV
        ↓
research CLI
        ↓
Google + Keyword Surfer via Playwright/CDP
        ↓
optional Ahrefs DR
        ↓
run.sqlite checkpoints
        ↓
keywords / SERP / related / domains / candidates artifacts
```

A fresh run is allocated only after input/config/cache preflight that can be completed without durable run state. Once a run row and keywords exist, browser preflight failures or cancellation remain resumable.

### Deep enrichment

```text
completed discovery run + explicit shortlist
        ↓
enrich CLI
        ↓
clusters | query_suggestions | domain_age | pages | site_structure
        ↓
enrichment.sqlite per-module/per-target checkpoints
        ↓
module CSV/JSON + status.json + manifest.json
```

Deep modules are bounded independently. Domain caps must be visible in artifacts as omitted evidence, not silently discarded.

## Browser architecture

Use a dedicated persistent research Chrome profile.

```text
Research Chrome profile
├── Keyword Surfer installed
├── Surfer market configured
└── persistent cookies/settings
        ↓
Playwright/CDP
        ↓
Google searches
```

Do not use the user's normal Chrome profile.

Do not automate Chrome Web Store extension installation. One-time manual installation is acceptable.

## Proven Surfer integration

The implementation relies on extension elements injected into the main Google document, including markers such as:

```text
surfer-main-keyword-widget
keyword-surfer-result
keyword-surfer-sidebar
```

Selectors are centralized and versioned. Parser-health failures must produce structured errors/debug evidence instead of silently turning missing DOM into valid zero data.

## Google location model

Track these independently:

```ts
type ResearchMarket = {
  surferMarket: string;
  googleHl: string;
  googleGl: string;
  detectedGoogleLocation?: string;
  serpGeoMatchesTarget?: boolean;
};
```

`gl=us` does not guarantee a physically US-localized SERP. The runner must never silently claim "US SERP" merely because `gl=us` was supplied.

## Provider boundaries

### Ahrefs

Use the official free Domain Rating endpoint. Do not scrape Ahrefs UI.

The adapter accepts a normalized registrable domain and returns a structured success/not-found/error result. Requests, including response-body consumption, are timeout-bounded. Authentication failures are treated as systemic rather than fanned out across every domain.

### RDAP

RDAP resolves registration evidence. Bootstrap/query state is isolated behind the RDAP adapter, with bounded retries/backoff and capped `Retry-After` handling.

### First seen

First-seen evidence is a separate fact from registration date. It may be unavailable when no provider is configured. Registration date and first-seen date must never alias one another.

## Agent compatibility

The CLIs expose:

- stable commands;
- meaningful exit codes;
- `status.json`;
- final JSON status output option;
- deterministic result paths;
- durable SQLite checkpoints for resume.

An agent should not need to parse ANSI terminal progress output to determine whether a run succeeded.

---

## Data model

The shapes below describe logical runtime records. SQLite schemas/migrations are authoritative for persisted identifiers and checkpoints.

## Keyword identity

The browser/discovery runtime works with `KeywordRecord`; SQLite loads the persisted form as `StoredKeyword`, which has the stable numeric `idx` used to own SERP rows and checkpoints. The persisted shape is related to, but is not literally a TypeScript extension of, `KeywordRecord`.

```ts
type KeywordRecord = {
  id: string;
  keyword: string;             // original display text
  normalizedKeyword: string;   // normalized semantic/cache lookup text
  sources: KeywordSource[];
  status: "pending" | "running" | "completed" | "partial" | "failed";
  // microsoft / surfer / google / error fields omitted here for brevity
};

type StoredKeyword = {
  idx: number;                 // durable per-run ownership key
  id: string;
  keyword: string;
  normalizedKeyword: string;
  sources: KeywordSource[];
  status: "pending" | "running" | "completed" | "partial" | "failed";
  cacheStatus: "hit" | "miss" | "expired" | "refreshed" | null;
  // persisted surfer / google / error / collectedAt fields omitted here
};
```

Conceptually, keyword provenance has these source variants:

```ts
type KeywordSource =
  | { type: "seed"; rowNumbers: number[] }
  | {
      type: "microsoft";
      sourceRow: number;
      adGroup: string;
      volumeBucket: string | null;
      volumeRaw: number | null;
      competition: string | null;
      cpc: number | null;
    }
  | {
      type: "surfer_related";
      parentKeyword: string;
      overlap?: number | null;
      rowNumbers?: number[];
    };
```

Text normalization is not a relational ownership key. Discovery SERP ownership and scoring use the durable per-run keyword index. Deep-enrichment relations owned by a source keyword—clustering graph nodes/members/canonical keyword, pairwise comparisons, exclusions, query-suggestion parent occurrences, and per-parent/source suggestion checkpoints—use `(sourceRunId, keywordIdx)` identity. The enrichment run persists `sourceRunId`, so enrichment tables store `keywordIdx` as the local relation key. Normalized text remains intentional for semantic suggestion dedupe, cross-run cache identity (where source-run idx is not portable), user shortlist lookup, display/provenance, and compatibility reads of historical text-owned enrichment rows. Query-suggestion resume ownership is resolved from idx-owned source checkpoint rows; `enrichment_items` is lifecycle/accounting metadata, not a source-keyword ownership authority.

## Google SERP observation

Google organic evidence is persisted independently from the aggregate keyword status because Surfer and Google can succeed or fail independently.

Fresh collection writes a source-specific Google observation under the persisted `google` JSON:

```ts
type SerpObservationStatus =
  | "ok"
  | "empty"
  | "fetch_error"
  | "parse_error"
  | "not_fetched"
  | "unknown"; // compatibility projection for ambiguous historical rows

type GoogleObservation = {
  hl: string;
  gl: string;
  pageUrl: string;
  detectedLocation: string | null;
  geoWarning: boolean;
  serpStatus: SerpObservationStatus;
  serpError: { code: string; message: string } | null;
};
```

Truth invariant:

```text
serpStatus=ok    + persisted rows → organic_result_count=N
serpStatus=empty + zero rows      → organic_result_count=0
fetch/parse/not_fetched/unknown   → organic_result_count missing
```

An aggregate keyword may therefore be `failed` because Surfer failed while its Google SERP observation is truthfully `empty`, or `partial` because Surfer succeeded while Google parsing failed. Candidate scoring requires trustworthy SERP evidence; a Google parse/fetch failure cannot be interpreted as an easy zero-result SERP.

Historical rows that predate `serpStatus` are interpreted conservatively from durable state. Positive stored SERP rows prove `ok`; a clean historical `completed` zero-row keyword proves the old collector's confirmed zero-results path; ambiguous terminal zero-row records remain `unknown` instead of becoming zero.

The Google parser version is part of keyword cache/resume identity. Changes to this observation contract therefore require a parser-version bump instead of silently reusing old cached semantics.

## Related keyword

```ts
type RelatedKeyword = {
  parentKeyword: string;
  keyword: string;
  overlap: number | null;
  volume: number | null;
  fetchedAt: string;
};
```

## SERP row

```ts
type SerpResult = {
  keyword: string;
  keywordIdx?: number;         // populated for persisted rows
  position: number;
  title: string;
  url: string;
  hostname: string;
  registrableDomain: string;
  dr: number | null;
  drStatus: "ok" | "not_found" | "error" | "not_attempted" | null;
  drError?: string | null;
  resultType: "organic";
};
```

## Cache identities

Cache separate facts independently:

1. Google/Surfer keyword research;
2. Surfer related-keyword expansion;
3. Ahrefs domain DR;
4. RDAP/first-seen domain-age facts;
5. query-suggestion source results.

This allows independent TTLs, parser versions, refresh, and error lifetimes. A short-lived sibling fact must not reset or invalidate an unrelated long-lived fact.

## Durable run state

Discovery state lives in `run.sqlite`; enrichment state lives in `enrichment.sqlite`. Important invariants:

- schema changes use versioned migrations;
- per-keyword/per-target work is checkpointed incrementally;
- a terminal artifact is published only from durable state;
- resume resets interrupted `running` work to retryable state where appropriate;
- completed checkpoints are not re-fetched merely because a mutable cross-run cache entry changed;
- omitted work is terminal evidence, not successful measurement.

### Failed-keyword repair journal

Ordinary resume does not reopen terminal failed keyword checkpoints. Discovery has one explicit repair path:

```text
npm run research -- --resume <run-id> --retry-failed
```

The path is intentionally narrow:

- `completed_with_errors` may be reopened only through this explicit flag; `completed`, `failed`, and `cancelled` run states remain immutable;
- a read-only repair plan is built first from the durable failed keyword indexes;
- persisted parser/config semantics, refresh input, Ahrefs requirements, cache open, and discovery/debug directory writability are validated before the plan mutates `run.sqlite`;
- the plan is then revalidated and applied synchronously in one SQLite transaction immediately before browser work;
- only planned `failed` checkpoints are reset to `pending`; completed/partial siblings are untouched;
- the previous keyword record and its SERP rows are copied into append-only attempt history before current SERP evidence is cleared;
- current domain membership/first-seen ownership is reconciled from the surviving current SERP rows so removed failed SERPs cannot leave ghost domains;
- a stale plan aborts the whole repair transaction rather than partially reopening a batch.

Retry history is stored in the same `run.sqlite` under the feature-owned, independently versioned `keyword_retry_schema` / `keyword_retry_attempts` extension. The core discovery schema version is not bumped merely to make an operator who never uses failed repair create those tables. Ordinary reads do not create the extension schema.

An open retry attempt is durable repair intent. It transiently forces the corresponding keyword cache decision to `refreshed` for that invocation, but is not copied into the run's persistent `refresh_keywords`. Therefore an interrupted repair continues with ordinary `--resume` and still bypasses the stale failed keyword cache, while a completed repair does not become a permanent forced refresh.

If the process dies after a repaired keyword checkpoint commits but before the attempt journal is closed, the next resume reconciles the open attempt from the current durable keyword/SERP state without performing a second browser request.

---

## Configuration

`ResearchConfig` is explicit and persisted as a sanitized snapshot for reproducibility. The implemented top-level shape is:

```ts
type ResearchConfig = {
  research: {
    market: string;
    googleHl: string;
    googleGl: string;
    topN: number;
  };

  browser: {
    cdpUrl: string;
    navigationTimeoutMs: number;
    surferWaitTimeoutMs: number;
    surferPreflightTimeoutMs: number;
    surferWidgetSelector: string;
    surferRelatedWidgetSelector: string;
    surferRelatedMissingWidgetTimeoutMs: number;
  };

  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };

  circuitBreaker: {
    surferWindow: number;
    surferFailureThreshold: number;
    googleConsecutiveThreshold: number;
  };

  expansion: {
    enabled: boolean;
    depth: number;
    maxCandidatesPerKeyword: number;
    minOverlap: number;
    minVolume: number;
  };

  cache: {
    path: string;
    ttl: Record<string, number | object>;
  };

  ahrefs: {
    endpoint: string;
    rateLimitMinDelayMs: number;
    rateLimitMaxDelayMs: number;
    timeoutMs: number;
    requireAhrefs: boolean;
  };

  rdap: object;
  firstSeen: object;

  scoring: {
    drThresholds: {
      veryWeakMax: number;
      weakMax: number;
      strongMin: number;
      strongMax: number;
    };
  };
};
```

The exact nested TTL/provider fields are defined in `src/config/config.ts`; do not duplicate independent defaults elsewhere.

Secrets such as:

```text
AHREFS_API_KEY
```

come from environment configuration and must never be committed or persisted in sanitized run snapshots.

---

## Reliability requirements

Reliability is part of v1.

## Persistent cache

Required properties:

- persisted between runs;
- configurable TTL per fact/status;
- parser/query-version aware where semantics depend on a parser contract;
- cache hit/miss/error accounting;
- force refresh;
- safe invalidation;
- failed responses use shorter TTLs than valid stable data.

## Resume/checkpoints

A discovery run stopped partway through must continue unfinished work:

```text
npm run research -- --resume <run-id>
```

A discovery run that reached `completed_with_errors` may explicitly repair only its failed keywords without replaying successful siblings:

```text
npm run research -- --resume <run-id> --retry-failed
```

A deep-enrichment run resumes by enrichment ID:

```text
npm run enrich -- --resume <enrichment-id>
```

Resume correctness comes from SQLite checkpoints, not from re-reading CSV artifacts. Ordinary resume leaves terminal keyword checkpoints untouched; failed-keyword repair is the explicit exception described above and preserves prior-attempt evidence before reopening current state.

## Atomic publication

Writes that represent terminal/public state are atomic enough that an interrupted write does not advertise a completed run with mismatched artifacts. `manifest.json` is the final publication marker for terminal output sets; status/manifest publication must remain consistent.

## Graceful shutdown

On the first Ctrl+C, the system requests a graceful pause and preserves resumability. A second Ctrl+C may force termination. A paused run must print enough information to resume it.

## Retry policy

Use bounded retries with backoff + jitter for transient failures. `Retry-After` is advisory but must be capped by the configured maximum delay. Network timeouts cover body consumption as well as response headers.

Do not retry indefinitely.

Representative classified errors include:

```text
BROWSER_CONNECTION_ERROR
SURFER_NOT_DETECTED
SURFER_PARSE_ERROR
GOOGLE_SERP_PARSE_ERROR
GOOGLE_UNAVAILABLE
CAPTCHA_REQUIRED
AHREFS_RATE_LIMIT
AHREFS_ERROR
INPUT_SCHEMA_ERROR
OUTPUT_WRITE_ERROR
CACHE_DB_ERROR
```

## Error isolation

One keyword failure must not kill the whole discovery batch unless a circuit-breaker condition is met.

One domain/provider failure must not erase successful sibling evidence.

For query suggestions, each source is isolated. Successful source collections survive a sibling failure; bounded retries request only sources that have not produced a result.

Failed or unavailable records remain distinguishable in durable state and artifacts.

## Circuit breaker

If parser/system health clearly collapses, pause instead of producing garbage. Thresholds are configurable and persisted as part of run semantics where relevant.

## Parser versioning

Browser-derived cache/output includes parser-version identity where parser semantics affect validity. Parser changes that alter interpretation must invalidate or version cached facts rather than silently mixing contracts.

## Debug artifacts

On parser errors, retain lightweight evidence under the run debug directory, for example:

```text
debug/<keyword-slug>/
├── page.html
├── page.png
└── parser-context.json
```

Avoid dumping large snapshots for every successful keyword by default.

## HTTP / SSRF boundary

Deep HTTP inspection (`pages`, `site_structure`) must retain the bounded-fetch safety contract:

- DNS/IP validation before connection;
- private/reserved address blocking;
- redirect re-validation;
- pinned/validated connection target where implemented;
- response byte/text limits;
- timeout covering body reads;
- bounded retry/backoff.

Do not replace this path with a raw unbounded `fetch` for convenience.

## Raw evidence and measurement honesty

The user must be able to tell why a parser/provider failed without immediately rerunning it. Missing evidence must not be silently converted into zero, success, or a fabricated measurement.

Examples:

- missing SERP is not `organic_result_count = 0` unless zero was actually observed;
- source-specific Google status/error is preserved even when the aggregate keyword error belongs to Surfer;
- omitted domains are explicitly marked `omitted` / `domain_cap`;
- unavailable first-seen data is distinct from registration data;
- successful suggestion sources are retained even if another source fails.

## Rate limiting

Browser search and provider calls are deliberately conservative. Do not maximize concurrency at the expense of correctness, anti-bot stability, or provider limits.

## CAPTCHA policy

Allowed:
- detect;
- pause;
- ask for manual completion;
- resume.

Forbidden:
- CAPTCHA-solving service;
- stealth bypass;
- fingerprint spoofing;
- proxy rotation designed to evade controls.
