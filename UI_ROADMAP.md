# Local Runner UI Roadmap

## Status and authority

**Active UI development track.**

The root `ROADMAP.md` previously kept GUI work as a non-goal unless a concrete operator requirement appeared. That gate is now satisfied: repeated day-to-day operation through coding agents/CLI is itself the measured friction. This file sequences the explicitly activated local UI work; it does not reactivate unrelated deferred tracks such as Wordstat or V3 commercial evidence.

Runtime truth remains in existing code, SQLite, active contracts, and tests. This roadmap must not reinterpret immutable research evidence or create a second state model.

## Product goal

A single local operator can launch the Runner, open a browser, browse existing researches, create or continue work, add batches, pass human gates, and inspect current state without asking a coding agent to operate the CLI.

Target interaction:

```text
npm run ui
→ localhost-only control panel
→ existing Runner application services
→ canonical output root + existing SQLite truth
```

## MVP Definition of Done

A normal config-first research can be created, resumed after process/browser restart, extended with a new batch, taken through shortlist/finalist/decision gates, and brought to its normal terminal/Library state using the UI. Stable IDs remain visible/copyable. The operator does not need to hand-author continuation JSON or invoke operational CLI commands.

## Architectural constraints

- localhost-only personal tool; no auth, accounts, cloud, or multi-user model;
- browser UI plus local Node server; no Electron/Tauri for MVP;
- existing SQLite/research files remain durable truth;
- no `ui.sqlite` or parallel research catalog as truth;
- UI must call application services, not spawn `npm run ...` and parse stdout;
- CLI remains a supported adapter over the same workflow;
- canonical output-root contract remains unchanged;
- immutable generations and operator-config provenance remain immutable;
- polling durable status is sufficient for MVP; SSE/WebSocket is deferred until measured necessary;
- no destructive research deletion in MVP.

---

## U0 — Application boundary

**Status:** active.

### Goal

Make the existing Runner workflow callable safely by non-CLI adapters without duplicating orchestration or requiring config/continuation JSON files merely as an invocation mechanism.

### Scope

- move config-first workflow implementation behind an application-layer module while keeping `research:run` as a thin CLI adapter;
- expose typed application functions for new research and existing-research continuation/resume;
- allow already-parsed operator config and continuation values to reuse the exact existing planner/executor through dependency injection;
- preserve declaring-file-relative path semantics for path-bearing typed inputs;
- expose canonical read-only research inspection through the same application boundary;
- add tests proving typed inputs do not require file-loader reads;
- no HTTP server or React UI yet.

### Result

U1 can build a local server without spawning CLI processes, parsing stdout, inventing durable state, or cloning workflow logic.

---

## U1 — Read-only Research Console

### Scope

- `npm run ui` local Node server + React/Vite shell;
- lightweight research catalog from canonical indexes + `research.json`;
- search by label, `researchId`, and known run IDs;
- filters for attention/running/completed/all;
- Research Detail with IDs, batch count, current run/enrichment, pipeline state, next action;
- batch/run/generation timeline;
- read-only current effective configuration/provenance;
- full expensive status projection only for opened research, not every list row;
- System page with canonical output-root diagnostics.

### Result

The operator can browse and understand all existing researches without terminal/agent assistance.

---

## U2 — Create, execute, resume, repair

### Scope

- New Research form backed by existing OperatorConfig contracts/presets;
- paste/upload research input;
- plan preview before execution;
- create/run from typed config;
- in-process job registry for currently executing operations only;
- durable status polling for progress/restart recovery;
- resume configured discovery/enrichment/finalization through stable `researchId`;
- expose existing explicit repair action only where current Runner rules mark checkpoints repairable.

### Result

New and interrupted research can be operated without CLI commands.

---

## U3 — Research management and batches

### Scope

- rename display label without changing directory, IDs, lineage, or immutable evidence;
- visible/copyable `researchId`, current `runId`, current `enrichmentId`;
- add batch to existing research using current append semantics and locks;
- preflight/preview supplied, new, duplicate, and promoted counts where deterministically available before commit;
- run/resume the resulting current discovery generation;
- batch history and result run IDs;
- optional OS "open output folder" convenience if implementable without weakening portability.

### Result

Long-lived research containers can be maintained from the UI.

---

## U4 — Human gates

### Scope

- shortlist table/selection using existing keyword evidence;
- finalist-scope selection including explicit-all semantics;
- human decision editor with existing decision contract;
- validation before continuation;
- continue the exact existing configured workflow after each gate;
- no automatically invented shortlist/finalist/business decision.

### Result

**MVP complete.** A normal research can be taken end-to-end without hand-authored continuation JSON or a coding agent operating the CLI.

---

## U5 — Configuration UX

### Scope

- ergonomic basic/advanced config editor;
- preset selection and effective-config preview;
- provenance/fingerprints in advanced inspection;
- clone/fork existing research settings into a new research.

Changing immutable `operator-config.json` semantics inside an existing research is explicitly out of scope. If real usage demonstrates a need for per-batch config evolution under one `researchId`, design a versioned config-generation contract first rather than mutating V1 provenance.

---

## U6 — Post-MVP comfort

Only implement from observed personal usage friction:

- richer evidence tables/artifact browser;
- Research Library browser;
- Search Console import/visualization;
- charts;
- richer diagnostics;
- event streaming instead of polling;
- other convenience features supported by repeated operator need.

Do not turn this local personal console into a SaaS/product platform without a separate explicit decision.

---

## Delivery workflow

Every implementation item follows the repository workflow:

```text
implementation
→ PR
→ cold independent review
→ fixes
→ exact-head CI on Ubuntu + Windows
→ final re-review / base-drift / review-thread gate
→ squash merge
```

Keep one bounded capability per PR where practical. Any fix invalidates previous CI evidence.
