# First-party Search Traction

## Purpose

First-party search traction is observed Google Search Console evidence from sites we actually operate.

It is intentionally separate from competitor `traffic-evidence`:

- competitor traffic evidence is domain/URL evidence around entrant cohorts;
- first-party Search Console evidence describes queries, landing pages, countries, devices, dates, clicks, impressions, CTR, and average position observed for our own property.

Do not map one into the other merely because both are called “traffic”.

## Current import

Export the Search Console **Performance on Search results** report as a ZIP, then import it explicitly:

```bash
npm run search-traction:import -- \
  --input ./example.com-Performance-on-Search-2026-09-06.zip \
  --property sc-domain:example.com
```

JSON operator output:

```bash
npm run search-traction:import -- \
  --input ./gsc-export.zip \
  --property sc-domain:example.com \
  --json
```

Optional durable output-root override:

```bash
npm run search-traction:import -- \
  --input ./gsc-export.zip \
  --property sc-domain:example.com \
  --output-root /absolute/research/output
```

`--property` is mandatory. Property identity is never inferred from the ZIP filename.

## Supported Google UI export contract

The current parser version supports the English Search Console UI export observed in real project exports:

```text
Chart.csv
Queries.csv
Pages.csv
Countries.csv
Devices.csv
Search appearance.csv
Filters.csv
```

The parser fails closed if a required file or required column is missing. This is deliberate: a localized or materially changed Search Console export must not be silently interpreted using the wrong column semantics.

The ZIP reader is bounded and supports the deflated UTF-8/data-descriptor form used by the observed Google exports. Nested/encrypted/unsupported archive entries and unsafe paths fail closed.

No Google API or account connection is required for this V1 import.

## Evidence semantics

The files in a Search Console export are **separate aggregates**.

For example:

```text
Queries.csv   = metrics grouped by query
Pages.csv     = metrics grouped by landing page
Countries.csv = metrics grouped by country
Devices.csv   = metrics grouped by device
```

They are not row-aligned dimensions of one fact table. The importer therefore never fabricates rows such as:

```text
query × page × country × device
```

unless a future source explicitly supplies that joint observation.

The importer stores every aggregate dimension separately.

### Filter period vs observed chart range

`Filters.csv` preserves the operator-facing Search Console filter descriptor, for example:

```text
Search type = Web
Date = Last 3 months
```

This is distinct from the actual date rows present in `Chart.csv`.

A newly launched site can have `Date = Last 3 months` while its chart contains only a few days of observed rows. The snapshot therefore stores both:

- the original ordered filter rows;
- `observed_start_date` / `observed_end_date` derived only from the chart rows actually present.

The importer does not pretend these are the same thing.

### Source text and numeric representation

Query/page/country/device/search-appearance labels are preserved as supplied by the CSV source rather than silently trimmed or normalized. The exact source ZIP is retained as the audit artifact.

Clicks and impressions are persisted as non-negative integers. Source CTR percent values are normalized to a ratio (`0.49%` → `0.0049`); blank CTR/position cells remain `null`. Average position is preserved as the source numeric observation and is not recomputed from clicks/impressions.

### Missing/hidden query coverage

Search Console query rows can cover less than the chart/page totals. The importer does not invent hidden queries or turn that difference into zero evidence.

At import time the operator result reports aggregate click/impression coverage for every dimension relative to the chart totals. The normalized SQLite rows retain all inputs needed to recompute that projection. A query impression coverage below `1.0` is explicit incomplete coverage, not an error and not a negative signal.

### Empty Search Appearance

A header-only `Search appearance.csv` is a valid empty aggregate and is persisted as zero rows. It is not interpreted as “search appearance = none” for every impression.

## Durable storage

First-party evidence is stored independently under the Runner output root:

```text
<RESEARCH_OUTPUT_ROOT>/
└── first-party-search/
    ├── search-traction.sqlite
    └── sources/
        ├── gsc_<fingerprint>.zip
        └── ...
```

`search-traction.sqlite` is durable normalized truth. The exact source ZIP is retained for auditability and can be restored by an idempotent re-import if the derived source-archive copy is missing.

Schema V1 stores:

```text
snapshots
  property
  source kind/parser version/hash
  source archive path
  import timestamp
  observed chart range
  chart click/impression totals

daily_metrics
  ordered date + Search Console metrics

dimension_metrics
  dimension + ordered value + Search Console metrics
snapshot_filters
  ordered original filter/value rows
```

The source rows, not duplicated JSON summaries, are the durable detail truth.

Snapshot identity is deterministic over:

```text
explicit property + source ZIP SHA-256 + parser semantics version
```

Importing the exact same export for the same property under the same parser semantics is idempotent. The same bytes explicitly assigned to another property remain a different snapshot. A future parser semantics version can materialize a new immutable normalization of the same source bytes without rewriting the historical snapshot.

## Current non-goals

V1 does **not** add:

- a live Search Console API connector;
- OAuth/authentication;
- automatic research or Library attachment;
- automatic keyword/cluster matching;
- cross-dimensional joins that the source does not support;
- autonomous opportunity scoring;
- automatic changes to expansion policy;
- replacement of competitor traffic evidence.

Linking first-party observations back to a Runner research is a later step and must be explicit/auditable. The import contract should prove useful first.
