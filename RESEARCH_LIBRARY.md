# Research Library

## Purpose

The research library is a local cumulative index of completed Utility Research Runner work.

Each research keeps its existing human-readable directory and `results.zip`. Publishing adds an immutable snapshot to a shared library under the same `RESEARCH_OUTPUT_ROOT`:

```text
<RESEARCH_OUTPUT_ROOT>/
├── 2026-08-30-favicon/
│   └── results.zip
├── 2026-09-02-pdf-tools/
│   └── results.zip
└── research-library/
    ├── library.sqlite
    ├── library.json
    ├── library.zip
    └── researches/
        ├── pub_<fingerprint>.zip
        └── ...
```

`library.sqlite` is the durable queryable truth. `library.json` and `library.zip` are derived snapshots.

## Publish command

```bash
npm run library:publish -- --enrichment <completed-enrichment-id>
```

Optional output-root override:

```bash
npm run library:publish -- --enrichment <id> --output-root <absolute-path>
```

Publication is explicit. A research is not automatically merged into the library merely because discovery/enrichment completed. This prevents temporary, experimental, synthetic, or operator-unreviewed results from silently becoming portfolio history.

## Publication identity and history

A publication fingerprint is SHA-256 over the current public discovery artifacts plus the artifacts advertised by the current enrichment manifest.

SQLite/WAL implementation bytes are not part of semantic publication identity. The portable source `results.zip` is still copied into the library so the complete source snapshot remains recoverable.

Consequences:

- publishing the same public snapshot twice is idempotent;
- changing traffic evidence, human decisions, clustering outputs, or another published artifact creates a new immutable publication;
- when a new snapshot comes from the same enrichment id, it records `supersedes_publication_id` pointing to the previous library snapshot;
- old versions are retained rather than overwritten.

## Publication truth

The library consumes the existing publication contract rather than inventing a second truth layer.

For enrichment artifacts, the enrichment manifest is authoritative. A physical file that is not advertised by the current manifest is not normalized into the library. This is especially important for parent-dependent artifacts such as cohort history, traffic evidence, and finalist evidence.

The shared archive stores the source research `results.zip`; that archive already applies the research-level manifest-gating rules.

Missing evidence remains missing. The library does not turn absent traffic, first-seen, history, or human decisions into zero/negative evidence.

## SQLite index

Schema v1 keeps historical rows scoped by `publication_id`.

Main tables:

```text
publications
publication_artifacts
publication_keywords
publication_clusters
publication_entrant_domains
```

The normalized index is intentionally small and query-oriented:

- publications: source/enrichment ids, timestamps, counts, summary, version linkage;
- keywords: normalized text, volume/CPC, status, current cluster;
- clusters: members, representatives, finalist decision/role, audit flags;
- entrant domains: rank/repetition/DR plus projected registration/first-seen history where available;
- artifacts: published source file hashes and sizes.

Raw per-keyword, cluster, finalist and entrant-domain JSON is retained alongside normalized columns for auditability and future library-schema evolution.

## Shared archive

`library.zip` contains:

```text
library.sqlite
library.json
researches/pub_<fingerprint>.zip
researches/pub_<fingerprint>.zip
...
```

Each nested research archive is also stored independently under `research-library/researches/`. The master ZIP is therefore a portable snapshot/backup, not the database itself.

Rebuilding `library.zip` is intentionally O(number of published researches) in the MVP. If the library becomes large enough for this to matter, archive compaction/incremental backup can be added based on measured cost rather than pre-optimizing the first version.

## Traffic and human decisions

Competitor traffic remains optional deep-validation evidence. The library does not require a paid traffic provider and does not block publication when traffic evidence is absent.

Synthetic traffic may be used to test importer mechanics, but it must be labeled as synthetic/test provenance and must not be interpreted as real SEO evidence.

Human `build | watch | reject | unknown` decisions remain separate from automated evidence. If recorded, the current decision and SEO/product role are indexed. If not recorded, the library preserves that absence.

## First-seen / Wayback

Wayback first-seen remains optional, environment-dependent evidence. An unavailable provider produces missing/unavailable first-seen evidence while RDAP/history can continue. The library indexes whatever current published history actually contains; it does not retry providers itself.

## Non-goals for MVP

The research library does not add:

- a dashboard or web server;
- embeddings/vector search;
- AI/LLM scoring;
- automatic BUILD/WATCH/REJECT decisions;
- a paid SEO API dependency;
- automatic publication at the end of every run;
- destructive deduplication across different historical research snapshots;
- a giant merged replacement for the per-research SQLite databases.

Those are separate product decisions and should require evidence that the small cumulative library is insufficient.
