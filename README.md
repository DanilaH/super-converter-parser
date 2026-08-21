# Utility Research Runner

Local research CLI for discovering and filtering SEO opportunities for small browser utilities.

The tool exists to remove repetitive manual work from the research pipeline:

```text
seed ideas
   ↓
Microsoft Keyword Planner export (optional but recommended for broad discovery)
   ↓
Google + Keyword Surfer
   ├── exact-ish Google-oriented volume
   ├── CPC
   ├── related keyword ideas
   └── organic SERP
   ↓
domain normalization
   ↓
Ahrefs free Domain Rating API
   ↓
aggregation + deterministic scoring
   ↓
candidate shortlist
   ↓
manual deep Ahrefs / Similarweb only for survivors
```

This is an internal local tool, not a SaaS product.

## Proven integration

A completed spike proved that the risky part of the system works:

- dedicated research Chrome can be controlled through Playwright/CDP;
- Keyword Surfer injects data into the Google result page in a form accessible to automation;
- `compare lists` returned `49,500` volume and `7.90` CPC automatically;
- the parser extracted the real organic result set without confusing Keyword Surfer annotations with organic links;
- Keyword Surfer's related-keyword sidebar is also accessible and can be parsed.

The spike output showed the Google URL with `hl=en&gl=us`, but Google still displayed a Russian physical location in the footer. Therefore Surfer market targeting and Google SERP geolocation must be tracked separately.

## Main commands

Target CLI:

```bash
# Main broad-discovery flow
npm run research -- --microsoft input/microsoft.csv

# Direct seed flow
npm run research -- --seeds input/seeds.csv

# Expand direct seeds with Keyword Surfer related ideas
npm run research -- --seeds input/seeds.csv --expand-surfer

# Resume an interrupted run
npm run research -- --resume <run-id>

# Force selected refresh
npm run research -- --resume <run-id> --refresh-keyword "json diff"
npm run research -- --resume <run-id> --refresh-domain example.com

# Machine-readable final status for agents
npm run research -- --microsoft input/microsoft.csv --json-status
```

Exact flag names may be adjusted during implementation if consistency improves, but the capabilities are required.

## Implemented CLI

Currently implemented commands:

```bash
# Single-query spike (proven integration, kept for reference)
npm run probe -- "compare lists"

# Batch research from a seeds CSV (keyword column required)
npm run research -- --seeds input/seeds.csv

# Ignore the persistent cache for every keyword of this run
npm run research -- --seeds input/seeds.csv --force-refresh

# Re-collect specific keywords even if cached (repeatable)
npm run research -- --seeds input/seeds.csv --refresh-keyword "json diff"

# Continue a paused or interrupted run (original input file not required)
npm run research -- --resume <run-id>
```

