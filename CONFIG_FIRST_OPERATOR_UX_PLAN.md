# Config-First Operator UX Implementation Plan

## Status

**Current next-track implementation plan after V2.3 historical-presence acceptance.**

V2.3 is accepted and closed. This plan defines the next product/architecture track: replace long remembered CLI flag sequences with a declarative, typed operator configuration and build all later UX on top of one validated execution-plan contract.

This file is the source of truth for this track. `IMPLEMENTATION_PLAN.md` remains historical v1 delivery history.

## Goal

The operator should be able to describe a research in one small versioned JSON file, inspect exactly what the Runner intends to do, and launch it without reconstructing long command lines from memory.

Target architecture:

```text
operator JSON / preset
        |
        v
Config Schema v1
        |
        v
normalize + validate
        |
        v
ExecutionPlan
      /      \
     v        v
research:plan research:run
                |
                v
          existing Runner stages

Later:

GUI -> same Config Schema -> same ExecutionPlan -> same executor
```

The important invariant is that planning, CLI execution, and the future GUI must not implement separate workflow semantics.

## Current code reality

The repository already has two different kinds of configuration and they must remain conceptually separate:

1. `src/config/config.ts` is mostly **machine/runtime configuration** loaded from environment variables: CDP endpoint, timeouts, retry policy, cache TTLs, parser selectors, provider endpoints, etc.
2. The operator currently expresses **research intent** through independent CLI parsers in commands such as `research.ts`, `enrich.ts`, and `fullFinalize.ts`.

Do not replace the existing runtime config with one giant JSON object.

The new layer is an **operator workflow config**, not a dump of every environment variable and debug flag.

## Design principles

1. **One semantic contract.** JSON, presets, planner, executor, and future GUI consume the same typed model.
2. **Plan before execute.** `research:plan` is implemented before `research:run`. Execution must consume the already-normalized `ExecutionPlan`; it must not reinterpret raw JSON separately.
3. **Additive migration.** Existing CLI commands remain supported while the config-first path proves itself.
4. **High-level intent only.** Config v1 contains normal research choices. Low-level diagnostics, emergency repair controls, secrets, credentials, and machine-local settings stay CLI/env-only unless a concrete UX need appears.
5. **No hidden defaults.** The planner must show important effective defaults and where values came from.
6. **No invented automation.** Human-gated steps remain human-gated. A config file must not silently choose finalist clusters or fabricate human decisions.
7. **Stable versioning.** Every config has a required `version`; unsupported versions fail clearly.
8. **No GUI-specific model.** The future GUI edits/produces this config; it does not own another schema.

## Scope boundary for Config v1

### Belongs in operator JSON

Normal research intent:

- research label/name;
- target market / Google `hl` / `gl` where these are semantic research choices;
- input source: seed CSV or Microsoft export;
- discovery expansion on/off;
- whether Ahrefs is required vs optional;
- enrichment module selection;
- clustering parameters that are legitimate operator research choices;
- shortlist source when explicitly available;
- finalist scope when explicitly selected;
- representative count / explicit override file;
- cohort-history policy thresholds;
- sampled historical-presence policy exposed at the product level;
- optional traffic import and its policy threshold;
- human-decisions file when present;
- publication policy.

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

Illustrative only; the schema PR owns exact naming.

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
    "mode": "deferred",
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

`finalization.mode = "deferred"` is important: the first research run must be allowed to stop after producing evidence that the operator needs to inspect before selecting finalist scope or decisions.

## Merge and precedence model

Semantic operator values resolve in this order:

```text
schema defaults
< preset
< research config file
< explicit future --set override
```

Machine/runtime environment is a separate layer, not another competing operator-config precedence tier.

If a semantic setting exists both in legacy environment config and the new workflow config during migration, the normalized execution layer must resolve it explicitly and persist the effective semantic value. No silent split-brain behavior is allowed.

`--set` is optional follow-up power-user functionality and is not required for the first accepted config-first release.

## ExecutionPlan contract

The normalized plan is the architectural center of this track.

It should contain, at minimum:

