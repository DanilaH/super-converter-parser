# Cohort History Acceptance — V2.1 PR-07

## Status

Implementation contract for V2.1 PR-07 (`cohort/history projection`).

This PR integrates the existing `domain_age` RDAP + first-seen evidence into the persisted PR-06 entrant cohort. It does not rebuild either provider, add Common Crawl, estimate traffic, or produce a finalist score/decision.

## Scope

PR-07 projects history evidence over each **current finalist entrant cohort**:

```text
persisted entrant cohort
+ persisted domain_age checkpoints
+ deterministic domain-cap omissions
+ explicit versioned interpretation policy
→ coverage-aware cohort history projection
```

SQLite remains the source of truth. `domain-age.json` is not used to resume or reconstruct history state.

## Parent contract

A cohort-history snapshot requires a current persisted entrant-cohort snapshot.

The child snapshot pins:

- enrichment id;
- source run id;
- entrant representative revision;
- SHA-256 fingerprint of the exact entrant snapshot;
- projection version;
- explicit interpretation policy;
- complete per-finalist history projection.

Persistence rejects a child whose source run, representative revision, cluster set, domain set, or entrant fingerprint differs from its current parent.

## Source-generation freshness

PR-07 may reconstruct domain-cap omissions from the persisted discovery inputs. Therefore it must use the same discovery generation as the entrant snapshot.

Required invariant:

```text
current source_run.updatedAt == entrant snapshot sourceRunUpdatedAt
```

If discovery was repaired or otherwise mutated after entrant construction, PR-07 fails loudly. The operator must rebuild the upstream evidence chain instead of combining old entrant evidence with new source SERPs.

## Existing provider facts are preserved

PR-07 consumes the existing `DomainAgeRecord` contract. It does not invent a unified provider verdict.

Registration and first-seen state remain independent, including their provider-native statuses, dates, provenance, request/error metadata and cache/checkpoint behavior.

Persisted checkpoint payloads are validated before use. Corrupt identity, unknown statuses, malformed dates, or internally impossible `ok` records fail loudly rather than becoming unknown/false evidence.

In particular:

```text
registrationStatus = ok
→ registrationDate and domainAgeDays must both exist

firstSeenStatus = ok
→ firstSeenDate must exist
```

## Coverage state

Every entrant domain is classified into exactly one top-level history coverage state:

```text
checked
omitted
unobserved
```

### checked

A durable `domain_age` checkpoint exists for the domain.

The provider may still have returned `not_found`, `unsupported`, `unavailable`, or `error`. `checked` means the domain entered the history subsystem and has durable provider state; it does not mean both dates are known.

### omitted

The domain was intentionally outside the `domain_age` collection cap.

PR-07 does not synthesize a fake provider record for this state. `domain_cap` is a separate provenance channel and provider statuses remain `not_attempted`.

### unobserved

The entrant domain has neither a durable checkpoint nor a proven cap omission.

Unobserved is not converted into `not_found`, `old`, `not recent`, or `no conflict`.

## Domain-cap omission reconstruction

Historical `domain_age` cap omissions are not durable per-domain checkpoints in the current enrichment store.

PR-07 reconstructs them deterministically from durable inputs only:

```text
persisted enrichment shortlist
+ persisted source keywords
+ persisted organic SERP rows
+ existing selectDomainsFairly(..., 30) contract
→ omitted domain set
```

The cap constant is versioned for this reconstruction path.

No shortlist means no omission claim.

## Explicit interpretation policy

The roadmap requires `young`, recent web presence, and possible history conflict, but does not define universal day thresholds.

PR-07 therefore has **no hidden age defaults**.

The first cohort-history run requires all three explicit values:

```text
--young-domain-max-age-days <days>
--recent-web-presence-max-age-days <days>
--repurpose-gap-min-days <days>
```

The complete policy is persisted and versioned. Later reruns may omit flags to reuse it. Supplying one or more flags updates only those fields while retaining the other persisted values.

Policy thresholds must be non-negative integers.

Changing policy changes the deterministic history snapshot; it is not treated as a provider-data mutation.

## Young-domain evidence

`young` is derived only when registration age is known:

```text
isYoung = domainAgeDays <= youngDomainMaxAgeDays
```

If registration evidence is unavailable, omitted, errored or otherwise lacks a known age, `isYoung = null`.

Cluster summary:

```text
youngDomainCount
registrationKnownDomainCount
```

The denominator for a young-domain rate is **registrationKnownDomainCount**, not total cohort size.

## Recent web-presence evidence

`recent web presence` is derived only when first-seen date is known.

Age is measured relative to the persisted domain-age observation timestamp:

```text
firstSeenAgeDays = observedAt - firstSeenDate
isRecentWebPresence = firstSeenAgeDays <= recentWebPresenceMaxAgeDays
```

If first-seen evidence is unavailable, omitted, errored or unknown, `isRecentWebPresence = null`.

Cluster summary:

```text
recentWebPresenceCount
firstSeenKnownDomainCount
```

The denominator is **firstSeenKnownDomainCount**.

## Registration / first-seen history conflict

A possible history conflict is evaluated only when both registration and first-seen dates are known.

PR-07 distinguishes two descriptive cases:

### impossible chronology

```text
firstSeenDate < registrationDate
→ first_seen_before_registration
```

### long registration-to-first-seen gap

