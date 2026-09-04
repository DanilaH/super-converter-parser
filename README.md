# Utility Research Runner

Local-first CLI for discovering, validating, extending, and preserving SEO research for small browser utilities.

This is an internal research tool, not a SaaS product. SQLite checkpoints are the durable source of truth; CSV/JSON/Markdown/ZIP files are derived operator or publication artifacts.

## Current operator workflow

The accepted primary operator layer is **config-first**:

```text
research.config.json
        ↓
research:plan
        ↓
research:run
        ↓
explicit stable researchId
        ↓
continue the same research through human gates
        ↓
Research Library publication when current decisions are complete
```

Typical commands:

```bash
npm run research:plan -- --config configs/examples/research.config.json
npm run research:run -- --config configs/examples/research.config.json
```

Continuation always targets a stable research identity:

```bash
npm run research:plan -- --research <research-id> [--continue continuation.json]
npm run research:run  -- --research <research-id> [--continue continuation.json]
```

The planner is read-only. The runner resolves the same workflow semantics against current durable state and stops truthfully at unresolved human inputs such as shortlist, finalist scope, or finalist decisions.

Legacy/direct stage CLIs remain supported as specialist/operator surfaces. See [`FULL_RUNS.md`](./FULL_RUNS.md).

## Runtime and install

The repository and CI runtime are pinned by `.nvmrc` (currently Node 24).

```bash
npm ci
```

Create local configuration from `.env.example`. `.env`, browser profiles, caches, research outputs, and secrets are gitignored.

### Research Chrome

Discovery and browser-backed suggestion collection use a dedicated Chrome profile with Keyword Surfer installed. Do not use the daily browsing profile.

```powershell
npm run chrome:setup
npm run chrome:start
```

The default CDP endpoint is `http://127.0.0.1:9333` and can be overridden with `CDP_URL`.

## Config-first research

A canonical example lives at:

```text
configs/examples/research.config.json
```

The config describes semantic research intent such as:

- label and input source;
- market and Google `hl/gl`;
- maximum workflow target;
- discovery expansion and Ahrefs requirement;
- enrichment modules;
- finalization/history policy.

Machine/runtime settings remain separate. Credentials, CDP URL, cache path, transport timeouts, parser selectors, and machine-specific absolute paths are not semantic research identity.

Presets are available under `configs/presets/`. Preset identity/revision and effective semantic provenance are persisted so later preset changes do not reinterpret an existing research.

### Plan without side effects

```bash
npm run research:plan -- --config research.config.json
npm run research:plan -- --config research.config.json --json
```

For an existing research:

```bash
npm run research:plan -- --research <research-id> [--continue continuation.json]
```

`research:plan` may inspect durable state, but it does not start Chrome, call providers, mutate SQLite, apply human inputs, or publish artifacts.

### Execute

```bash
npm run research:run -- --config research.config.json
```

The result exposes the stable `researchId`. Generated discovery/enrichment IDs flow internally after that.

To continue or resume the same configured research:

```bash
npm run research:run -- --research <research-id>
npm run research:run -- --research <research-id> --continue continuation.json
```

Continuation files are typed/versioned and explicitly target the same stable research. The runner never guesses the target from “latest”, label, directory order, or config fingerprint.

## Discovery

Direct discovery remains available:

```bash
npm run discovery:full -- --seeds input/seeds.csv --name my-research
npm run discovery:full -- --microsoft input/microsoft.csv --name my-research
```

or via the lower-level CLI:

```bash
npm run research -- --seeds input/seeds.csv
npm run research -- --microsoft input/microsoft.csv
npm run research -- --seeds input/seeds.csv --expand
```

Discovery persists:

- Google organic evidence and explicit SERP observation state;
- Keyword Surfer volume/CPC and Related observations;
- normalized domains;
- optional Ahrefs DR;
- cache provenance and quality state;
- resumable SQLite checkpoints;
- deterministic derived artifacts.

Ahrefs remains optional unless explicitly required. Missing evidence stays missing; it is never converted to zero.

### Expansion Admission V1

Fresh public discovery with expansion enabled uses the accepted **global admission V1** path.

It does not append Related candidates immediately after each parent. Instead:

```text
collect every root + raw Related evidence
        ↓
all roots terminal
        ↓
deterministic global admission frontier
        ↓
append only selected expansion children
        ↓
collect their SERPs
```

Important V1 behavior:

- depth remains 1;
- automatic single-token expansion candidates are rejected;
- explicit seeds may still be single-token;
- `minOverlap`, `minVolume`, and per-parent limits remain admission inputs;
- strict lexical broadening is deprioritized;
- additions are capped at `min(500, ceil(originalKeywordCount * 1.25))`;
- directional queries remain distinct;
- `expansion-admission.json` and `.csv` expose every deterministic decision/reason/supporting parent;
- unsupported persisted admission versions fail closed;
- historical snapshots without the marker keep their historical behavior.

### Ordinary resume

```bash
npm run research -- --resume <run-id>
```

Ordinary resume continues unfinished work. Terminal primary checkpoints are not silently reopened.

### Explicit primary-checkpoint repair

```bash
npm run research -- --resume <run-id> --retry-failed
```

`--retry-failed` is a historical flag name. The current repair surface includes:

- failed primary keyword checkpoints; and
- provably incomplete `partial` primary checkpoints whose persisted source evidence establishes a repairable primary failure.

Prior attempt evidence is journaled before current primary state is reopened.

## Append another seed batch

```bash
npm run research:append -- --to <research-id-or-run-id> --seeds input/more-seeds.csv
```

Append extends one logical research through immutable combined discovery generations.

A batch may create a new generation because it:

- adds a genuinely new normalized keyword; or
- explicitly promotes an existing expansion child into a root seed.