Configuration via environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `CDP_URL` | `http://127.0.0.1:9222` | Research Chrome DevTools endpoint |
| `SURFER_WAIT_MS` | `60000` | Wait for the Keyword Surfer widget to mount |
| `SURFER_PREFLIGHT_TIMEOUT_MS` | `60000` | Max wait for Keyword Surfer injection during preflight |
| `NAVIGATION_TIMEOUT_MS` | `60000` | Per-navigation timeout |
| `RESEARCH_MARKET` | `US` | Expected Surfer market label |
| `GOOGLE_HL` | `en` | Google interface language |
| `GOOGLE_GL` | `us` | Google geolocation parameter |
| `TOP_N` | `10` | Max organic results per keyword (1–30) |
| `SURFER_WIDGET_SELECTOR` | `.surfer-main-keyword-widget` | Surfer widget selector (parser debug hook) |
| `RETRY_MAX_ATTEMPTS` | `3` | Max collection attempts per keyword |
| `RETRY_BASE_DELAY_MS` | `1000` | Initial retry backoff |
| `RETRY_MAX_DELAY_MS` | `15000` | Retry backoff cap |
| `BREAKER_SURFER_WINDOW` | `15` | Surfer failure window |
| `BREAKER_SURFER_FAILURES` | `12` | Surfer failures in window that pause the run (at most `BREAKER_SURFER_WINDOW`) |
| `BREAKER_GOOGLE_CONSECUTIVE` | `10` | Consecutive Google SERP parse failures that pause the run |
| `CACHE_DB_PATH` | `data/cache/cache.sqlite` | Persistent cache database (created on first run) |
| `CACHE_TTL_COMPLETED_MS` | `7d` | Cache TTL for completed keywords |
| `CACHE_TTL_PARTIAL_MS` | `6h` | Cache TTL for partial keywords |
| `CACHE_TTL_FAILED_MS` | `1h` | Cache TTL for failed keywords |
| `CACHE_TTL_RELATED_MS` | `7d` | Cache TTL for related keywords (ok and empty expansions) |
| `CACHE_TTL_RELATED_ERROR_MS` | `1h` | Cache TTL for failed related-keyword expansions |
| `CACHE_TTL_DOMAIN_OK_MS` | `30d` | Cache TTL for successful domain DR lookups |
| `CACHE_TTL_DOMAIN_NOT_FOUND_MS` | `30d` | Cache TTL for not-found domain DR lookups |
| `CACHE_TTL_DOMAIN_ERROR_MS` | `1h` | Cache TTL for failed domain DR lookups |
| `AHREFS_ENDPOINT` | `https://api.ahrefs.com/v3/public/domain-rating-free` | Official Ahrefs v3 free Domain Rating endpoint (Bearer-authenticated, nested `domain_rating.domain_rating`) |
| `AHREFS_API_KEY` | _(unset)_ | Optional bearer token. The free endpoint works without a key; a key raises rate limits / coverage |
| `AHREFS_TIMEOUT_MS` | `15000` | Per-lookup timeout; aborts and is treated as an error |
| `AHREFS_MIN_DELAY_MS` | `1000` | Minimum delay between domain lookups and the exponential-backoff base |
| `AHREFS_MAX_DELAY_MS` | `10000` | Cap for the bounded exponential backoff between retries |

#### Ahrefs Domain Rating

Domain Rating (DR) is resolved with the official Ahrefs v3 **free** Domain Rating
endpoint (`/v3/public/domain-rating-free`). It is the only sanctioned,
non-scraping source of DR in this tool:

- authentication is a bearer token (`Authorization: Bearer <key>`); the free
  endpoint also answers without a key, so DR enrichment runs even when
  `AHREFS_API_KEY` is unset (a key only improves rate limits / coverage);
- the response is nested: `{ "domain_rating": { "domain_rating": <number> } }`;
- transient failures (429 rate limit, 5xx, network) use **bounded exponential
  backoff with full jitter** (`min * 2^(attempt-1)`, capped at `AHREFS_MAX_DELAY_MS`);
- every successful / not-found / error result is cached with its own TTL
  (`CACHE_TTL_DOMAIN_OK_MS` / `CACHE_TTL_DOMAIN_NOT_FOUND_MS` / `CACHE_TTL_DOMAIN_ERROR_MS`),
  so repeated domains across keywords trigger a single fresh lookup per TTL window;
- `completedDomains` counts every resolved domain regardless of outcome
  (`ok`, `not_found`, `error`), not only those with a numeric DR.

Data source attribution: **Domain Rating and related metrics are © Ahrefs**.
DR is used strictly as one input to an internal, non-promotional scoring step and
is not republished as a standalone Ahrefs dataset.

### Durable run state, checkpoints, and resume

State is committed to SQLite (`runs/<run-id>/run.sqlite`, versioned schema, WAL) after
every keyword, so an interrupted run is never lost. On resume:

- `--seeds` and `--resume` are mutually exclusive; `--resume` reads the persisted queue
  and does not need the original input file;
- `completed`/`partial`/`failed` keywords are never collected again;
- keywords stuck in `running` (crash mid-collection) are reset to `pending`;
- runs in terminal states (`completed*`, `failed`, `cancelled`) refuse resume and are
  never modified;
- a parser version mismatch between the stored run and the current code refuses resume
  (parser versions must not be mixed inside one run);
- the persisted config snapshot supplies the semantic research settings; operational
  settings (connection, timeouts, retries, breaker) come from the current environment.

Run-store schema changes are handled like the cache's: each migration is one atomic
transaction (a failure rolls back and is reported as `DB_ERROR`, leaving the old
version fully usable), and a run store from a newer schema version is refused instead
of opened silently.

