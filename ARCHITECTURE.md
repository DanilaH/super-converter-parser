# ARCHITECTURE.md

## Principles

1. Local-first.
2. CLI-first.
3. Strict TypeScript.
4. Reuse the browser/Surfer/SERP logic proven by the spike.
5. Persistent cache and resumability are core functionality, not polish.
6. No frontend framework.
7. No unnecessary service architecture.
8. Provider integrations must be isolated behind small adapters.
9. Raw evidence must be retained for debugging parser breakage.

## Proposed stack

```text
Node.js
TypeScript
Playwright
CSV parser/writer
small durable local persistence layer
```

Persistence can be implemented with SQLite or a carefully designed file-based store.

Preferred decision rule:

- use SQLite if it materially simplifies cache TTL, run state, atomic checkpoints, and queries;
- use JSON/files only if reliability remains equally clear and atomic.

Do not introduce a remote database.

## High-level modules

```text
src/
├── cli/
├── config/
├── input/
│   ├── seeds/
│   └── microsoft/
├── browser/
├── google/
├── surfer/
├── ahrefs/
├── domains/
├── cache/
├── runs/
├── scoring/
├── output/
├── diagnostics/
└── shared/
```

Keep `shared` intentionally small.

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

The spike showed useful extension elements injected into the main Google document, including:

```text
surfer-main-keyword-widget
keyword-surfer-result
keyword-surfer-sidebar
```

The implementation should reuse the proven parsing strategy where reasonable, but selectors must be centralized and guarded with parser health checks because extension/Google DOM can change.

## Google location model

Track these independently:

```ts
type ResearchMarket = {
  surferMarket: string;       // e.g. US
  googleHl: string;           // e.g. en
  googleGl: string;           // e.g. us
  detectedGoogleLocation?: string;
  serpGeoMatchesTarget?: boolean;
};
```

`gl=us` does not guarantee a physically US-localized SERP.

The runner must never silently claim "US SERP" merely because `gl=us` was supplied.

## Ahrefs

Use the official free Domain Rating endpoint.

Do not scrape Ahrefs UI.

Ahrefs integration should accept a normalized registrable domain and return:

```ts
type DomainRatingResult = {
  domain: string;
  dr: number | null;
  fetchedAt: string;
  source: "ahrefs";
  status: "ok" | "not_found" | "error";
};
```

## Agent compatibility

The runner must expose:

- stable CLI commands;
- meaningful exit codes;
- `status.json`;
- final JSON status output option;
- deterministic result paths.

An agent should not need to parse ANSI terminal progress output to know whether a run succeeded.

---

## Data model

The exact implementation may differ, but the information below must be representable without lossy transformations.

## Keyword

