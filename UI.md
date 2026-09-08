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

The console can perform normal no-human-input config-first workflow steps, explicit discovery repair, explicit shortlist selection, mutable display-label management, managed seed-batch append, and durable-state inspection.

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

Create, resume, shortlist-continuation, discovery-repair, and batch-append work runs in-process under existing Runner locks. The browser polls a bounded RAM-only job registry for convenience while continuing to read canonical research detail from existing SQLite/research files/indexes.

A running create job exposes its durable `researchId` as soon as initialization has produced the normal research identity, so the operator can move to Research Detail while long discovery work continues. Long-running discovery, including discovery created by a new appended batch, is observed through canonical research status in parallel with ephemeral job state.

The job registry is not durable truth. Restarting the UI may forget the convenience job record; the research itself remains recoverable from canonical status and can be continued, repaired, or supplied with the current human-gate input again when canonical state permits it.

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

### Explicit shortlist human gate

When canonical planning reports unresolved `shortlist` input, Research Detail exposes a specialist shortlist selector instead of pretending that ordinary Continue can invent the missing human choice.

The shortlist surface:

- loads candidates only for the current discovery generation;
- uses the existing Runner candidate/scoring projection rather than a UI scoring formula;
- shows keyword, Surfer volume, Score, Tier, organic-result count, median DR, weak-domain count, and scoring completeness;
- preserves unscored/degraded evidence as unscored/degraded;
- supports local search and Tier filtering as presentation only;
- preselects nothing;
- requires an explicit selection of 5–200 unique normalized keywords, matching the existing enrichment shortlist contract;
- never automatically chooses the top-N, Tier A/B, or any other inferred shortlist.

Submission is tied to the discovery run that produced the displayed candidates. The application service verifies candidate membership, materializes only a temporary canonical `keyword` CSV, resolves the existing `OperatorContinuationV1` shortlist action, and calls the same config-first `executeExistingResearch` workflow used by CLI continuation.

The workflow then re-reads status under the existing per-research execution lock through a stale-generation guard. If another batch changed the current discovery generation between selection and execution, the shortlist fails closed and the operator must reload current candidates. Once enrichment starts, its shortlist is persisted in the normal durable enrichment run; the temporary UI CSV is removed.

No shortlist selection is stored in a UI database or silently carried across discovery generations.

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

### Add batch

Managed Research Detail exposes an `Add batch` editor for extending a long-lived research with additional explicit seed keywords.

The batch flow deliberately reuses the existing append/fork contract:

1. pasted keywords are normalized through the normal seed semantics;
2. a read-only preview reports supplied lines, normalized unique keywords, new keywords, already-known keywords, and expansion children that would be promoted to explicit roots;
3. changing the pasted input invalidates the preview;
4. commit revalidates the draft and repeats authoritative append classification under the canonical `execution → batch` lock;
5. the existing `prepareResearchAppend` implementation creates batch metadata and, when necessary, forks a new immutable discovery generation while carrying forward eligible evidence;
6. when a fork is created, only the resulting discovery generation is collected while the composite lock remains held;
7. enrichment/finalization are **not** entered implicitly; after discovery, canonical `nextAction` again determines the next operator action.

A duplicate-only batch is still persisted as batch history but does not create a pointless discovery generation. An append that introduces new roots or promotes expansion-only keywords produces a new current discovery generation. Preview is advisory only and never serves as authorization for commit.

The UI does not silently adopt historical/indexed runs lacking a managed `research.json` container. Such researches fail closed for batch append rather than acquiring invented long-lived lineage.

Finalist-scope and human-decision gates remain non-actionable until their U4 slices land because they require explicit human input; the console does not invent that input.

## Mutation boundary

Mutation requests are stricter than reads: they require `POST`, `Content-Type: application/json`, and a same-origin loopback `Origin` using the actual UI port. Request bodies are bounded. An unrelated webpage cannot drive localhost research operations merely because the Runner UI is open.

Only one UI execution job is admitted at a time. Existing Runner execution/discovery/batch locks remain authoritative. Explicit repair and shortlist continuation share the same per-research execution lock used by config-first continuation. Display-label rename and batch append use the composite execution-plus-batch lock because they mutate the shared research container; batch append keeps that lock through resulting discovery collection.

New-research and batch seed text plus shortlist continuation CSV input are materialized only into temporary local workspaces long enough for the normal loader/workflow to consume them; those workspaces are removed after execution. OperatorConfig provenance and immutable research evidence keep their existing semantics.

## Truth model

The console does not have a UI database. Existing Runner SQLite/research files and indexes remain truth.

The research list is deliberately lightweight: it reads canonical run indexes and `research.json` rather than executing full deep status inspection for every row. Full status is built only for an opened or actively observed research. Shortlist candidate evidence is loaded only when the current Research Detail is actually at the shortlist human gate.

The canonical run index does not duplicate the display label. Managed catalog rows read the current label from `research.json`, so a rename needs no run-index rewrite. Historical indexed runs without a durable `research.json` container remain independent and are not renameable or appendable through managed-research actions.

## Still out of scope

- finalist-scope and human-decision editing until the remaining U4 slices;
- automatic shortlist/finalist/business decisions;
- automatic downstream enrichment/finalization after batch append;
- configuration evolution within an existing V1 research container;
- auth, accounts, cloud, multi-user operation, Electron/Tauri, or a durable UI queue/database.

## Roadmap

See [`UI_ROADMAP.md`](./UI_ROADMAP.md) for the active U0–U6 sequence. U4 remains the MVP completion gate; U4.1 shortlist operation is implemented in PR #171, while finalist scope and human decisions remain before a normal research is fully operable end-to-end without hand-authored continuation JSON or a coding agent driving the CLI.