Transient errors (`GOOGLE_UNAVAILABLE`) are retried with exponential backoff and
half-jitter up to `RETRY_MAX_ATTEMPTS`. Parser failures are never retried. A circuit
breaker pauses the run with a clear reason when Keyword Surfer parsing fails
(`BREAKER_SURFER_FAILURES` of the last `BREAKER_SURFER_WINDOW`) or when Google SERP
parsing fails `BREAKER_GOOGLE_CONSECUTIVE` times in a row; the run prints its resume
command and exits.

The first Ctrl+C (SIGINT) stops scheduling, lets the active keyword settle, checkpoints,
and marks the run `paused`; a second Ctrl+C force-quits. Exit codes: `0` success
(including `completed_with_errors`), `1` internal error, `2` invalid input/config,
`3` preflight failure, `130` gracefully paused.

Each run writes snapshots under `runs/<run-id>/`, with parser-failure evidence under `debug/<run-id>/`:

```text
runs/<run-id>/
├── run.sqlite     # durable source of truth (WAL, versioned schema)
├── manifest.json  # config snapshot, parser versions, timestamps, progress, pause reason
├── keywords.json  # per-keyword record (status, Surfer volume/CPC, geo, seed provenance rowNumbers, cacheStatus)
└── serp.json      # organic SERP rows with provenance

debug/<run-id>/     # page.html / page.png / parser-context.json on parser failures
```

A parser failure never silently marks a keyword as completed: an unexpected empty organic SERP (page is not a genuine zero-result page) is reported as `GOOGLE_SERP_PARSE_ERROR` with debug evidence.

### Persistent cross-run cache

Successful browser/API work is cached in `data/cache/cache.sqlite` (SQLite, versioned
schema, WAL) so an identical follow-up run avoids fresh browser work. The per-run
`run.sqlite` remains the source of truth: a cache hit is copied into the run
checkpoint, so a run never depends on the cache row after it is committed.

- a keyword entry is keyed by normalized keyword + market + `hl`/`gl` + `topN` +
  Surfer parser version + Google parser version; any change makes it a miss;
- entries expire per status (`CACHE_TTL_*`): completed 7d, partial 6h, failed 1h.
  An expired entry is not a hit but stays stored: a reopen must not purge it
  before the next run can classify it, so open-time cleanup only deletes rows
  that died longer ago than the 30-day grace window (ancient data), and a
  refresh overwrites the expired row it consumed;
- a valid hit is committed to the run without browser lookups, does not touch the
  circuit-breaker window, and keeps the original collection timestamp;
- fresh results are written to the cache only after the run checkpoint succeeded;
  a cache write failure is reported but never corrupts the run;
- `--force-refresh` bypasses the cache for every keyword of the run;
  `--refresh-keyword "<query>"` (repeatable, normalized like the queue, must be one
  of the run keywords) bypasses it for that keyword only;
- refresh semantics are persisted in the run, so a paused forced-refresh run
  resumes forced even without the flags, and a resume with `--refresh-keyword`
  keeps re-collecting that keyword on later resumes;
- the browser decision is made from a single per-keyword cache resolution
  computed up front; the engine executes exactly that decision, so the plan and
  execution can never disagree about the same cache state;
- `--refresh-keyword` is also supported with `--resume`;
- when every pending keyword resolves to a cache hit, the run completes without
  connecting to Chrome at all;
- per-keyword `cache_status` (`hit`/`miss`/`expired`/`refreshed`) is stored in the
  run DB, written into `keywords.json`, and rolled up into `manifest.json`
  progress plus the live progress line. The line shows every bucket so the
  accounting is always complete, e.g.
  `Keywords 4/4 | Cache 75% (3 hit / 0 miss / 1 expired / 0 refreshed) | Browser lookups 1 | Errors 0`;
  the hit rate is the share of processed keywords served from the cache
  (a forced refresh is a deliberate bypass, so it is not a hit); `manifest.json`
  also reports the same value explicitly as `progress.cache.hitRatePercent`;
- related-keyword entries live in the same cache under `related` keys scoped by
  the parent keyword and the same identity (market/hl/gl/topN/parser versions),
  with the expiry derived by the store from `storedAt + ttlMs`. Every entry is
  explicitly `ok` (rows), `empty` (genuinely no related keywords, cached so it
  is not refetched), or `error` (failed expansion, message kept, short TTL via
  `CACHE_TTL_RELATED_ERROR_MS`); `empty`/`error` are distinguishable from
  "never fetched". The contract is enforced on write: `ok` must carry rows and
  `error=null`, `empty` must carry no rows and `error=null`, `error` must
  carry no rows and a non-empty message — any other combination raises
  `CACHE_DB_ERROR` instead of storing a placeholder that would look like a
  successful expansion;