- config schema version;
- config fingerprint;
- preset identity if any;
- effective semantic values;
- provenance/origin for important values (`default`, `preset`, `file`, later `override`);
- ordered stages;
- stage inputs;
- external providers/network work expected;
- filesystem inputs that will be read;
- unresolved human requirements;
- expected stop point;
- whether publication is possible with current inputs;
- a machine-readable representation for the future GUI.

The plan must not contain secrets.

## Delivery sequence

### PR A — Config contract and validation foundation

Deliver:

- `OperatorResearchConfigV1` typed contract;
- runtime validation;
- JSON Schema artifact or schema-export command suitable for editor autocomplete;
- config file loader with useful path-aware validation errors;
- deterministic normalization to a preliminary `ExecutionPlan` model;
- strict unknown-field behavior, unless a deliberate forward-compatible policy is documented;
- tests for valid config, invalid enum, missing field, bad numeric range, unknown field, unsupported version, and config fingerprint stability;
- one canonical example config.

Implementation preference: use one schema definition capable of providing both runtime validation and TypeScript typing/JSON Schema, rather than hand-maintaining three independent contracts. If a dependency is added, justify it against this requirement.

Do not execute research in this PR.

Acceptance:

```text
valid JSON -> typed normalized plan object
invalid JSON/config -> INPUT_SCHEMA_ERROR with actionable path/message
same effective config -> same deterministic fingerprint
schema can drive editor completion
```

### PR B — `research:plan` read-only planner

Add:

```bash
npm run research:plan -- --config research.config.json
npm run research:plan -- --config research.config.json --json
```

The command is read-only. It may read config/input metadata, but must not:

- start Chrome;
- call Google/Surfer/Ahrefs/Common Crawl/RDAP;
- create research/enrichment DB state;
- mutate caches;
- publish artifacts.

Human output should show:

```text
Research plan
  input
  discovery behavior
  enrichment modules
  finalization state
  network-backed stages
  unresolved operator decisions
  expected stop point
```

JSON output becomes the first stable machine contract for a future GUI review screen.

Acceptance:

1. planner output is deterministic for the same effective config;
2. planner clearly distinguishes `deferred` work from executable work;
3. invalid/unresolved combinations fail before any side effect;
4. semantic defaults are visible rather than hidden;
5. tests prove zero execution/network adapters are invoked.

### PR C — Config-driven discovery execution

Add the first executable path:

```bash
npm run research:run -- --config research.config.json
```

Initially limit execution to the already-proven discovery stage. This is intentionally narrower than pretending the entire human-gated pipeline is one unattended command on day one.

Requirements:

- `research:run` loads the same `ExecutionPlan` produced by the planner;
- translate plan fields into the existing discovery behavior without duplicating collection logic;
- preserve current cache/resume/parser semantics;
- preserve current persisted semantic config snapshots;
- produce a machine-readable result containing the generated research/run identity;
- legacy `npm run research -- ...` remains valid.

Acceptance: a representative config-driven discovery run and the equivalent legacy CLI run produce semantically equivalent persisted settings and outputs, excluding generated IDs/timestamps and other intentionally nondeterministic metadata.

### PR D — Config-driven enrichment continuation

Extend the workflow executor to enrichment.

The config/execution model must support the real human workflow rather than assuming every enrichment can begin automatically. If deep modules require a shortlist and none exists, the workflow should stop truthfully with an explicit next action instead of inventing one.

Requirements:

- consume the discovery run identity returned by the previous stage;
- execute configured enrichment modules through existing behavior;
- represent `awaiting_shortlist` / equivalent unresolved state explicitly;
- keep resume behavior explicit and safe;
- machine-readable workflow status must expose generated enrichment identity.

Acceptance: a real config-first research can reach the same enrichment evidence state as the existing commands without manually copying generated IDs between commands.

### PR E — Config-driven finalization continuation

Add the existing finalization pipeline behind the same plan/executor contract.

Requirements:

- `deferred` finalization is a valid completed stop point;
- explicit finalist scope is required before first representative selection unless valid persisted scope is intentionally reused;
- human decisions remain human decisions;
- traffic remains optional and missing evidence remains missing;
- Common Crawl remains bounded sampled historical presence and never becomes exact first-seen/site age;
- existing invalidation/fingerprint contracts are preserved;
- publication occurs only under existing decision rules or an explicit `publishWithoutDecisions` choice.

Acceptance: config-driven finalization reproduces the accepted `finalize:full` semantics on a real enrichment and survives the same cache/invalidation/status checks.

### PR F — Presets

Only after the schema and executor are stable, add a small curated set such as:

```text
configs/presets/quick-scan.json
configs/presets/standard.json
configs/presets/deep-research.json
configs/presets/finalist-validation.json
```

Presets are schema-valid partial operator configs. They must not contain secrets or machine paths.

Acceptance:

- preset expansion is deterministic;
- planner shows which values came from the preset vs the research file;
- config-file values override preset values predictably;
- no preset silently selects irreversible/human judgment choices.

### PR G — Config-first operator acceptance and legacy parity

Run real operator acceptance before starting GUI work.

Minimum gates:

1. create a new research from a config;
2. inspect the dry-run first;
3. execute discovery;
4. continue enrichment without copying IDs manually;
5. stop truthfully at a human gate when required;
6. continue finalization after supplying explicit choices;
7. rerun/reuse caches safely;
8. inspect `research:status` and machine JSON;
9. compare with legacy CLI semantics;
10. verify secrets/machine settings are absent from saved research config.

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
  -> Status / Next action
```

GUI responsibilities:

- edit `OperatorResearchConfigV1`;
- consume schema metadata for controls/help;
- call the same planner;
- display the same execution plan;
- invoke the same workflow executor;
- display `research:status` / next action;
- let the operator provide later human-gated inputs.

GUI must not:

- reconstruct dozens of CLI switches itself;
- own workflow business logic;
- own a parallel persistence model;
- hide uncertainty or fabricate decisions;
- become a SaaS/dashboard project.

## Deliberate sequencing change from the handoff

The handoff suggested:

```text
Config Schema v1
-> research:run --config
-> presets
-> research:plan / dry-run
-> GUI
```

This plan changes the middle ordering to:

```text
Config Schema v1
-> research:plan / dry-run
-> research:run --config
-> staged enrichment/finalization
-> presets
-> real operator acceptance
-> GUI
```

Reason: the normalized `ExecutionPlan` should be proven before side-effecting execution exists. Otherwise the planner risks becoming a later reimplementation of executor behavior.

## Compatibility strategy

During this track:

- do not delete legacy commands;
- do not migrate every CLI parser at once;
- do not change accepted evidence semantics merely to make config prettier;
- config-driven execution may initially adapt the normalized plan to existing stage entry points;
- extract additional shared application services only where duplication or subprocess boundaries become a demonstrated problem.

This is intentionally an incremental wrapper/refactor strategy rather than a rewrite.

## Definition of Done for the config-first track

The track is complete when:

1. one versioned JSON config can express normal operator research intent;
2. editor/schema validation is available;
3. `research:plan` shows an accurate no-side-effects execution plan;
4. `research:run --config` executes that exact plan through the supported stages;
5. generated IDs flow between stages automatically;
6. human-gated states stop explicitly and expose the next required action;
7. presets reduce repetitive configuration without hiding important choices;
8. legacy CLI semantics remain valid during migration;
9. a real operator acceptance run passes;
10. only then a small GUI can sit on the same config/plan/executor contracts.

## What not to do

Do not use this track as justification to:

- build V3/commercial scoring;
- revive Wayback;
- add provider/plugin frameworks;
- rewrite SQLite persistence;
- rewrite every CLI command;
- put secrets into JSON;
- auto-select finalists;
- auto-create BUILD/WATCH/REJECT decisions;
- build a large dashboard;
- implement a generic workflow engine unrelated to the current Runner.

The objective is operator UX and declarative control, not architecture expansion for its own sake.

## Immediate next implementation task

Start **PR A only**: define the Config Schema v1 boundary, typed/runtime schema, loader, normalization/fingerprint, example config, and tests. No execution path and no GUI in that PR.
