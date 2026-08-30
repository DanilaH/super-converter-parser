# Full-run aliases

These commands are convenience aliases over the existing proven CLIs. They do not introduce a second execution path or different persistence semantics.

## Full discovery

```bash
npm run discovery:full -- --seeds input/seeds.csv --name my-research
```

Microsoft input is also supported:

```bash
npm run discovery:full -- --microsoft input/microsoft.csv --name my-research
```

`discovery:full` is the normal research CLI with Keyword Surfer depth-one expansion enabled.

Normal discovery already performs the implemented primary discovery work:

- Keyword Surfer volume/CPC;
- Google organic SERP;
- Keyword Surfer related-keyword observation;
- domain normalization;
- Ahrefs free Domain Rating when `AHREFS_API_KEY` is configured;
- durable checkpoints, cache, quality/status artifacts and `results.zip`.

Therefore the only extra discovery capability currently activated by the `full` alias is related-keyword expansion (`--expand`). Ahrefs remains optional unless the operator explicitly supplies `--require-ahrefs`; the full alias does not turn an optional external dependency into a blocking one.

## Full enrichment

```bash
npm run enrich:full -- --run <source-run-id> --shortlist-file input/shortlist.txt
```

The alias runs every enrichment module currently marked implemented:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

The existing shortlist contract remains authoritative. Because the full module set contains deep modules, supply `--shortlist` or `--shortlist-file` with 5-200 source-run keywords.

All existing options still pass through, for example:

```bash
npm run enrich:full -- --run <source-run-id> --shortlist-file input/shortlist.txt --max-suggestions-per-source 5 --max-parents 10
```

## Deliberate boundary

`enrich:full` does **not** automatically run:

- representative-query selection;
- entrant cohort;
- cohort history projection;
- traffic-evidence import;
- finalist evidence / human BUILD-WATCH-REJECT decisions;
- Research Library publication.

Those stages depend on finalist scope, optional external evidence, or explicit human judgement. Running them blindly would weaken the existing evidence and decision contracts.

After full enrichment, continue with the normal downstream commands for the clusters you actually want to evaluate.