- cache accounting is consistent everywhere and never double-counts: `hit`,
  `miss`, `expired`, and `refreshed` are mutually exclusive and their sum
  equals the number of processed keywords. An expired entry is reported as
  `expired` only — it is not also counted as a `miss` — and `refreshed` is a
  deliberate bypass that is never a hit. The live progress line, the manifest
  rollup (`progress.cache` + `hitRatePercent`), and `keywords.json` all use
  this single definition. Expired entries are reported even after a reopen,
  because cleanup never deletes rows inside the grace window before they were
  observed;
- schema changes are safe: an existing database is copied to
  `cache.sqlite.pre-vN.bak` before the first migration, each migration is a
  single atomic transaction (a failure leaves the old version fully intact and
  raises `CACHE_DB_ERROR`), and a database from a newer schema version is
  refused instead of opened silently. The v3 migration invalidates legacy
  related rows (drops them in the same transaction) because their
  `ok`/`empty`/`error` status is unknowable from the v2 schema; pretending
  they were all `ok` would fabricate provenance, so they are simply refetched;
- every cache-store operation surfaces driver failures as `CACHE_DB_ERROR`
  (exit 3) with the original cause attached; nothing leaks as a raw SQLite
  error into exit code 1;
- if the cache DB cannot be opened, the CLI fails loudly with `CACHE_DB_ERROR`
  (exit 3) instead of silently running uncached.

**Safe cache reset.** A full reset means: stop the runner (Ctrl+C; the run is
checkpointed and resumable), then delete `data/cache/cache.sqlite` together
with its WAL sidecars `cache.sqlite-wal` and `cache.sqlite-shm` (the three
files form one database). The `cache.sqlite.pre-vN.bak` migration backups are
historical evidence of prior schema versions and must not be deleted without
an explicit decision — they are the only record of the cache content before a
schema migration.

A preflight runs before any keyword work and verifies: Research Chrome reachable, Google reachable, Keyword Surfer present, run directory writable. A CAPTCHA pauses the run and asks for manual intervention instead of retrying blindly.

## Primary outputs

Each execution creates an immutable historical run:

```text
runs/<run-id>/
├── manifest.json
├── keywords.csv
├── related-keywords.csv
├── serp.csv
├── domains.csv
├── candidates.csv
├── report.md
└── status.json
```

Parser-failure evidence is written outside the run directory, under `debug/<run-id>/` (the currently implemented contract; see the Implemented CLI section).

Persistent reusable cache lives outside run directories:

```text
data/
└── cache/
```

## Read next

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `PIPELINE.md`
4. `AGENTS.md`
5. `IMPLEMENTATION_PLAN.md`

---

## Proven spike details

## Status

```text
GO
```

The integration risk has been sufficiently reduced to proceed with the full runner.

## Observed result

Test query:

```text
compare lists
```

Observed automatically:

```text
Surfer volume: 49,500
Surfer CPC: 7.90
Organic candidates: 9
```

The values matched what was visibly rendered in the browser.

## Important implementation discovery

Keyword Surfer injected accessible elements into the Google document, including:

```text
surfer-main-keyword-widget
keyword-surfer-result
keyword-surfer-sidebar
```

The related-keyword sidebar also exposed keyword, overlap, and volume data.

This enables optional seed expansion in the production runner.

## Organic parsing

The parser produced nine valid organic candidates on the observed rendered page.

Keyword Surfer decorations alongside result cards were not mistaken for separate organic results.

## Geographic caveat

The request used:

```text
hl=en
gl=us
```

and Keyword Surfer was configured for the United States.

However, Google displayed a Russian physical location in the page footer.

Therefore:

- Surfer volume/CPC can be treated as the configured Surfer market;
- organic SERP localization must be recorded separately;
- the full runner must expose a geo mismatch warning.

## Recommendation

Proceed directly to the full production-ready local runner.

Do not spend another project phase re-proving the same single-query spike.
