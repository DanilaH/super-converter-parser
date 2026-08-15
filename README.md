# Utility Research Runner

Local research CLI for discovering and filtering SEO opportunities for small browser utilities.

The tool exists to remove repetitive manual work from the research pipeline:

```text
seed ideas
   ↓
Microsoft Keyword Planner export (optional but recommended for broad discovery)
   ↓
Google + Keyword Surfer
   ├── exact-ish Google-oriented volume
   ├── CPC
   ├── related keyword ideas
   └── organic SERP
   ↓
domain normalization
   ↓
Ahrefs free Domain Rating API
   ↓
aggregation + deterministic scoring
   ↓
candidate shortlist
   ↓
manual deep Ahrefs / Similarweb only for survivors
```

This is an internal local tool, not a SaaS product.

## Proven integration

A completed spike proved that the risky part of the system works:

- dedicated research Chrome can be controlled through Playwright/CDP;
- Keyword Surfer injects data into the Google result page in a form accessible to automation;
- `compare lists` returned `49,500` volume and `7.90` CPC automatically;
- the parser extracted the real organic result set without confusing Keyword Surfer annotations with organic links;
- Keyword Surfer's related-keyword sidebar is also accessible and can be parsed.

The spike output showed the Google URL with `hl=en&gl=us`, but Google still displayed a Russian physical location in the footer. Therefore Surfer market targeting and Google SERP geolocation must be tracked separately.

## Main commands

Target CLI:

```bash
# Main broad-discovery flow
npm run research -- --microsoft input/microsoft.csv

# Direct seed flow
npm run research -- --seeds input/seeds.csv

# Expand direct seeds with Keyword Surfer related ideas
npm run research -- --seeds input/seeds.csv --expand-surfer

# Resume an interrupted run
npm run research -- --resume <run-id>

# Force selected refresh
npm run research -- --resume <run-id> --refresh-keyword "json diff"
npm run research -- --resume <run-id> --refresh-domain example.com

# Machine-readable final status for agents
npm run research -- --microsoft input/microsoft.csv --json-status
```

Exact flag names may be adjusted during implementation if consistency improves, but the capabilities are required.

## Primary outputs

Each execution creates an immutable historical run:

```text
runs/<run-id>/
├── manifest.json
├── keywords.csv
├── related-keywords.csv
├── serp.csv
├── domains.csv
├── candidates.csv
├── report.md
├── status.json
└── debug/
```

Persistent reusable cache lives outside run directories:

```text
data/
└── cache/
```

## Read next

1. `PRODUCT.md`
2. `ARCHITECTURE.md`
3. `PIPELINE.md`
4. `AGENTS.md`
5. `IMPLEMENTATION_PLAN.md`

---

## Proven spike details

## Status

```text
GO
```

The integration risk has been sufficiently reduced to proceed with the full runner.

## Observed result

Test query:

```text
compare lists
```

Observed automatically:

```text
Surfer volume: 49,500
Surfer CPC: 7.90
Organic candidates: 9
```

The values matched what was visibly rendered in the browser.

## Important implementation discovery

Keyword Surfer injected accessible elements into the Google document, including:

```text
surfer-main-keyword-widget
keyword-surfer-result
keyword-surfer-sidebar
```

The related-keyword sidebar also exposed keyword, overlap, and volume data.

This enables optional seed expansion in the production runner.

## Organic parsing

The parser produced nine valid organic candidates on the observed rendered page.

Keyword Surfer decorations alongside result cards were not mistaken for separate organic results.

## Geographic caveat

The request used:

```text
hl=en
gl=us
```

and Keyword Surfer was configured for the United States.

However, Google displayed a Russian physical location in the page footer.

Therefore:

- Surfer volume/CPC can be treated as the configured Surfer market;
- organic SERP localization must be recorded separately;
- the full runner must expose a geo mismatch warning.

## Recommendation

Proceed directly to the full production-ready local runner.

Do not spend another project phase re-proving the same single-query spike.
