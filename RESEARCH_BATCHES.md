# Research batches

## Purpose

One SEO topic can be researched in several seed-list passes without creating a new top-level research folder for every pass.

The initial discovery run remains immutable. Each append creates a new **combined discovery snapshot** inside the same research directory when the batch adds a previously unseen normalized keyword **or explicitly promotes a keyword that previously existed only as a `surfer_related` expansion child into a root seed**.

```text
<RESEARCH_OUTPUT_ROOT>/
└── 2026-08-30-favicon/
    ├── research.json
    ├── batches/
    │   ├── batch-0002.csv
    │   └── batch-0003.csv
    ├── discovery/          # original immutable run
    ├── discovery-02/       # combined snapshot after batch 2
    ├── discovery-03/       # combined snapshot after batch 3
    ├── enrichment/         # historical enrichment for an older discovery snapshot
    ├── enrichment-02/      # enrichment for a newer current snapshot
    └── results.zip
```

`research.json` is the small research-container manifest. Its stable `researchId` is the initial run id. `currentRunId` points at the latest combined discovery snapshot.

Existing pre-batch research folders are adopted automatically on their first append; no migration command is required.

## Command

```bash
npm run research:append -- --to <research-id-or-run-id> --seeds <path>
```

`--to` may be the initial stable research id or any discovery run id that belongs to the same research folder. When `research.json` already exists, the command always forks from its `currentRunId`, not from an older historical run passed accidentally.

Example:

```powershell
npm run research:append -- --to 20260829185815112_ef0d3bf0-691c-46df-bd8d-815877596975 --seeds .\favicon-extra.csv
```

## Mechanics

For every append:

1. The seed CSV is normalized and de-duplicated using the existing keyword normalization rules.
2. The input file is copied into `batches/` so the research remains self-contained.
3. The batch is recorded append-only in `research.json`, including all unique normalized inputs and which ones were genuinely new. Expansion-child promotions remain counted as already-known/duplicate inputs because the normalized keyword already existed.
4. If every input keyword is already present as an explicit root, no new discovery run is created.
5. If the batch contains a genuinely new keyword or explicitly promotes an expansion-only keyword to a root seed, a new `discovery-NN/run.sqlite` is created.
6. Existing keyword checkpoints/evidence are copied forward without recollection, except promoted roots are deliberately reopened as `pending` and do not carry their old child SERP/domain checkpoint into the new generation.
7. An expansion-only keyword explicitly supplied as a later seed becomes a generation-local `seed` root. Its previous immutable discovery generation still preserves the historical `surfer_related` provenance, while parent→child raw Related evidence remains independently auditable in `related_keywords`.
8. On V1 global-admission forks, raw Related evidence is copied but prior-generation `selectedForExpansion` flags are reset. The new generation writes its own derived selection only when its current global frontier is materialized. Legacy immediate-expansion runs preserve their historical behavior.
9. Genuinely new seeds and promoted roots are the pending work. The ordinary research resume engine processes those rows, so unrelated old Google/Surfer/Ahrefs collection is not repeated even if the cross-run cache has expired.
10. Unsupported persisted expansion-admission versions fail closed rather than forking a generation that mixes algorithms.
11. `results.zip` is rebuilt from the whole research folder.

The old discovery SQLite files are never rewritten.

## Downstream enrichment

An append changes the discovery dataset, therefore previous enrichments are historical snapshots of an older dataset. They are retained for audit/history and are not deleted or rewritten.

After a successful append, run downstream enrichment against the newly printed current run id:

```bash
npm run enrich -- --run <current-run-id> ...
```

This deliberately creates `enrichment-02`, `enrichment-03`, etc. **inside the same research folder**. The extra enrichment directories are versions of one research, not separate top-level researches.

Config-first continuation follows the same parent rule: OperatorConfig fingerprints describe semantic policy, while the current discovery generation remains a separate durable parent identity. Configured enrichment pins its `sourceRunId` and refuses to resume against a different current discovery generation.

Representative queries, entrant cohort, cohort history, traffic evidence and finalist decisions should then be regenerated from that current enrichment according to their existing parent-fingerprint rules.

## Batch provenance

The original seed file for each appended batch is preserved under `batches/`. `research.json` records:

- batch id and timestamp;
- original input path and preserved relative path;
- source row count;
- unique input keyword count;
- added keyword count for genuinely unseen normalized keywords;
- duplicate/already-known count, including an explicit seed that promotes an existing expansion-only keyword;
- all normalized batch keywords;
- the subset that was genuinely new;
- the combined run id produced by that batch.

A promotion-only batch can therefore have `addedKeywordCount = 0` and still create a new discovery generation. `addedKeywordCount` is a keyword-novelty fact, not a proxy for whether the append changed the current discovery generation.

The first historical run is represented as `batch-0001` when an existing research is adopted. Its original input path is retained from the run manifest, but the old source CSV is not retroactively copied because it may no longer exist.

## Concurrency and failure behavior

`research:append` is serialized against both other append/publication mutations and config-driven continuation for the same stable research identity. The append entrypoint acquires locks in the canonical order `execution -> batch -> discovery`: the config-driven research execution lock first, then the existing research batch/publication lock, and the shared discovery lock when collection starts. The composite research locks are held through append preparation **and** the resumed discovery collection.

This order matches config-first finalization (`execution -> batch`) and config-first discovery (`execution -> discovery`), avoiding an AB/BA deadlock. Direct Library publication continues to use the batch lock without trying to reacquire the config execution lock from inside an already config-locked workflow.

The lock databases live under the output index, outside the research folder. SQLite transaction ownership is the lock; the OS releases ownership automatically if a process crashes. Lock contention is fail-fast rather than waiting through SQLite's multi-second default timeout.

The container manifest is written atomically. A new run is indexed before it becomes `currentRunId`; if the manifest update fails, the new run/index are removed so an unpublished combined snapshot cannot silently become current.

A new append is refused while the current run is non-terminal. Finish or resume that run first.

Parser generations are not mixed. If the current run was produced by incompatible Surfer/Google parser versions, append fails closed and a new research must be started.

## Relationship to Research Library

`research:append` changes one research container. `library:publish` still publishes an immutable version of the completed research into the cumulative cross-research library.

Typical flow:

```text
initial research
    ↓
append batch 2
    ↓
append batch 3
    ↓
current enrichment + human decision
    ↓
library:publish
```

A later append/re-enrichment can be published again; the Research Library keeps the older publication and links the new one through its existing `supersedes` history.
