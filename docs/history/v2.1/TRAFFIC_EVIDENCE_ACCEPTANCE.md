# Competitor Traffic Evidence Acceptance — V2.1 PR-08

## Status

Implementation contract for V2.1 PR-08 (`competitor traffic evidence`).

PR-08 adds a provider-neutral manual/import layer over the persisted finalist entrant cohort. It does not call a paid traffic provider at runtime and does not introduce a finalist score or launch-success probability.

## Scope

```text
manual/provider export CSV
        ↓
strict provider-neutral parser
        ↓
explicit finalist target validation
        ↓
append-only imported traffic snapshots
        ↓
current target revalidation
        ↓
compatible snapshot histories
        ↓
transparent velocity deltas + warnings
```

SQLite is the durable source of truth for imported facts and the selected low-base policy. CSV/JSON files are publication artifacts.

## Canonical import format

PR-08 accepts one stable CSV contract rather than guessing provider-specific export schemas.

Required columns:

```text
target_cluster_id
scope
entity
observed_at
provider_data_date
market
source
organic_traffic
traffic_value
traffic_value_currency
provenance
```

Headers are case/whitespace normalized. Duplicate normalized headers are rejected before CSV rows are projected into objects.

The CSV parser does not decide SEO intent. It only parses the provider-neutral data shape; finalist/domain/page validation belongs to the traffic evidence projector.

At least one of `organic_traffic` or `traffic_value` must be present for a valid imported row.

`traffic_value` requires a three-letter currency code. A currency without traffic value is invalid.

## Entity scope

Every row explicitly declares:

```text
scope = domain | url
```

The scopes are different evidence types and never alias one another.

### Domain

A domain-scoped entity must be the exact normalized registrable domain.

A subdomain or URL cannot be silently broadened into domain evidence.

### URL

A URL-scoped entity is normalized with the existing clustering URL identity contract.

URL evidence remains page-level evidence. It is never populated from a domain-level traffic value.

Required invariant:

```text
domain traffic != page traffic
```

## Explicit finalist ownership

Every imported row includes `target_cluster_id`.

A new import referencing an unknown finalist cluster is invalid input. The operator must identify the intended current finalist explicitly rather than relying on fuzzy matching.

For a known cluster, entity validation produces an auditable status.

### matched

Domain scope:

```text
normalized registrable domain exists in the target entrant cohort
```

URL scope:

```text
normalized URL identity exists among target-cluster ranking occurrences
```

### mismatch

A syntactically valid row can be retained even when its entity does not currently match the declared cluster.

Reasons are explicit:

```text
domain_not_in_target
url_domain_not_in_target
ranking_url_not_in_target
```

Mismatched snapshots remain visible in evidence artifacts but are excluded from compatible history and velocity calculations.

This preserves operator mistakes, old exports, and intent disagreements for audit instead of silently deleting them or treating them as negative traffic evidence.

## Import-time vs current validation

Target validation is a projection over the entrant cohort, not an immutable property of the traffic measurement.

Each imported snapshot preserves:

- the validation result at import time;
- the SHA-256 fingerprint of the entrant snapshot used at import time.

On later reruns, traffic evidence is revalidated against the current entrant cohort.

A previously mismatched entity may become matched if current finalist intent changes. A previously matched URL may become mismatched if that page is no longer part of the current entrant evidence.

If the referenced finalist cluster no longer exists, the raw import is not deleted. It moves to the separate lifecycle state:

```text
stale_target: target_cluster_not_current
```

Stale-target snapshots do not participate in velocity.

## Append-only persistence

Imported traffic measurements are historical facts and survive changes to representative or entrant projections.

PR-08 uses a feature-owned schema in the existing `enrichment.sqlite`; the core `RunStore` schema version is unchanged.

Persistence stores:

- stable snapshot id;
- entrant fingerprint at import time;
- target cluster;
- entity scope;
- normalized entity;
- provider data date;
- observation timestamp;
- market;
- source;
- complete normalized snapshot payload;
- import timestamp.

Raw imports are append-only. Upstream finalist changes invalidate publication/derived interpretation, not the historical imported rows.

## Idempotent snapshot identity

A snapshot id is SHA-256 over the normalized factual identity:

```text
version
target cluster
scope
normalized entity
observed_at
provider_data_date
market
source
organic traffic
traffic value
currency
provenance
```

Raw URL spelling and removable tracking parameters are not independent traffic facts when they normalize to the same page identity and the factual evidence is otherwise identical.

Reimporting an identical fact is a duplicate, not a new row.

A corrected measurement with a different observation timestamp, metric, provider date or provenance remains a separate append-only record.

## Time semantics

`observed_at` is the timestamp when the evidence was captured/import-observed and is normalized to canonical ISO time.

`provider_data_date` is a strict calendar date:

```text
YYYY-MM-DD
```

It is not an arbitrary timestamp.

Provider data cannot be dated after the evidence observation.

## Compatible history key

Velocity is calculated only inside a compatible history:

```text
target_cluster_id
+ scope
+ normalized_entity
+ market
+ source
```

Changing market or source starts a different history. Domain and URL scopes always form different histories.

Only currently target-matched snapshots enter histories.

## Same-date revisions

Multiple imports may describe the same provider data date.

All raw revisions are retained.

For velocity, the revision with the latest `observed_at` is effective.

If two latest revisions have the same provider data date and the same observation timestamp:

- identical measured values are not ambiguous even if provenance text differs;
- conflicting organic traffic / traffic value / currency is ambiguous and the projection fails loudly.

No lexicographic provenance tie-break is allowed to choose a measurement secretly.

## Velocity

Adjacent effective snapshots produce transparent deltas:

