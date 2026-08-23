# TASK-014 — Domain registration age and first-seen enrichment (implementation plan)

Status: **draft plan** (matches issue #24 acceptance: "Draft PR; do not merge. Closes this issue.")

Parent: TASK-010 (#20, v1.1 enrichment roadmap). Depends on: TASK-011 (#21), **merged as PR #27**.

> This is an **offline, network-light** enrichment module. It never opens Chrome. It
> adds two independently sourced facts to the existing v1 domain data:
>
> - **registration date** from standards-based RDAP (IANA bootstrap → registry RDAP);
> - **first-seen date** from an explicitly configured, documented source that
>   semantically means "first seen".
>
> The two facts are computed by separate providers and can never alias one another.

---

## 1. Entry condition (verified)

`#24` builds on the merged TASK-011 contract:

- `npm run enrich -- --run <run> --modules clusters` exists
  (`src/cli/enrich.ts`, `src/enrichment/engine.ts`).
- `KNOWN_ENRICHMENT_MODULES` already lists `'domain_age'` (reserved, not
  implemented) — see `src/enrichment/types.ts:4`.
- The store already persists the v1 domains (`run.sqlite` `domains` table with
  `registrable_domain`, `dr`, `first_seen_keyword`, `first_seen_position`) and the
  SERP rows carry `registrableDomain`.
- `registrableDomain()` exists and is pure — **reuse it unchanged**
  (`src/domains/normalize.ts`).
- `CacheStore` exposes `getDomain`/`putDomain` + `CacheTtlSettings`
  (`src/cache/store.ts`). **Mirror** this shape for a new
  `domain_age_cache` table rather than overloading the DR cache.
- `createAhrefsClient` + `backoffMs` (`src/ahrefs/client.ts`) are the template for an
  isolated, retry/backoff, `fetchImpl`-injectable adapter.
- `EnrichmentItemRecord` (`src/enrichment/types.ts:107`) already models
  per-item `status/source/cacheStatus/fetchedAt/requestCount/error/payload` and is
  exposed via `RunStore.upsertEnrichmentItem` / `loadEnrichmentItems`.

Nothing below changes scoring, candidate ranking, or the discovery run contract.

---

## 2. Scope (what is in / out)

**In** (this task):

- RDAP client + IANA bootstrap + per-host rate limit + Retry-After + bounded
  retry/backoff + timeout + request counters.
- RDAP registration-date parser: event selection rule, raw event candidates,
  privacy-redaction / missing-event handling.
- First-seen provider abstraction with one real default (Wayback CDX) and an
  honest `unavailable` status when unconfigured.
- Global `domain_age_cache` (cache.sqlite) with versioned TTLs and cache-status
  accounting; per-domain checkpoint items in `enrichment.sqlite` for within-run
  resume.
- Config block `rdap` + `firstSeen` + a new `domainAge` TTL group.
- Output: `domain-age.csv`, `domain-age.json`, SQLite state, and counts in the
  enrichment manifest/status.
- Fixtures + tests covering the full acceptance list (§8).

**Out** (explicit, per issue):

- No scoring changes, no candidate verdicts, no BUILD/WATCH/KILL.
- No LLM/AI, no proxy/anti-bot, no WHOIS port-43 fallback, no Ahrefs/Similarweb UI
  scraping.
- First-seen is **not** inferred from SERP presence and **never** copies
  `registrationDate`.

---

## 3. Data model

### 3.1 RDAP registration result

```ts
// src/rdap/types.ts
export type RdapRegistrationStatus =
  | 'ok'              // resolved a registrationDate
  | 'not_found'       // TLD has RDAP; domain 404
  | 'unsupported'     // TLD absent from IANA bootstrap (no RDAP server)
  | 'error';          // transient/network/parse/rate-limit failure

export type RdapEventCandidate = {
  eventAction: string;
  eventDate: string | null;   // raw, as returned; may be null
  source: 'event' | 'status'; // provenance of the candidate
};

export type RdapRegistrationResult = {
  domain: string;
  registrationDate: string | null;   // ISO date, or null (ambiguous / redacted)
  status: RdapRegistrationStatus;
  error: string | null;
  source: 'rdap';
  rule: string;                        // documented rule used to pick registrationDate
  events: RdapEventCandidate[];        // raw candidates retained for provenance
  isRedacted: boolean;                 // true when RDAP 9537 redaction signals present
  fetchedAt: string;
  requestCount: number;                // attempts for this domain within the call
  httpStatus: number | null;
};
```

**Selection rule (documented, fixed, stored verbatim in `rule`):**
> The earliest `eventDate` among `events` whose `eventAction` is exactly
> `"registration"` (or its aliases `add`/`create` when a registry reports no
> `registration` action). Ties broken by lexicographic order of `eventDate`.

If no `registration`-class event exists → `status: 'ok'`,
`registrationDate: null`, `isRedacted: false`, and `rule` records "no
registration event present". This keeps registration truthfully empty instead of
being filled from another fact.

### 3.2 First-seen result

```ts
// src/firstseen/types.ts
export type FirstSeenStatus =
  | 'ok'              // a real first-seen date was returned by the configured source
  | 'unavailable'     // source unconfigured / not applicable to this TLD / no coverage
  | 'error';          // transient/network/parse/rate-limit failure

export type FirstSeenResult = {
  domain: string;
  firstSeenDate: string | null;
  status: FirstSeenStatus;
  error: string | null;
  source: string;                 // 'wayback' | provider name | 'unconfigured'
  sourceReason: string | null;    // human-readable why unavailable
  fetchedAt: string;
  requestCount: number;
  httpStatus: number | null;
};
```

Contract enforced in code: when `firstSeenStatus !== 'ok'`,
`firstSeenDate === null` **always**. A regression test (§8.4) guards this.

### 3.3 Persisted per-domain record + cache entry

```ts
// src/rdap/types.ts  (re-exported for outputs)
export type DomainAgeRecord = {
  domain: string;
  registrationDate: string | null;
  registrationStatus: RdapRegistrationStatus;
  registrationSource: 'rdap';
  registrationRule: string;
  registrationEvents: RdapEventCandidate[];
  registrationIsRedacted: boolean;
  firstSeenDate: string | null;
  firstSeenStatus: FirstSeenStatus;
  firstSeenSource: string;
  firstSeenSourceReason: string | null;
  domainAgeDays: number | null;
  observedAt: string;   // fetchedAt of the registration lookup (the "as-of" date)
  fetchedAt: string;    // latest fetch timestamp across both providers
  cacheStatus: 'hit' | 'miss' | 'expired' | 'refreshed' | 'none';
  requestCount: number; // total requests for this domain this run
  error: string | null; // last non-nil error (registration or first-seen)
};

export type CachedDomainAgeEntry = {
  domain: string;
  registrationDate: string | null;
  registrationStatus: RdapRegistrationStatus;
  registrationRule: string;
  firstSeenDate: string | null;
  firstSeenStatus: FirstSeenStatus;
  registeredAt: string;   // storedAt
  expiresAt: string;
  ttlMs: number;          // effective TTL used (recorded per §issue)
  cacheVersion: number;   // invalidation on rule/parser change
};
```

`domainAgeDays` is derived: `(observedAt − registrationDate)` in whole days, `null`
when `registrationDate` is null. It is **never** derived from `firstSeenDate`.

### 3.4 Database

Two persistence touch points, following existing conventions:

**(a) Global long-lived cache — `cache.sqlite` (extend `src/cache/store.ts`).**

New migration `CACHE_SCHEMA_VERSION` 4 → 5:

```sql
CREATE TABLE domain_age_cache (
  domain TEXT PRIMARY KEY,
  registration_date TEXT,
  registration_status TEXT NOT NULL,
  registration_rule TEXT NOT NULL,
  first_seen_date TEXT,
  first_seen_status TEXT NOT NULL,
  first_seen_source TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ttl_ms INTEGER NOT NULL,
  cache_version INTEGER NOT NULL
);

CREATE INDEX idx_domain_age_expires ON domain_age_cache (expires_at);
```

Mirror `CacheStore.getDomain`/`putDomain`, add `getDomainAge`/`putDomainAge`.
TTL selection mirrors the existing `ttlMsForDomainStatus` switch:

```ts
// src/cache/store.ts
export function ttlMsForDomainAgeRegistration(status, ttl): number {
  // ok -> rdapOkMs (default 180d), not_found/unsupported -> rdapNotFoundMs (30d), error -> rdapErrorMs (1d)
}
export function ttlMsForDomainAgeFirstSeen(status, ttl): number {
  // ok -> firstSeenOkMs, unavailable -> firstSeenUnavailableMs, error -> firstSeenErrorMs
}
```

The persisted row's overall `ttl` is the **minimum** of the registration and
first-seen TTLs (the freshest fact expires first → forces a correct refresh).
`cacheVersion` lets a parser/rule change invalidate the cache deliberately.

**(b) Per-domain checkpoint — `enrichment.sqlite` (extend `src/db/store.ts`).**

Reuse the generic `enrichment_items` table (no schema change needed): for the
`domain_age` module, one row per `domain` with:

- `item_id = domain` (normalized registrable domain, lower-cased)
- `module = 'domain_age'`
- `status` ∈ pending/running/completed/error (enrichment item lifecycle)
- `source` = `'rdap'` (registration) with the first-seen fact folded into `payload`
- `payload = JSON.stringify(DomainAgeRecord)` (minus volatile cacheStatus; cache
  provenance is reconstructed from the cache row on load)
- `cacheStatus`, `fetchedAt`, `requestCount`, `error` populated as in the
  clusters module.

No new table; reuse avoids schema churn and keeps `loadEnrichmentItems`
resume logic identical.

---

## 4. Config (`src/config/config.ts`)

Add two blocks + extend the `cache.ttl` group. Environment variables keep the
existing `readPositiveInt`/`readPositiveNumber`/`readBoolean` helpers.

```ts
rdap: {
  endpoint: string;            // IANA bootstrap base (default 'https://data.iana.org/rdap/')
  dnsBootstrapFile: string;    // 'dns.json'
  queryTimeoutMs: number;
  perHostMinDelayMs: number;   // rate limit per RDAP host
  retryMaxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  cacheTtlDays: number;        // not the data TTL; TTL of the in-memory bootstrap file (~24h)
},
firstSeen: {
  provider: string | null;    // 'wayback' | 'securitytrails' | 'unconfigured'
  endpoint: string;           // provider base
  apiKey: string | null;      // from env, never persisted into configSnapshot
  timeoutMs: number;
  requireFirstSeen: boolean;   // if true, missing source is a hard error; default false
},
cache: {
  ttl: {
    // … existing …
    rdapOkMs, rdapNotFoundMs, rdapErrorMs,                 // registration TTLs
    firstSeenOkMs, firstSeenUnavailableMs, firstSeenErrorMs, // first-seen TTLs
  },
},
```

Default TTLs (suggested by the issue, made configurable):

| Fact / status        | Default TTL |
|----------------------|-------------|
| registration ok      | 180 d       |
| registration not_found / unsupported | 30 d |
| registration error (transient) | 1 d   |
| first_seen ok        | 180 d      |
| first_seen unavailable | 30 d       |
| first_seen error      | 1 d        |

**Secret safety (mirrors Ahrefs):** `firstSeen.apiKey` is read from env at call
time only; `configSnapshot` in the manifest records
`firstSeen: { provider, configured: boolean }` — never the key.

---

## 5. Error codes (`src/shared/errors.ts`)

Append to `ResearchErrorCode`:

```ts
| 'RDAP_RATE_LIMIT'
| 'RDAP_ERROR'
| 'RDAP_NOT_CONFIGURED'      // first-seen requested but unconfigured (hard only if requireFirstSeen)
| 'FIRST_SEEN_ERROR'
```

These feed the existing classification/retry machinery and produce the structured
`error` column on the checkpoint item + the `error` CSV/JSON field per §6.

---

## 6. Output contract

A `domain_age` module run publishes (in `enrichments/<id>/`):

1. `domain-age.csv` — one row per unique shortlisted domain:
   ```
   domain, registration_date, registration_status, registration_source,
   registration_rule, registration_is_redacted, first_seen_date,
   first_seen_status, first_seen_source, first_seen_source_reason,
   domain_age_days, observed_at, fetched_at, cache_status, request_count, error
   ```
2. `domain-age.json` — `{ enrichmentId, sourceRunId, generatedAt, config,
   summary, records: DomainAgeRecord[] }`.
3. SQLite state — `enrichment_items` rows (checkpoint) + global cache hits.
4. Manifest/status counts — the enrichment manifest is extended with a
   `moduleSummaries.domain_age` block:
   ```ts
   domainAgeSummary = {
     total: number;
     cache: number;      // cache hits
     fresh: number;      // network lookups performed
     ok: number;
     notFound: number;   // registration/unsupported/not_found rolled in
     unsupported: number;
     unavailable: number; // first-seen unavailable
     errors: number;
     meanRegistrationTtlMs: number;   // effective TTL recorded
   }
   ```

This satisfies the issue's "Status/report counts must distinguish total, cache,
fresh, ok, not_found, unsupported, unavailable, and errors."

CSV row/column conventions and formula-protection match the existing exports
(`src/exports/csv.ts`, `renderDomainsCsv`) — same quoting/atomic-write path
(`writeTextAtomic`).

---

## 7. Module wiring

### 7.1 Engine (`src/enrichment/engine.ts`)

Add a `domain_age` branch to `runEnrichment` mirroring `clusters`:

```ts
if (modules.includes('domain_age')) {
  if (existingItem?.status === 'completed') {
    logger('Skipping completed domain_age module');
    // rebuild DomainAgeRecord[] from checkpoint items + cache for outputs
  } else {
    result = await runDomainAgeModule(enrichmentId, sourceConn.store,
      sourceRunId, config.domainAge ?? defaultDomainAgeConfig(),
      enrichmentStore, cacheStore, shortlist, logger, signal);
  }
}
```

`runDomainAgeModule`:
1. Collect shortlisted domains: from the shortlist keywords' SERP rows'
   `registrableDomain` (deduped, non-empty). If no shortlist, fall back to **all**
   completed keywords' domains (the "shortlisted registrable domains" from the
   issue — here the shortlist is the v1.1 deep-enrichment selection).
2. For each domain (respecting `signal.cancelled`):
   - mark item `running` (`upsertEnrichmentItem`);
   - `cache.getDomainAge(domain)` → if valid & not expired → **cache** (fill
     `cacheStatus='hit'`, no network);
   - else: resolve registration via the RDAP client (per-host rate limit +
     backoff), then first-seen via the first-seen client (only if a provider is
     configured);
   - on success populate `domainAgeRecord`; on failure keep status `error` and
     a structured reason, **never** crashing the run;
   - `cache.putDomainAge(domain, entry, storedAt, ttl)`;
   - checkpoint item `completed` (or `error`) with the full record in `payload`.
3. Emit `domain-age.csv` + `domain-age.json` + manifest counts.

Rate limiting: a per-host token gate (`Map<host, nextAvailableMs>`) enforces
`perHostMinDelayMs`; 429/5xx honor `Retry-After` then fall back to backoff.
`requestCount` aggregates registration + first-seen attempts per domain.

### 7.2 CLI (`src/cli/enrich.ts`)

`--modules` already gates on `IMPLEMENTED_ENRICHMENT_MODULES`. This task **promotes
`domain_age` from reserved to implemented**:

```ts
// src/enrichment/types.ts
export const IMPLEMENTED_ENRICHMENT_MODULES = [
  'clusters', 'domain_age',
] as const;
```

`domain_age` needs the cache store. `enrich.ts` opens `CacheStore.open(cfg.cache.path)`
(read-write) alongside the existing stores and passes it into `runEnrichment`
(optional hook, defaulting to in-memory for tests). The cache TTLs come from
`config.cache.ttl.rdap*` / `firstSeen*`.

Shortlist already exists (`--shortlist`, validated against the source run). No new
flags are required to satisfy this issue; the domain set is derived from the
shortlist's SERPs. Document the implicit "domains come from shortlisted keywords'
registrableDomain" rule.

---

## 8. Acceptance (concrete, testable)

1. **RDAP event rule** — `src/rdap/parse.ts` unit tests over fixtures:
   - multiple `registration`/`add` events → earliest date chosen, `rule` recorded;
   - missing registration event → `registrationDate=null`, `status='ok'`, reason
     "no registration event";
   - 404 → `not_found`; TLD absent from bootstrap → `unsupported`;
   - 429 with `Retry-After` → backoff honors the header;
   - non-JSON / truncated → `error` with parse message;
   - a `notices`/redaction marker + empty `events` → `isRedacted=true`,
     `registrationDate=null`.
2. **Per-host rate limit** — two sequential queries to the same RDAP host respect
   `perHostMinDelayMs`; concurrent queries to different hosts do not block each
   other.
3. **No-alias regression** — a test loads a record where `registrationDate` is set
   but no first-seen provider is configured, and asserts
   `firstSeenDate === null`, `firstSeenStatus === 'unavailable'`,
   `domainAgeDays === days(registrationDate)` and **not** `days(firstSeenDate)`.
4. **Cache + resume** — warm run: `cache.getDomainAge` returns a non-expired entry
   → **zero** RDAP/first-seen fetches (assert request counters stay 0). Resume
   after interrupt: domains already `completed` in `enrichment_items` are skipped.
5. **First-seen unconfigured** — with `firstSeen.provider = null`, every domain
   gets `firstSeenDate=null`, `firstSeenStatus='unavailable'`,
   `firstSeenSource='unconfigured'`; registration still resolves; run exits 0.
6. **TTL recording** — the cache row stores the effective `ttl_ms` and
   `cache_version`; a config change to `cacheVersion` invalidates cleanly.
7. **Outputs** — `domain-age.csv` columns match §6 exactly; `domain-age.json`
   round-trips a `DomainAgeRecord`; manifest counts sum to `total`.
8. **Secret safety** — `configSnapshot` in the manifest contains no API key
   (mirrors `src/cli/research.secretLeak.test.ts`); `firstSeen.apiKey` is never
   written to any artifact.
9. **Live smoke** — against a space-free research profile (the issue is offline,
   but a single real RDAP lookup for one shortlisted domain proves the bootstrap →
   query → parse path; Wayback CDX proves first-seen). The smoke evidence names
   the source(s), counts (cache/fresh/ok/not_found/unsupported/unavailable/errors),
   effective TTLs, and states that paid first-seen providers are
   `BLOCKED_BY_PROVIDER` when unconfigured — identical to the v1 acceptance tone in
   `ACCEPTANCE.md`.
10. **No scoring drift** — `candidates.csv` / `serp.csv` / scoring outputs are byte-
    identical to a pre-`domain_age` baseline on the same source run.
11. **Typecheck + tests**: `npx tsc --noEmit` clean; `npm test` green; new
    fixture tests added to the count.

Fixtures live under `fixtures/rdap/` (`registration-events.json`,
`missing-event.json`, `privacy-redacted.json`, `tld-unsupported.json`,
`not-found.json`, `rate-limited.json`, `malformed.json`) — one file per
acceptance sub-case so the parse tests stay deterministic and offline.

---

## 9. Phased delivery (reviewable slices)

Per the repo's "focused PRs" rule, deliver as stacked, independently reviewable
units — each green on its own:

- **P1 — RDAP plumbing & parse.** `src/rdap/{types,bootstrap,client,parse}.ts` +
  `src/rdap/parse.test.ts` + fixtures. Pure; no CLI/storage coupling.
- **P2 — First-seen provider.** `src/firstseen/{types,wayback,client}.ts` (Wayback
  CDX default; provider-config abstraction). `src/firstseen/wayback.test.ts`.
- **P3 — Cache + config + errors.** `domain_age_cache` migration (cache.sqlite
  v5), `rdap`/`firstSeen`/TTL config, new `ResearchErrorCode`s,
  `.env.example` entries.
- **P4 — Engine module + outputs.** `runDomainAgeModule` in
  `src/enrichment/engine.ts`, `src/enrichment/outputs.ts` (`writeDomainAgeCsv`/
  `writeDomainAgeJson`), DB checkpoint via existing `enrichment_items`.
  `IMPLEMENTED_ENRICHMENT_MODULES` promotion.
- **P5 — CLI + tests + docs.** `src/cli/enrich.ts` cache-store wiring, full test
  suite, `README.md` enrichment section extension, live-smoke evidence in the PR
  body (no committed run dirs).

This keeps the diff scoped the same way PR #27 (TASK-011) was scoped.

---

## 10. Risks & decisions

1. **RDAP response shape varies by registry.** The parser targets the RFC 9083
   `events[].{eventAction,eventDate}` contract and falls back to `status` codes
   only when `events` is absent. Registry-specific aliases (`add`/`create`) are a
   documented, rule-versioned extension point — not a new provider framework.
2. **No free global first-seen API is guaranteed.** Wayback CDX is the concrete
   default (real, documented, unauthenticated). Any alternative is config-driven;
   if none is configured the run stays green with `unavailable` facts, never
   aliased.
3. **Cache TTL vs. fact freshness.** 180/30/1 day defaults follow the issue. The
   persisted `cache_version` makes a rule change invalidate without data loss.
4. **Per-host rate limiting** is keyed on the RDAP host derived from the
   bootstrapped base URL, so `.com` (Verisign) and `.org` (different host) never
   share a bucket even if queried back-to-back.
5. **No WHOIS fallback.** Deliberately out of scope; `unsupported` TLD status
   surfaces the gap honestly rather than silently substituting legacy WHOIS.
6. **Offline by design.** Like the clusters module, `domain_age` makes no browser
   call; all network is RDAP/CDX and is mock-tested — no live calls in CI.
