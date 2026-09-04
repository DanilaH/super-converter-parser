# SERP clustering acceptance

This is a verification of the existing clustering algorithm, not a request to
tune its thresholds blindly.

Clustering v2 is intentionally page-aware. A shared registrable domain is useful
evidence, but it is not by itself proof that two queries have the same intent.
The acceptance review therefore inspects domain overlap and normalized ranking-URL
overlap separately.

## 1. Collect the control SERPs

```bash
npm run research -- --seeds input/clustering-acceptance-seeds.csv --name clustering-acceptance
```

## 2. Run clustering

Use the run ID printed by discovery:

```bash
npm run enrich -- --run <run-id> --modules clusters
```

The default v2 comparison window is the first 10 ranked organic rows. URL and
domain evidence must be derived from that same raw top-N window before either set
is deduplicated.

The default strong-pair rule is:

```text
domain gate: shared domains >= 3 AND domain Jaccard >= 0.30
URL gate:    shared URLs    >= 2 AND URL Jaccard    >= 0.10
strong edge: domain gate AND URL gate
```

Pairs that have useful but insufficient evidence remain visible as
`domain_only`, `url_only`, or `weak`; they do not become clustering edges.

## 3. Review the evidence

Inspect `enrichment/keyword-clusters.json` and record:

- pairwise domain intersection/union/Jaccard and shared-domain identities;
- pairwise URL intersection/union/Jaccard and shared normalized URL identities;
- the pair classification (`strong`, `domain_only`, `url_only`, `weak`, `none`);
- whether the five business-day queries form the expected close group;
- whether the five URL-cleaner queries form the expected close group;
- whether the two different intents remain separate;
- any obvious synonym pair split despite strong page-level SERP overlap;
- multi-member cluster cohesion (`min`, `median`, `mean` URL/domain Jaccard);
- singleton cohesion (`pairCount=0` with null URL/domain summaries).

Clustering v2 groups strong pairs with deterministic complete-link agglomeration:
two groups may merge only when every cross-pair is `strong`. Therefore an
A-B strong + B-C strong chain must not pull C into the same cluster when A-C is
not strong.

URL identity normalization removes presentation/tracking noise only. It must not
collapse meaningful paths, subdomains, path case, or semantic query parameters
(such as a YouTube `v` parameter).

Do not change the algorithm merely because live Google produces a different
number of clusters. Threshold or URL-identity changes require evidence from pair
rows and must be versioned; live SERP drift is not itself a reason to retune the
frozen Hardware/Audio regression corpus.
