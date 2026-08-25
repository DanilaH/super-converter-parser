# SERP clustering acceptance

This is a verification of the existing clustering algorithm, not a request to
tune its thresholds blindly.

## 1. Collect the control SERPs

```bash
npm run research -- --seeds input/clustering-acceptance-seeds.csv --name clustering-acceptance
```

## 2. Run clustering

Use the run ID printed by discovery:

```bash
npm run enrich -- --run <run-id> --modules clusters
```

## 3. Review the evidence

Inspect `enrichment/keyword-clusters.json` and record:

- pairwise shared-domain counts and Jaccard values;
- whether the five business-day queries form the expected close group;
- whether the five URL-cleaner queries form the expected close group;
- whether the two different intents remain separate;
- any obvious synonym pair split despite strong SERP overlap.

Do not change the algorithm merely because live Google produces more than two
connected components. Threshold changes require evidence from the pair rows.
