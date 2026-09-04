# Documentation index

This directory contains **non-current** project documentation: frozen delivery/acceptance history and inactive future plans.

Current runtime/operator contracts deliberately remain at the repository root:

- [`README.md`](../README.md) — current operator entry points and documentation map;
- [`PRODUCT.md`](../PRODUCT.md) — current product boundary;
- [`AGENTS.md`](../AGENTS.md) — coding-agent rules and documentation authority;
- [`ARCHITECTURE.md`](../ARCHITECTURE.md) — current durable architecture and invariants;
- [`PIPELINE.md`](../PIPELINE.md) — current evidence pipeline;
- [`FULL_RUNS.md`](../FULL_RUNS.md) — current orchestration/direct operator commands;
- [`RESEARCH_BATCHES.md`](../RESEARCH_BATCHES.md) — append lineage and provenance;
- [`RESEARCH_LIBRARY.md`](../RESEARCH_LIBRARY.md) — immutable publication/library contract;
- [`SCORING.md`](../SCORING.md) — current broad-discovery score contract.

## Authority rule

Files under `docs/history/` are frozen records of what a release, phase, PR plan, or acceptance gate meant **at that time**. Internal phrases such as “current backlog”, “next PR”, “ready to merge”, or old command/architecture descriptions are historical context, not instructions for present work.

Files under `docs/plans/` are inactive future proposals. They are not current backlog or runtime requirements unless a current root contract explicitly activates that track.

If historical/future prose conflicts with current merged behavior, establish actual behavior from current code, schemas, tests, and CLI help, then keep the root current contracts truthful. Do not rewrite historical evidence as though it always described the latest system.

## Historical tracks

- [`history/v1/`](./history/v1/) — original v1 delivery and acceptance.
- [`history/v2.1/`](./history/v2.1/) — V2.1 evidence-quality/clustering/cohort track and methodology regression.
- [`history/v2.2/`](./history/v2.2/) — V2.2 operator/evidence-quality release.
- [`history/v2.3/`](./history/v2.3/) — accepted Common Crawl sampled historical-presence productionization.
- [`history/config-first/`](./history/config-first/) — implemented config-first operator track and its acceptance; GUI PR #117 was closed unmerged and is not current work.

## Inactive future plans

- [`plans/v3/`](./plans/v3/) — commercial-evidence planning/audit material. Not current runner scope.
