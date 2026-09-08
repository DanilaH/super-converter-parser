# Local Runner Console

The Runner includes a localhost-only personal console for day-to-day operation.

## Start

```bash
npm run ui
```

The server binds only to `127.0.0.1` and opens the browser at `http://127.0.0.1:4173` by default.

Optional local settings:

```text
RESEARCH_UI_PORT=4173
RESEARCH_UI_NO_OPEN=true
```

`RESEARCH_UI_NO_OPEN=true` starts the server without opening a browser automatically.

## Current browser surface

The console can perform normal no-human-input config-first workflow steps, explicit discovery repair, mutable display-label management, and durable-state inspection.

### Researches

- browse researches discovered from the canonical run index;
- search by persisted display label, stable `researchId`, current run id, or another indexed run id;
- open one research and inspect canonical durable status;
- show/copy stable research, current discovery, and current enrichment IDs;
- inspect pipeline state, discovery keyword counts, quality warnings, batch history, immutable OperatorConfig provenance, and the Runner's canonical next operator action.

### New Research

The `New research` screen:

- uses the existing built-in OperatorConfig presets rather than inventing UI-only semantics;
- accepts pasted seed keywords, one per line;
- accepts optional market / Google `hl` / `gl` overrides;
- requires a plan preview before execution;
- shows supplied line count versus discovery-normalized unique keyword count;
- shows the resolved workflow target, stages, preset revision, discovery semantics, enrichment modules, external providers, and expected human stop points;
- starts the exact existing application workflow through the U2 execution boundary.

Changing any draft input invalidates the previous preview. The server resolves/validates the plan again at mutation time and the execution adapter resolves it again before durable work, so the browser preview is guidance rather than an authority that can bypass current contracts.

### Running jobs

Create, resume, and discovery-repair work runs in-process under existing Runner locks. The browser polls a bounded RAM-only job registry for convenience while continuing to read canonical research detail from existing SQLite/research files/indexes.

A running create job exposes its durable `researchId` as soon as initialization has produced the normal research identity, so the operator can move to Research Detail while long discovery work continues. The live panel refreshes durable discovery/status information independently of the static detail view.

The job registry is not durable truth. Restarting the UI may forget the convenience job record; the research itself remains recoverable from canonical status and can be continued or repaired again from Research Detail when canonical state permits it.

### Continue existing research

Research Detail exposes a browser continuation button only when all of the following are true:

- the research has immutable OperatorConfig provenance;
- the canonical `nextAction` supplies an executable stable-research command;
- the action is one of the normal config-first continuation actions: discovery resume, enrichment run/resume, finalization continuation, or the idempotent Library publication step;
- no other UI execution job is active.

The UI does not infer resumability from timestamps, directory names, or presentation state. It consumes the canonical status projection.

### Explicit discovery repair

`repair_discovery` remains separate from ordinary Continue because `retryFailed` is a distinct mutation with its own eligibility semantics.

Research Detail exposes the specialist repair action only when canonical status says `nextAction.code === repair_discovery` and the current discovery has one or more `repairable` checkpoints. The browser does not equate generic `failed` or `partial` counts with repair eligibility.

Before mutation, the application repair action:

1. reads canonical status and verifies repair eligibility;
2. acquires the existing per-research execution lock;
3. re-reads canonical status under that lock;
4. fails closed if repairability disappeared or the current discovery generation changed;
5. invokes the existing discovery resume path with `retryFailed: true` and `manageProcessSignals: false`;
6. returns a distinct repair result with before/after repairable counts and the resulting discovery state.

This preserves the existing primary-evidence repair rules and attempt history. The UI does not rewrite unknown evidence to zero and does not fabricate a normal workflow result for repair.

### Display label

Managed researches expose a compact display-label editor on Research Detail. This label is mutable presentation metadata in `research.json`; it is intentionally distinct from the immutable label captured in `operator-config.json` provenance when the research was created.

Renaming a display label:

- changes only `research.json.label` and `research.json.updatedAt`;
- does **not** rename the research directory or its original slug;
- does **not** change `researchId`, current/known run IDs, batch lineage, enrichment/finalization evidence, or OperatorConfig provenance;
- is idempotent when the trimmed label is already current;
- uses the existing composite research lock in canonical `execution → batch` order, so it cannot overwrite `research.json` concurrently with batch append or config-first continuation;
- refreshes the derived `results.zip` best-effort after the durable metadata commit. Archive failure is surfaced as a warning rather than making the committed rename look retryable.

The browser disables rename while it already knows another UI execution job is active. Canonical research locks remain authoritative for external CLI/process concurrency.

Shortlist, finalist-scope, and human-decision gates remain non-actionable until U4 because they require explicit human input; the console does not invent that input.

## Mutation boundary

Mutation requests are stricter than reads: they require `POST`, `Content-Type: application/json`, and a same-origin loopback `Origin` using the actual UI port. Request bodies are bounded. An unrelated webpage cannot drive localhost research operations merely because the Runner UI is open.

Only one UI execution job is admitted at a time. Existing Runner execution/discovery/batch locks remain authoritative. Explicit repair shares the same per-research execution lock used by config-first continuation. Display-label rename uses the composite execution-plus-batch lock because it mutates the shared research container.

New-research seed text is materialized only into a temporary local workspace long enough for the normal seed loader/workflow to consume it; that workspace is removed after execution. OperatorConfig provenance and research evidence keep their existing semantics.

## Truth model

The console does not have a UI database. Existing Runner SQLite/research files and indexes remain truth.

The research list is deliberately lightweight: it reads canonical run indexes and `research.json` rather than executing full deep status inspection for every row. Full status is built only for an opened or actively observed research.

The canonical run index does not duplicate the display label. Managed catalog rows read the current label from `research.json`, so a rename needs no run-index rewrite. Historical indexed runs without a durable `research.json` container remain independent and are not renameable through this managed-research action.

## Still out of scope

- batch append until U3.2;
- shortlist, finalist scope, and human-decision editing until U4;
- auth, accounts, cloud, multi-user operation, Electron/Tauri, or a durable UI queue/database.

## Roadmap

See [`UI_ROADMAP.md`](./UI_ROADMAP.md) for the active U0–U6 sequence. U4 remains the MVP completion gate for operating a normal research end-to-end without hand-authored continuation JSON or a coding agent driving the CLI.
