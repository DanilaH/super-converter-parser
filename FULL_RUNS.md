# Full-run aliases

These commands are thin orchestration over the existing proven CLIs. They do not replace the underlying persistence, fingerprint, freshness, or fail-closed contracts.

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

## Full finalization

After full enrichment, the remaining implemented downstream pipeline can be orchestrated with one command:

```powershell
npm run finalize:full -- --enrichment <enrichment-id> `
  --clusters cluster-1,cluster-2 `
  --young-domain-max-age-days 730 `
  --recent-web-presence-max-age-days 730 `
  --repurpose-gap-min-days 365 `
  --decisions .\decisions.json
```

The command runs, in order:

```text
representative queries
entrant cohort
cohort history
traffic evidence when supplied or already persisted
finalist evidence matrix
Research Library publication when decisions are complete
```

### Finalist scope

The first representative-query generation still requires an explicit scope:

```bash
--clusters cluster-1,cluster-2
```

or, deliberately:

```bash
--all-clusters
```

A rerun may omit both when the enrichment already has persisted representative scope. `finalize:full` never silently treats all clusters as finalists.

### Cohort-history policy

The first cohort-history projection still requires the three explicit policy thresholds supported by `cohort-history`. Later reruns can omit them and reuse the persisted policy.

The example values `730 / 730 / 365` are a previously used pilot policy, not universal SEO truth. The orchestrator does not inject them automatically.

### Traffic

Traffic remains optional external evidence.

To import it during finalization:

```powershell
npm run finalize:full -- --enrichment <id> ... `
  --traffic .\traffic.csv `
  --low-base-organic-traffic-threshold 1000 `
  --decisions .\decisions.json
```

If compatible traffic snapshots and policy are already persisted for the enrichment, `finalize:full` automatically reruns the existing traffic projection even without a new `--traffic` file. If no traffic exists, the stage is skipped and traffic remains missing rather than fabricated.

### Human decisions and publication

`--decisions <path>` uses the existing strict finalist decision JSON contract.

After rebuilding the finalist matrix, the orchestrator checks the durable decision state. Research Library publication happens automatically only when every current finalist has a current human decision.

If decisions are incomplete, the command stops successfully after producing the current finalist matrix and prints how many finalist decisions are still missing. Re-run the same command with a decisions file after reviewing the evidence.

For a deliberate evidence-only publication, the operator may explicitly pass:

```bash
--publish-without-decisions
```

This escape hatch is never implied by `full` mode.

## Why these are separate commands

The common workflow is therefore:

```text
discovery:full
    ↓
enrich:full
    ↓
choose finalist clusters / review evidence
    ↓
finalize:full
```

Discovery and enrichment can be fully automated because their inputs and evidence rules are deterministic. Finalization contains explicit methodology choices, optional external traffic, and human BUILD/WATCH/REJECT decisions, so the one-command orchestrator forwards those choices instead of inventing them.