```ts
type KeywordRecord = {
  id: string;
  keyword: string;
  normalizedKeyword: string;

  sources: Array<
    | { type: "seed" }
    | { type: "microsoft"; sourceRow?: number }
    | {
        type: "surfer_related";
        parentKeyword: string;
        overlap?: number | null;
      }
  >;

  microsoft?: {
    volumeBucket?: string | null;
    volumeRaw?: number | null;
    competition?: string | null;
    cpc?: number | null;
  };

  surfer?: {
    volume: number | null;
    cpc: number | null;
    market: string;
    fetchedAt: string;
  };

  google?: {
    hl: string;
    gl: string;
    pageUrl: string;
    detectedLocation?: string | null;
    geoWarning?: boolean;
  };

  status:
    | "pending"
    | "running"
    | "completed"
    | "partial"
    | "failed";
};
```

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
  position: number;
  title: string;
  url: string;
  hostname: string;
  registrableDomain: string;
  resultType: "organic" | "featured_organic" | "unknown";
  dr: number | null;
};
```

## Domain cache entry

```ts
type DomainCacheEntry = {
  domain: string;
  dr: number | null;
  source: "ahrefs";
  status: "ok" | "not_found" | "error";
  fetchedAt: string;
  expiresAt: string;
};
```

## Keyword cache entry

Cache separately:

1. Google/Surfer research result;
2. related-keyword result;
3. domain DR.

This allows independent TTLs and refresh.

```ts
type KeywordResearchCache = {
  keyword: string;
  market: string;
  hl: string;
  gl: string;
  volume: number | null;
  cpc: number | null;
  organicResults: SerpResult[];
  fetchedAt: string;
  expiresAt: string;
  parserVersion: string;
};
```

## Run

```ts
type RunManifest = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  state:
    | "created"
    | "running"
    | "paused"
    | "completed"
    | "completed_with_errors"
    | "failed"
    | "cancelled";

  input: {
    kind: "seeds" | "microsoft";
    path: string;
  };

  configSnapshot: unknown;
  parserVersion: string;

  progress: {
    totalKeywords: number;
    completedKeywords: number;
    totalDomains: number;
    completedDomains: number;
    errors: number;
  };
};
```

## Cache invariants

- Cache entries must include fetch timestamp.
- TTL must be configurable by source.
- A parser-version change may invalidate browser-derived cache if necessary.
- Failed responses should not be cached with the same TTL as successful data.
- Force-refresh must bypass cache intentionally.

---

## Configuration

Configuration should be explicit and versioned into each run manifest.

Example shape:

```ts
type Config = {
  research: {
    market: "US";
    googleHl: "en";
    googleGl: "us";
    topN: 10;
  };

  browser: {
    cdpUrl: string;
    navigationTimeoutMs: number;
    surferWaitTimeoutMs: number;
  };

  rateLimit: {
    keywordConcurrency: number;
    minDelayMs: number;
    maxDelayMs: number;
  };

  retries: {
    maxAttempts: number;
    baseDelayMs: number;
  };

  cache: {
    keywordTtlHours: number;
    relatedKeywordTtlHours: number;
    domainDrTtlHours: number;
  };

  surferExpansion: {
    enabled: boolean;
    maxRelatedPerSeed: number;
    maxDepth: 1;
    minVolume?: number;
  };

  drThresholds: {
    veryWeakBelow: number;
    weakBelow: number;
    strongFrom: number;
    veryStrongFrom: number;
  };

  circuitBreaker: {
    rollingWindow: number;
    maxParserFailureRate: number;
    maxConsecutiveGoogleFailures: number;
  };
};
```

Secrets:

```text
AHREFS_API_KEY
```

must come from environment configuration and must never be committed.

Provide `.env.example`.

Every run must save a sanitized config snapshot in `manifest.json`.

---

## Reliability requirements

Reliability is part of v1.

## Persistent cache

Cache:

1. keyword → Google/Surfer result;
2. keyword → Surfer related ideas;
3. domain → Ahrefs DR.

Required:

- persisted between runs;
- configurable TTL;
- cache hit/miss statistics;
- force refresh;
- safe invalidation.

Suggested default TTLs are implementation decisions and must be documented.

## Resume/checkpoints

A run must persist progress incrementally.

If it stops at keyword 137/200:

```text
npm run research -- --resume <run-id>
```

must continue unfinished work.

Do not require restarting from zero.

## Atomicity

Checkpoint writes should be atomic enough that an interrupted process does not corrupt the entire run state.

## Graceful shutdown

On Ctrl+C:

```text
Stopping...
✓ active work settled/cancelled safely
✓ checkpoint saved
✓ run marked paused
```

Then print the resume command.

## Retry policy

Use bounded retries with exponential backoff + jitter for transient failures.

Do not retry indefinitely.

Classify at least:

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
```

## Error isolation

One keyword failure must not kill the whole batch unless a circuit-breaker condition is met.

One Ahrefs domain failure must not kill the whole batch.

Failed records remain in outputs with status/error metadata.

## Circuit breaker

If parser/system health clearly collapses, pause instead of producing garbage.

Examples:

```text
12 of last 15 Surfer parses failed
→ pause

10 consecutive Google SERP parse failures
→ pause
```

Thresholds should be configurable.

## Parser versioning

Browser-derived cache/output must include a parser version.

When Google/Surfer DOM changes, it should be possible to distinguish results produced by different parser versions.

## Debug artifacts

Always save lightweight run logs.

On parser errors save:

```text
debug/<keyword-slug>/
├── page.html
├── page.png
└── parser-context.json
```

Avoid dumping huge debug snapshots for every successful keyword by default.

`--debug` may preserve more evidence.

## Raw evidence

The user should be able to inspect why a parser failed without rerunning immediately.

## Rate limiting

Browser search should be deliberately conservative.

Do not maximize concurrency.

Initial default should favor correctness and avoiding anti-bot triggers over speed.

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