```text
previous
current
absolute_delta
percent_delta
elapsed_days
```

`percent_delta` is a percentage value, not a ratio.

Example:

```text
50 → 100
absolute delta = 50
percent delta = 100
```

A zero previous value has no finite percentage baseline:

```text
0 → 10
absolute delta = 10
percent delta = null
```

No infinite or fabricated percentage is emitted.

## Low-base warning

PR-08 does not invent a universal traffic baseline.

The first run requires:

```text
--low-base-organic-traffic-threshold <value>
```

The value is persisted as versioned policy and may be reused on later reruns when the flag is omitted.

For an organic-traffic delta:

```text
previous organic traffic <= configured threshold
→ low_base_organic_traffic warning
```

The warning does not invalidate the absolute measurement. It tells downstream reviewers that percentage velocity is sensitive to a small starting base.

## Traffic value and currency

Traffic value is optional and independent from organic traffic.

A value observation requires an explicit currency.

A traffic-value delta is calculated only when both adjacent values exist and currencies match.

If currencies differ:

```text
traffic value delta = unavailable
warning = traffic_value_currency_mismatch
```

An organic-traffic delta may still be valid for the same interval.

## Persistence validation

Callers cannot fabricate `targetValidation` and write it directly.

Before append, PR-08 re-normalizes every incoming snapshot against the current entrant cohort and requires the supplied snapshot to match that canonical result.

Mixed batches are prevalidated before SQLite writes. If one row is fabricated or invalid, no row from that batch is appended.

Persisted duplicate rows are structurally validated before being accepted as safe duplicates.

Corrupt hashes, metadata, canonical dates, normalized identities, currency state or target-validation shapes fail loudly as DB errors.

## CLI mutation order

The CLI deliberately validates the combined history and public parent before mutating traffic state:

```text
load existing imports
+ parse/normalize incoming CSV
→ dedupe by snapshot id
→ revalidate current targets
→ build compatible histories / detect ambiguous revisions
→ determine whether traffic evidence semantically changes
→ preflight public entrant parent / fingerprint
→ invalidate published finalist matrix when traffic changes
→ append incoming facts
→ persist policy
→ rebuild current projection from SQLite
→ write traffic artifacts
→ publish traffic metadata
→ rebuild results.zip
```

This prevents an ambiguous new revision from being appended and permanently making the append-only history unprojectable. It also closes the downstream crash window: when a valid traffic change is about to mutate SQLite, any previously published finalist matrix is invalidated first, so a process failure after the traffic mutation cannot leave stale finalist evidence advertised as current.

The public-parent preflight also happens before traffic mutation. Stale published entrant metadata therefore cannot cause new traffic facts/policy or traffic artifacts to be attached to an old public finalist generation.

If a later traffic persistence/publication write fails after a valid append, imported raw facts remain durable. A rerun can reuse those facts; valid evidence is not deleted merely to simulate transactionality across SQLite and filesystem publication. Because finalist publication was already invalidated before the mutation, downstream interpretation remains fail-closed until rebuilt.

## Publication

PR-08 publishes:

```text
traffic-evidence.csv
traffic-velocity.csv
traffic-evidence.json
```

### traffic-evidence.csv

Contains every imported snapshot and exposes both import-time and current target state, including:

- snapshot id;
- target cluster;
- domain/url scope;
- raw and normalized entity;
- provider data date / observed timestamp;
- source / market;
- traffic metrics and currency;
- provenance;
- import validation status/reason;
- current validation status/reason;
- import entrant fingerprint;
- current entrant fingerprint;
- imported timestamp.

### traffic-velocity.csv

Contains only compatible current target-matched history intervals and retains explicit:

- cluster;
- entity scope;
- normalized entity;
- market/source;
- date interval and elapsed days;
- absolute and percentage traffic deltas;
- traffic-value currency;
- low-base/currency warnings.

### traffic-evidence.json

Contains the complete imported facts plus the current revalidated projection.

## Public parent gate

Traffic publication is allowed only when the public `entrant-cohort.json` fingerprint matches the current SQLite entrant parent.

Manifest/status entrant revision must agree with that public artifact.

A stale or partially published entrant parent blocks traffic publication instead of attaching current traffic interpretation to an old public finalist set.

## Downstream publication invalidation

Raw SQLite traffic facts are append-only, but published traffic interpretation is parent-dependent.

When entrant publication changes:

```text
trafficEvidence metadata removed
traffic artifact names removed
traffic files deleted
raw SQLite traffic imports retained
```

When traffic facts or the persisted traffic policy change and a finalist matrix is already published:

```text
finalistEvidence metadata removed before traffic SQLite mutation
finalist artifact names removed before traffic SQLite mutation
finalist files deleted before traffic SQLite mutation
raw traffic facts remain append-only
```

Representative publication invalidation cascades transitively through entrant → history + traffic publication.

An unchanged entrant/traffic rerun preserves valid downstream publication.

## Archive fail-closed rule

Traffic artifact filenames are manifest-gated in `results.zip`.

A physical stale traffic file is excluded unless the local enrichment manifest explicitly advertises it.

This protects the archive when SQLite state changes or publication is invalidated independently from a previously written file.

## Explicit non-goals

PR-08 does not:

- call SEMrush, Ahrefs traffic, Similarweb or another paid traffic API at runtime;
- guess arbitrary vendor CSV schemas;
- infer page traffic from domain traffic;
- infer domain traffic from page traffic;
- combine markets into one velocity series;
- combine providers into one velocity series;
- convert target mismatch into zero traffic;
- delete imported evidence when finalist intent changes;
- define a universal low-traffic threshold;
- introduce a composite finalist score;
- estimate launch-success probability;
- make BUILD / WATCH / KILL decisions.
