# Config-First Operator UX Implementation Plan

## Status

**Current next-track implementation plan after V2.3 historical-presence acceptance.**

V2.3 is accepted and closed. This plan defines the next product/architecture track: replace long remembered CLI flag sequences with a declarative operator configuration while preserving the Runner's existing durable-state, evidence, invalidation, and human-decision semantics.

This file is the source of truth for this track. `IMPLEMENTATION_PLAN.md` remains historical v1 delivery history.

The plan was independently reviewed before implementation. The review found four architectural blockers that are now part of the contract rather than deferred implementation details:

1. continuation of a specific research after human gates must use an explicit stable research identity;
2. a single global config fingerprint must not drive stage invalidation;
3. execution plans are resolved projections over current durable state, not a new source of truth;
4. base research intent and later continuation/human inputs must have explicit, non-magical semantics.

## Goal

The operator should be able to describe normal research intent in one small versioned JSON file, inspect exactly what the Runner intends to do, launch a new research, and later continue that exact research after human gates without reconstructing generated IDs or long command lines from memory.

Target architecture:

```text
Base OperatorConfig
        +
Continuation input (optional)
        +
Current persisted research state
        +
Machine/runtime config
        |
        v
Semantic resolver
        |
        v
ResolvedExecutionPlan
      /              \
     v                v
research:plan      research:run
                       |
                       v
             stage application services
                       |
                       v
                 existing Runner

Later:

GUI -> same schemas -> same resolver -> same plan -> same executor
```

The important invariant is that planning, CLI execution, continuation, and the future GUI must not implement separate workflow semantics.

## Durable truth and plan lifetime

SQLite remains the durable source of truth for research state. Existing generation/revision/fingerprint contracts remain authoritative.

`ResolvedExecutionPlan` is **not** a workflow database and is **not** a durable substitute for SQLite. It is an ephemeral, deterministic projection built from:

```text
operator intent + continuation input + current durable state + runtime capabilities
```

A plan may become stale whenever the research changes. Before a side-effecting stage executes, the executor must resolve or validate the plan against current parent state. It must not blindly execute a plan captured before a human decision or upstream evidence change.

JSON/CSV/Markdown artifacts remain publication/read surfaces rather than resume truth unless an existing accepted contract explicitly says otherwise.

## Current code reality

The repository already has two different kinds of configuration and they must remain conceptually separate:

1. `src/config/config.ts` is mostly **machine/runtime configuration** loaded from environment variables: CDP endpoint, timeouts, retry policy, cache TTLs, parser selectors, provider endpoints, etc. It also currently contains some semantic research values such as market, Google `hl/gl`, expansion defaults, Ahrefs requirement, and scoring thresholds.
2. The operator currently expresses **workflow/research intent** through independent CLI parsers in commands such as `research.ts`, `enrich.ts`, and `fullFinalize.ts`.

Do not replace the existing runtime config with one giant JSON object.

The new layer is an **operator workflow config**, not a dump of every environment variable and debug flag.

During migration, semantic settings that currently live in env/config must be resolved through one explicit semantic boundary. No downstream core path may silently see one semantic value through env and another through OperatorConfig.

## Design principles

1. **One semantic contract.** JSON, planner, executor, continuation flow, presets, and future GUI consume the same typed models.
2. **Plan before execute.** `research:plan` is implemented before config-driven execution. Side-effecting execution consumes a resolved plan, not raw JSON.
3. **Durable state wins.** Current SQLite parent identity/revision/fingerprint is authoritative for continuation and invalidation.
4. **Explicit research continuation.** A later run must name the research it continues; never infer the target from "latest", folder order, label, or config fingerprint.
5. **Stage-local compatibility.** Stage semantic fingerprints determine whether a semantic change affects that stage. A later decision/traffic input must not invalidate discovery merely because a whole JSON document changed.
6. **Additive migration.** Existing CLI commands remain supported while the config-first path proves itself.
7. **High-level intent only.** Config v1 contains normal research choices. Low-level diagnostics, emergency repair controls, secrets, credentials, and machine-local settings stay CLI/env-only unless concrete operator value is proven.
8. **No hidden defaults.** The planner shows important effective defaults and provenance.
9. **No invented automation.** Human-gated steps remain human-gated. A config file must not silently choose finalist clusters or fabricate human decisions.
10. **Stable versioning.** Every config/preset/continuation contract has an explicit version; unsupported versions fail clearly.
11. **No GUI-specific model.** The future GUI edits/produces the same operator contracts; it does not own another workflow schema.
12. **No CLI string round-trip as architecture.** Stage CLIs become adapters over shared application services as config-driven execution reaches each stage; planner/executor must not permanently serialize an ExecutionPlan back into CLI strings only to be reparsed.