A promotion-only append may therefore create a new generation with `addedKeywordCount = 0`.

The stable research identity remains anchored to the first discovery generation while `research.json.currentRunId` advances. See [`RESEARCH_BATCHES.md`](./RESEARCH_BATCHES.md).

## Inspect current research status

```bash
npm run research:status -- --research <research-id-or-any-run-id>
npm run research:status -- --research <research-id-or-any-run-id> --json
```

`research:status` is read-only. It resolves the current logical research, reports current discovery/enrichment/finalization/publication state, projects evidence gaps truthfully, and exposes workflow navigation without making a product/business recommendation.

## Compare immutable generations

```bash
npm run research:diff -- --research <research-id-or-run-id> --from discovery:1 --to discovery:2
npm run research:diff -- --research <research-id-or-run-id> --from enrichment:1 --to enrichment:2
```

The diff is factual. It does not infer semantic continuity, opportunity quality, or whether a newer generation is “better”.

## Deep enrichment

Direct full enrichment:

```bash
npm run enrich:full -- --run <current-run-id> --shortlist-file input/shortlist.txt
```

The current full module set is:

```text
clusters
query_suggestions
domain_age
pages
site_structure
```

Shortlist-dependent deep work requires an explicit 5–200 keyword shortlist. Config-first execution stops at the corresponding human gate rather than inventing one.

Resume an existing enrichment generation with:

```bash
npm run enrich -- --resume <enrichment-id>
```

## Finalization

The accepted finalization evidence chain is:

```text
representative queries
        ↓
entrant cohort
        ↓
bounded Common Crawl sampled historical presence
        ↓
cohort history (RDAP / first-seen policy projection)
        ↓
optional compatible traffic evidence
        ↓
finalist evidence matrix
        ↓
explicit human decisions
        ↓
Research Library publication
```

Common Crawl evidence is **bounded sampled web presence**, not exact first-ever web presence or site age.

Direct orchestration remains available:

```powershell
npm run finalize:full -- --enrichment <enrichment-id> `
  --clusters cluster-1,cluster-2 `
  --young-domain-max-age-days 730 `
  --recent-web-presence-max-age-days 730 `
  --repurpose-gap-min-days 365 `
  --decisions .\decisions.json
```

The threshold values above are example policy, not universal SEO truth.

First finalization requires explicit finalist scope unless compatible persisted scope already exists. Human decisions are never fabricated. Evidence-only publication requires the deliberate `--publish-without-decisions` escape hatch.

## Research Library

Manual publication remains available:

```bash
npm run library:publish -- --enrichment <completed-enrichment-id>
```

`library.sqlite` is cumulative durable publication truth. `library.json`, `library.zip`, and per-publication archives are derived snapshots. Publication is immutable/idempotent for the same public fingerprint and keeps superseding history for later versions of the same research.

See [`RESEARCH_LIBRARY.md`](./RESEARCH_LIBRARY.md).

## Durable layout

A logical research may contain multiple immutable discovery and enrichment generations:

```text
<RESEARCH_OUTPUT_ROOT>/
└── <date>-<label>/
    ├── research.json
    ├── operator-config.json          # config-first provenance when applicable
    ├── batches/
    ├── discovery/
    ├── discovery-02/
    ├── enrichment/
    ├── enrichment-02/
    ├── debug/
    └── results.zip
```

Each discovery generation owns `run.sqlite`; each enrichment generation owns `enrichment.sqlite`. Old generations are retained and are not rewritten merely because a newer generation becomes current.

The output root also contains the run/enrichment locator index and `research-library/`.

## Core truth and safety contracts

- **SQLite first.** Generated artifacts are not resume/currentness truth.
- **Immutable generations.** Append/re-enrichment create new snapshots.
- **Stable research identity.** Current lineage is validated, not inferred from timestamps.
- **Fail closed on stale parents.** Downstream evidence pins compatible parent revisions/fingerprints.
- **Missing is not zero.** Unknown/unavailable/error/omitted states stay explicit.
- **No automatic finalist verdict.** Human decisions remain separate from automated evidence.
- **Truthful geography.** Surfer market, Google `hl/gl`, and detected location remain separate facts.
- **Bounded provider work.** Existing retry/rate/timeout/SSRF contracts remain enforced.
- **No anti-bot bypass.** CAPTCHA is solved manually; no stealth/proxy-evasion stack.
- **Currentness is lineage/fingerprint based.** Do not infer semantic freshness from mtime.

## Documentation map

For current behavior, use these documents by role:

1. [`README.md`](./README.md) — current operator entry points and map.
2. [`PRODUCT.md`](./PRODUCT.md) — product boundary.
3. [`ARCHITECTURE.md`](./ARCHITECTURE.md) — durable architecture/invariants.
4. [`PIPELINE.md`](./PIPELINE.md) — evidence pipeline.
5. [`FULL_RUNS.md`](./FULL_RUNS.md) — operator orchestration and direct stage commands.
6. [`RESEARCH_BATCHES.md`](./RESEARCH_BATCHES.md) — append lineage/provenance/locking.
7. [`RESEARCH_LIBRARY.md`](./RESEARCH_LIBRARY.md) — publication/version lineage.
8. [`SCORING.md`](./SCORING.md) — broad-discovery Score contract.
9. [`AGENTS.md`](./AGENTS.md) — coding-agent rules and documentation authority.

Versioned roadmaps, release acceptance files, methodology reports, and PR-specific plans are historical evidence unless a current document explicitly marks them as active planning. They do not override merged runtime behavior.

`V3_COMMERCIAL_EVIDENCE_SPEC.md` and `COMMERCIAL_DATA_PROVIDER_MATRIX.md` are future/inactive planning documents, not current runtime contracts.