```text
firstSeenDate - registrationDate >= repurposeGapMinDays
→ registration_long_before_first_seen
```

Otherwise the comparable domain has no observed conflict under the selected policy.

Unknown dates do not become `false`; their conflict state remains `null`.

Cluster summary:

```text
possibleHistoryConflictCount
comparableHistoryDomainCount
```

The denominator is **comparableHistoryDomainCount**.

These are descriptive flags for human review. They do not prove domain repurposing.

## Transparent denominators

Every cluster summary exposes:

```text
cohortDomainCount
checkedDomainCount
omittedDomainCount
unobservedDomainCount
registrationKnownDomainCount
youngDomainCount
firstSeenKnownDomainCount
recentWebPresenceCount
comparableHistoryDomainCount
possibleHistoryConflictCount
```

Required accounting:

```text
checked + omitted + unobserved = cohortDomainCount
```

Provider-derived rates use their own known-evidence denominator. They never silently use total cohort size.

The regression suite explicitly locks the roadmap-style partial-coverage case:

```text
47 cohort domains
30 checked
10 cap-omitted
7 unobserved
```

A missing provider observation must not be interpreted as a negative observation.

## Persistence

PR-07 uses a feature-owned extension schema in the existing `enrichment.sqlite`; core `RunStore` schema version is unchanged.

Durable state contains two concepts:

### persisted policy

The selected versioned threshold policy survives downstream snapshot invalidation so the same interpretation can be rebuilt without recovering flags manually.

### current projection snapshot

The current deterministic child snapshot is tied to the exact entrant fingerprint and current provider checkpoints.

An identical rerun preserves the same semantic snapshot and reports `changed=false`.

## Downstream invalidation

Cohort-history evidence becomes stale if either its entrant parent or its durable `domain_age` evidence changes.

### SQLite truth

Feature-owned SQLite triggers remove the current history snapshot when:

- the entrant snapshot changes;
- the entrant snapshot is deleted;
- a `domain_age` checkpoint is inserted or deleted;
- a `domain_age` checkpoint changes semantically (`module`, `status`, or `payload`).

A technical replay that rewrites the same domain-age `status/payload` does not invalidate the history snapshot merely because timestamps were refreshed.

The persisted interpretation policy is retained.

### Published entrant/representative invalidation

When entrant publication changes, stale cohort-history metadata and artifact names are removed and reserved history files are deleted.

When representative publication invalidates entrant evidence, the invalidation cascades through history as well:

```text
representative change
→ entrant invalid
→ cohort history invalid
```

An unchanged parent publication preserves downstream artifacts.

### Archive fail-closed rule

`results.zip` is built from the research directory, so a stale physical file could otherwise survive after a provider checkpoint mutation.

Reserved `cohort-history.*` files are archive-eligible only when the owning enrichment `manifest.json` explicitly advertises them. Unadvertised reserved history files are excluded fail-closed.

A physical stale file is therefore not treated as published evidence.

## Publication gate

Before PR-07 mutates manifest/status it verifies:

- enrichment/source identity;
- completed publication state;
- entrant metadata is present;
- representative revision matches the persisted entrant parent;
- public `entrant-cohort.json` describes the same entrant snapshot as SQLite.

A partially published or stale parent therefore blocks cohort-history publication.

## Published artifacts

PR-07 publishes:

```text
cohort-history.csv
cohort-history-summary.csv
cohort-history.json
```

### `cohort-history.csv`

Per-domain evidence including:

- coverage state and omission reason;
- registration status/date/age and `is_young`;
- first-seen status/date/age and `is_recent_web_presence`;
- conflict state/reason/gap;
- interpretation-relevant provider status/error fields, first-seen source/reason, registration redaction, and the observation timestamp.

Full request counts, HTTP statuses, cache metadata and per-source fetched-at provenance remain in the durable source `domain_age` checkpoints/artifacts and are intentionally not duplicated by this projection.

### `cohort-history-summary.csv`

Per-finalist cluster counts with explicit denominators for:

- checked history coverage;
- known registration / young evidence;
- known first-seen / recent evidence;
- comparable / possible-conflict evidence.

### `cohort-history.json`

Complete versioned snapshot including parent fingerprint, policy, domain evidence and summaries.

All three artifacts are advertised in enrichment `manifest.json` / `status.json` and included in `results.zip` only while publication remains current.

## CLI

```text
npm run cohort-history -- --enrichment <id> \
  --young-domain-max-age-days <days> \
  --recent-web-presence-max-age-days <days> \
  --repurpose-gap-min-days <days>
```

First run requires all three thresholds. A subsequent run may omit them to reuse the persisted policy.

The CLI requires:

- completed enrichment;
- persisted entrant snapshot;
- completed matching source generation;
- valid durable history checkpoints.

## Explicit non-goals

PR-07 does **not**:

- change RDAP collection behavior;
- change first-seen/Wayback collection behavior;
- add Common Crawl;
- add Certificate Transparency;
- estimate competitor traffic;
- infer history facts for unobserved domains;
- treat `not_found`, `unsupported`, `unavailable`, `error`, omission, or missing as the same state;
- infer domain repurposing as a fact;
- create a universal age threshold;
- calculate launch-success probability;
- add a composite opportunity score;
- decide BUILD / WATCH / KILL;
- change PR-04 clustering, PR-05 representative selection, or PR-06 entrant membership semantics.