## Contract families

The track intentionally uses more than one small typed contract instead of one mutable god-file.

### `OperatorResearchConfigV1`

The base, reusable research intent known when a research is created.

It should be stable enough to keep as provenance for the research. It may contain an initial shortlist/finalist choice only when the operator genuinely knows that choice before launch, but it must not require future human judgments to be predeclared.

### Continuation inputs

Later human/operator inputs are supplied explicitly against a stable research identity. They are not silently written back into the original base config.

Examples:

- shortlist selection;
- finalist cluster scope;
- representative override file;
- traffic import;
- human finalist decisions;
- deliberate publication override.

The exact v1 representation may be one versioned `OperatorContinuationV1` discriminated union or a small set of stage-specific typed payloads. The schema PR must choose one and document it. The key invariant is explicit target research + explicit input type.

### Machine/runtime config

Existing env/machine settings remain separate: credentials, Chrome endpoint, timeouts, cache locations/TTLs, parser selectors, provider transport internals, output root, debugging controls, etc.

### `ResolvedResearchSemantics`

A shared semantic boundary used by both legacy and config-first paths.

During migration:

```text
legacy flags/env semantics ----\
                               -> ResolvedResearchSemantics -> stage core
OperatorConfig semantics -----/
```

A semantic value must be resolved once, with provenance, before stage core sees it. This prevents split-brain behavior while legacy paths remain supported.

### `ResolvedExecutionPlan`

A read-only projection of what can/should happen **now**, given current durable state and supplied operator inputs.

It may report executable stages, blocked stages, human requirements, expected stop point, and current parent identities. It is regenerated/revalidated as state changes.

## Explicit continuation identity

A new research is launched from config:

```bash
npm run research:run -- --config research.config.json
```

The result must expose a stable `researchId`.

Continuation must explicitly target that research. The intended interface shape is:

```bash
npm run research:plan -- --research <research-id> [--continue continuation.json]
npm run research:run  -- --research <research-id> [--continue continuation.json]
```

Exact flag naming may be adjusted only if a simpler equally explicit interface is proven during CLI implementation.

Rules:

- `--research` is mandatory for continuation;
- no "latest research" inference;
- no target lookup by config fingerprint;
- no target lookup by human label;
- continuation fails closed if the research does not exist or the supplied input is stale/incompatible with current parent state;
- generated run/enrichment IDs flow internally after the stable research has been selected.

## Scope boundary for Config v1

### Belongs in base operator JSON

Normal research intent:

- research label/name;
- target market / Google `hl` / `gl` where these are semantic research choices;
- input source: seed CSV or Microsoft export;
- desired maximum workflow target (`discovery`, `enrichment`, or `finalization`) without implying that human gates will be bypassed;
- discovery expansion on/off;
- whether Ahrefs is required vs optional;
- enrichment module selection;
- clustering parameters that are legitimate operator research choices;
- query-suggestion bounds/sources when they are normal product choices;
- cohort-history policy thresholds;
- sampled historical-presence product-level policy;
- traffic policy defaults (not a future traffic file itself);
- publication policy defaults.

### May be supplied initially or later as continuation input

- explicit shortlist;
- finalist scope;
- representative override file;
- traffic input file;
- human finalist decisions file;
- deliberate publish-without-decisions override.

If one of these is present before the first run, the resolver may consume it when the required parent exists. If it is not yet applicable, the plan must not pretend the parent exists.

### Does not belong in Config v1

Machine/infrastructure/debug state:

- API keys and credentials;
- Chrome/CDP endpoint;
- parser selectors;
- request timeout/retry/backoff internals;
- cache database paths and TTLs;
- machine-specific output root;
- emergency refresh controls;
- `--retry-failed` repair intent;
- verbose/debug logging internals;
- obscure provider implementation knobs without proven operator value.

Those continue to come from environment/machine config or explicit specialist CLI controls.

## Proposed v1 shape

Illustrative; PR A owns exact naming after tests make the boundary concrete.

```json
{
  "version": 1,
  "preset": "standard",
  "research": {
    "label": "json-tools",
    "market": "US",
    "googleHl": "en",
    "googleGl": "us",
    "input": {
      "type": "seeds",
      "path": "input/json-tools.csv"
    }
  },
  "workflow": {
    "target": "finalization"
  },
  "discovery": {
    "expand": true,
    "requireAhrefs": false
  },
  "enrichment": {
    "modules": [
      "clusters",
      "query_suggestions",
      "domain_age",
      "pages",
      "site_structure"
    ]
  },
  "finalization": {
    "historyPolicy": {
      "youngDomainMaxAgeDays": 730,
      "recentWebPresenceMaxAgeDays": 1095,
      "repurposeGapMinDays": 365
    },
    "traffic": {
      "mode": "optional"
    },
    "publishWithoutDecisions": false
  }
}
```

`workflow.target` describes the maximum desired workflow reach, not a state machine. The resolved plan may stop earlier at `awaiting_shortlist`, `awaiting_finalists`, `awaiting_decisions`, unavailable infrastructure, or other truthful gates.

## Path semantics

Every filesystem path authored in an operator config, preset overlay, or continuation file is resolved relative to **the file that declares it**, not `process.cwd()`.

Example:

```text
/projects/researches/json/research.config.json
  input.path = ./input/seeds.csv

resolved read path:
/projects/researches/json/input/seeds.csv
```

Rules:

- invoking the same config from another working directory must not change which file is read;
- resolved absolute machine paths are runtime data and are excluded from semantic fingerprints;
- diagnostic output may display the resolved absolute path;
- semantic/config fingerprints use canonical authored/logical values, not machine-specific absolute path prefixes;
- later execution/input identity still fingerprints actual source content where the existing stage contract requires it. A config fingerprint is not a substitute for an input-content fingerprint.

## Merge and precedence model

Base semantic operator values resolve in this order:

```text
schema defaults
< preset overlay
< research config file
```

A future `--set` may be added only after the first accepted config-first release. It is not part of PR A.

Machine/runtime environment is a separate input family, not another arbitrary operator-config precedence tier.

When a semantic value currently exists in legacy env/config, the semantic resolver must make the source explicit. Config-first execution cannot allow downstream code to reread a conflicting env value later.

Continuation inputs apply only to their explicit stage/domain. They do not globally override unrelated base config.

## Preset contract and merge semantics

Presets are not incomplete instances of `OperatorResearchConfigV1`. They use a separate versioned overlay contract, e.g. `OperatorResearchPresetV1`.

A preset has stable identity metadata such as:

```json
{
  "version": 1,
  "id": "standard",
  "revision": 1
}
```

Merge semantics are deliberately boring:

- objects merge recursively for fields defined by the overlay contract;
- arrays replace the inherited array completely;
- missing means inherit;
- `null` is allowed only where the schema gives it an explicit semantic meaning;
- no array union/dedupe magic;
- no preset may contain secrets, machine paths, human decisions, finalist choices, or other irreversible judgment;
- the plan records preset `id` + `revision` and provenance of important effective values.

Changing a preset revision changes the resolved semantics for future resolutions. Existing persisted research state is never silently reinterpreted as if it had always used the new revision.

## Fingerprint model

A whole-document fingerprint may exist for provenance/debugging, but it must **not** be used as the universal invalidation key.

PR A must define deterministic stage semantic fingerprints at least at these boundaries:

```text
discoverySemanticFingerprint
enrichmentSemanticFingerprint
finalizationPolicyFingerprint
```

If needed, narrower sub-fingerprints can be introduced only where an existing durable parent contract requires them.

Rules:

- adding a later human decision must not change the discovery semantic fingerprint;
- adding traffic input must not change discovery/enrichment semantic fingerprints;
- changing market/Google locale must change discovery semantics;
- changing enrichment module/clustering policy must not retroactively redefine discovery semantics;
- changing cohort-history thresholds changes finalization/history policy semantics but does not invalidate browser discovery;
- absolute resolved filesystem paths, timestamps, generated IDs, secrets, and runtime transport settings are excluded;
- canonicalization is deterministic and key-order independent;
- existing evidence-specific parent fingerprints remain authoritative. New stage semantic fingerprints supplement them; they do not replace entrant fingerprints, representative revisions, parser versions, source identities, etc.

## ResolvedExecutionPlan contract

The normalized/resolved plan is the architectural center of this track.

It should contain, at minimum:

- operator schema version;
- whole-document provenance fingerprint (optional for invalidation, useful for provenance);
- stage semantic fingerprints;
- preset identity/revision if any;
- effective semantic values;
- provenance/origin for important values (`default`, `preset`, `file`, `continuation`, and later possibly `override`);
- target research identity for continuation or explicit `new` context;
- current durable parent identities relevant to the next executable stage;
- ordered stage projections;
- per-stage state such as `ready`, `blocked`, `already_satisfied`, `not_requested`;
- stage inputs;
- external providers/network work expected;
- filesystem inputs that will be read;
- unresolved human requirements;
- expected stop point;
- whether publication is currently possible;
- a machine-readable representation for the future GUI.

The plan must not contain secrets.

A planner for a new research can resolve against `stateContext = new`. A continuation plan resolves against the selected research's current persisted state.

## Application-service boundary

The current CLIs contain valuable accepted behavior and must not be rewritten wholesale. However, the final architecture must not be:

```text
OperatorConfig -> ExecutionPlan -> construct CLI strings -> spawn CLI -> parse args again -> core
```

As PR C–E reaches a stage, extract/reuse the smallest coherent application service around the existing behavior, for example conceptually:

```text
runDiscovery(...)
runEnrichment(...)
runFinalization(...)
```

Legacy CLI and config-first executor should both adapt into that service.

This extraction is incremental. Do not refactor stages that config-driven execution has not reached merely for symmetry.

## Delivery sequence

### PR A — Config contracts, validation, normalization, and fingerprint foundation

Deliver:

- `OperatorResearchConfigV1` typed contract;
- versioned continuation contract shape (types/schema only; no execution);
- explicit `ResolvedResearchSemantics` boundary for semantic operator values;
- runtime validation;
- JSON Schema artifact or schema-export command suitable for editor autocomplete;
- config file loader with useful path-aware validation errors;
- relative-path resolution from the declaring config/continuation file;
- deterministic normalization for new-research context;
- preliminary `ResolvedExecutionPlan` model that is explicitly a projection and contains no execution side effects;
- whole-document provenance fingerprint if useful;
- stage semantic fingerprints with documented inclusion/exclusion rules;
- strict unknown-field behavior unless a deliberate forward-compatible policy is documented;
- tests for valid config, invalid enum, missing field, bad numeric range, unknown field, unsupported version, continuation target/payload validation, path resolution independent of cwd, key-order-independent canonicalization, and stage-fingerprint isolation;
- one canonical example config;
- one canonical continuation example if the continuation schema is concrete enough to show honestly.

Implementation preference: use one schema definition capable of providing runtime validation, TypeScript typing, and JSON Schema, rather than hand-maintaining three independent contracts. If a dependency is added, justify it against this requirement.

Do not execute research, inspect SQLite research state, start Chrome, or call providers in this PR.

Acceptance:

```text
valid JSON -> typed normalized new-research plan object
invalid JSON/config -> INPUT_SCHEMA_ERROR with actionable path/message
same effective stage semantics -> same deterministic stage fingerprint
later-stage-only input change -> upstream stage fingerprints unchanged
relative authored paths -> same resolved target regardless of cwd
schema can drive editor completion
```

### PR B — `research:plan` read-only planner with durable-state resolution

Add:

```bash
npm run research:plan -- --config research.config.json
npm run research:plan -- --config research.config.json --json
npm run research:plan -- --research <research-id> [--continue continuation.json]
```

The command is read-only. It may read config/input metadata and current persisted research state, but must not:

- start Chrome;
- call Google/Surfer/Ahrefs/Common Crawl/RDAP;
- create research/enrichment DB state;
- mutate caches;
- publish artifacts;
- apply continuation inputs.

Human output should show:

```text
Research plan
  target research: new | <research-id>
  input
  effective semantic values/provenance
  discovery behavior
  enrichment modules
  finalization policy
  current parent state
  ready/already-satisfied/blocked stages
  network-backed stages
  unresolved operator decisions
  expected stop point
```

JSON output becomes the first stable machine contract for a future GUI review screen.

Acceptance:

1. planner output is deterministic for the same config + same durable state;
2. planner clearly distinguishes executable, already-satisfied, deferred/not-requested, and human-blocked work;
3. invalid/stale continuation combinations fail before any side effect;
4. semantic defaults and origins are visible;
5. tests prove zero execution/network adapters are invoked;
6. changing durable parent state changes/rejects the resolved plan appropriately rather than executing a stale projection.

### PR C — Config-driven discovery execution

Add the first executable path:

```bash
npm run research:run -- --config research.config.json
```

Initially limit side-effecting execution to the already-proven discovery stage.

Requirements:

- `research:run` resolves the same plan contract used by the planner immediately before execution;
- translate resolved semantics into the existing discovery behavior without duplicating browser collection logic;
- introduce the shared discovery application-service boundary as needed; do not permanently round-trip through constructed CLI strings;
- preserve current cache/resume/parser semantics;
- preserve current persisted semantic config snapshots;
- persist enough config/provenance identity to safely continue this exact research later without rereading mutable global defaults as if they were original intent;
- produce a machine-readable result containing stable `researchId` plus generated discovery/run identity;
- legacy `npm run research -- ...` remains valid through the same semantic/core boundary where practical.

Parity acceptance is primarily deterministic: with injected/fixed adapters and equivalent semantic inputs, legacy and config-first paths resolve equivalent persisted semantic settings and core calls. Live Google output is not required to be byte-identical across two separate network runs.

A real operator-machine smoke separately proves that the config path can perform a live discovery.

### PR D — Config-driven enrichment continuation

Extend the workflow executor to enrichment.

Continuation explicitly targets the stable research ID:

```bash
npm run research:plan -- --research <id> --continue shortlist.json
npm run research:run  -- --research <id> --continue shortlist.json
```

Requirements:

- resolve the current discovery generation from the selected research rather than asking the operator to copy a generated run ID;
- execute configured enrichment modules through existing behavior/application service;
- represent `awaiting_shortlist` or equivalent unresolved state explicitly;
- never invent a shortlist;
- persist/validate existing enrichment parent identity;
- keep resume behavior explicit and safe;
- machine-readable workflow result/status exposes generated enrichment identity;
- a later enrichment-only semantic change does not cause discovery re-execution unless an existing discovery parent contract independently requires it.

Acceptance: a real config-first research reaches the same enrichment evidence state as the existing commands without manual copying of generated IDs and stops truthfully when shortlist input is missing.

### PR E — Config-driven finalization continuation

Add the accepted finalization pipeline behind the same resolver/plan/executor contract.

Requirements:

- continuation explicitly names the research;
- explicit finalist scope is required before first representative selection unless valid persisted scope is intentionally reused;
- human decisions remain generation-pinned human facts;
- traffic remains optional and missing evidence remains missing;
- Common Crawl remains bounded sampled historical presence and never becomes exact first-seen/site age;
- existing entrant/representative/history/traffic/finalist invalidation contracts are preserved;
- stage semantic fingerprints never replace existing evidence-parent fingerprints;
- publication occurs only under existing decision rules or a deliberate explicit publication override;
- a changed finalization policy cannot silently reuse an incompatible resolved plan.

Acceptance: config-driven continuation reproduces accepted `finalize:full` semantics on a real enrichment and survives the same cache/invalidation/status checks.

### PR F — Presets

Only after schema/resolver/executor semantics are stable, add a small curated set such as:

```text
configs/presets/quick-scan.json
configs/presets/standard.json
configs/presets/deep-research.json
configs/presets/finalist-validation.json
```

Requirements:

- presets validate against the separate versioned preset-overlay contract;
- preset identity includes revision;
- arrays replace; objects merge recursively; no magic union semantics;
- planner shows which values came from preset vs config file;
- config values override preset predictably;
- no preset silently selects human judgment choices or irreversible actions.

### PR G — Config-first operator acceptance and legacy parity

Run real operator acceptance before starting GUI work.

Minimum gates:

1. create a new research from a config;
2. inspect the dry-run first;
3. execute discovery;
4. capture the stable research ID;
5. continue that exact research after a human gate without copying run/enrichment IDs;
6. stop truthfully at each missing human input;
7. continue finalization after supplying explicit choices;
8. rerun/reuse caches safely;
9. inspect `research:status` and machine JSON;
10. verify stage fingerprints do not trigger unrelated upstream invalidation;
11. compare config-first vs legacy semantic/core behavior deterministically;
12. verify secrets/machine settings and absolute machine paths are absent from semantic config fingerprints/snapshots where they do not belong.

Only real defects found here should trigger architecture changes.

### PR H — Small local GUI

Start only after PR G passes.

The first GUI should be intentionally small:

```text
New research
  -> choose preset
  -> input/seeds
  -> market
  -> discovery options
  -> enrichment options
  -> Review plan
  -> Start

Existing research
  -> select/open research
  -> Status / Next action
  -> provide shortlist/finalists/decisions/traffic when requested
  -> Review continuation plan
  -> Continue
```

GUI responsibilities:

- edit `OperatorResearchConfigV1`;
- produce typed continuation inputs;
- consume schema metadata for controls/help;
- call the same resolver/planner;
- display the same resolved execution plan;
- invoke the same workflow executor;
- display `research:status` / next action;
- target continuation by stable research ID.

GUI must not:

- reconstruct dozens of CLI switches itself;
- own workflow business logic;
- own a parallel persistence model;
- infer "latest" research as the continuation target;
- hide uncertainty or fabricate decisions;
- become a SaaS/dashboard project.

## Compatibility strategy

During this track:

- do not delete legacy commands;
- do not migrate every CLI parser at once;
- do not change accepted evidence semantics merely to make config prettier;
- do not use a whole-document fingerprint as a universal cache/invalidation key;
- do not create a new workflow database when existing durable state can answer the question;
- config-driven execution may initially adapt into existing stage code, but each reached stage should converge on a shared application service instead of permanent CLI-string spawning;
- extract additional shared services only where the current stage needs them;
- preserve all existing human-decision and evidence-parent contracts.

This remains an incremental wrapper/refactor strategy rather than a rewrite.

## Definition of Done for the config-first track

The track is complete when:

1. one versioned base JSON config expresses normal operator research intent;
2. later human/operator inputs use explicit typed continuation contracts against a stable research ID;
3. editor/schema validation is available;
4. `research:plan` shows an accurate no-side-effects plan for both new and existing research;
5. `research:run --config` creates a research and returns stable `researchId`;
6. continuation targets that exact research and generated IDs flow internally;
7. human-gated states stop explicitly and expose the next required action;
8. stage semantic fingerprints isolate unrelated semantic changes while existing evidence fingerprints remain authoritative;
9. presets reduce repetitive configuration without hidden merge behavior;
10. legacy CLI semantics remain valid during migration;
11. a real operator acceptance run passes;
12. only then a small GUI sits on the same contracts.

## What not to do

Do not use this track as justification to:

- build V3/commercial scoring;
- revive Wayback;
- add provider/plugin frameworks;
- rewrite SQLite persistence;
- create a generic workflow engine;
- rewrite every CLI command;
- put secrets into JSON;
- make absolute machine paths semantic identities;
- auto-select shortlist/finalists;
- auto-create BUILD/WATCH/REJECT decisions;
- build a large dashboard;
- make `ResolvedExecutionPlan` a second durable truth source.

The objective is operator UX and declarative control, not architecture expansion for its own sake.

## Immediate next implementation task

Start **PR A only**: define base/continuation contracts, runtime/schema validation, path semantics, semantic resolver boundary, new-research plan projection, stage-specific fingerprints, examples, and tests. No research execution, no durable-state inspection, no provider/network work, and no GUI in PR A.
