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

**Status:** complete; merged in PR #164.

### Goal

Make the existing Runner workflow callable safely by non-CLI adapters without duplicating orchestration or requiring config/continuation JSON files merely as an invocation mechanism.

### Implemented scope

- moved config-first workflow implementation behind `src/application/researchWorkflow.ts` while keeping `research:run` as a thin CLI adapter/re-export;
- exposed typed application functions for new research and existing-research continuation/resume;
- allowed already-parsed operator config and continuation values to reuse the exact existing planner/executor through dependency injection;
- preserved declaring-file-relative path semantics for path-bearing typed inputs;
- exposed canonical read-only research inspection through the same application boundary;
- runtime validation accepts `unknown` adapter inputs rather than trusting HTTP/UI shapes at compile time;
- added tests proving typed inputs do not require file-loader reads.

### Result

Non-CLI adapters can reuse the canonical workflow without spawning CLI processes or inventing durable state.

---

## U1 — Read-only Research Console

**Status:** complete; merged in PR #165.

### Implemented scope

- `npm run ui` localhost-only Node server plus a dependency-free browser shell;
- lightweight research catalog from canonical run indexes + `research.json`;
- search by label, `researchId`, and known run IDs;
- Research Detail with visible/copyable IDs, batch count, current run/enrichment, pipeline state, next action, keyword counts, and quality warnings;
- batch/run history from durable research-container lineage;
- read-only current immutable OperatorConfig provenance;
- full expensive status projection only for an opened research, never for every list row;
- System page with canonical output-root diagnostics;
- historical indexed runs without a durable research container remain independent instead of receiving invented lineage.

A React/Vite dependency surface was deliberately not required for these screens. Re-evaluate the browser framework only when actual UI interaction complexity justifies it.

Attention/running/completed list filters remain deferred until a cheap truthful catalog-level state projection exists. Do not obtain them by running full deep status for every row and do not infer them from timestamps or directory names.

### Result

The operator can browse, search, open, and understand existing researches without terminal/agent assistance while the list remains a lightweight projection of durable identity rather than a second status engine.

---

## U2 — Create, execute, resume, repair

**Status:** complete; merged through PR #168.

### U2.1 — safe execution boundary

**Status:** complete; merged in PR #166.

Implemented scope:

- require same-origin loopback `Origin` validation for mutation endpoints;
- require bounded JSON POST bodies for mutations;
- parameterize inherited discovery/enrichment process-signal ownership so the long-lived UI host does not register per-job CLI signal handlers while CLI defaults remain unchanged;
- preview a new-research draft through existing OperatorConfig/preset contracts;
- accept pasted seed keywords through a temporary workspace and the normal seed loader rather than inventing a UI input format downstream;
- execute new research and resume existing configured research through the exact application workflow;
- keep an in-memory, bounded job registry for active/recent UI execution only;
- admit one UI execution at a time while existing Runner locks remain authoritative;
- lose job convenience state safely on server restart while durable research state remains recoverable from canonical status/index/SQLite truth.

### U2.2 — operator create/resume screens

**Status:** complete; merged in PR #167.

Implemented scope:

- New Research route/form backed by the U2.1 draft contract;
- built-in preset selection plus optional research locale overrides, without new configuration semantics;
- mandatory plan preview before execution and invalidation after every draft change;
- pasted seed input with truthful supplied-line versus discovery-normalized-unique counts;
- resolved workflow/stage/preset/discovery/enrichment/external-work/human-stop preview;
- start one in-process research job and poll bounded ephemeral job state;
- surface the durable research identity during long-running creation while canonical detail is polled independently;
- keep ordinary Research Detail panels usable during an active job rather than blocking the page behind job completion;
- expose ordinary config-first continuation only from the canonical executable `nextAction` projection;
- keep repair and human-input gates explicitly unavailable rather than reinterpreting them as ordinary resume;
- recover after browser/server restart from durable research status rather than depending on remembered job state;
- regression-check the browser preset selector against canonical `configs/presets/*.json` files.

The dependency-free browser shell remains sufficient for this scope; adding React/Vite here would add maintenance surface without solving a demonstrated problem.

### U2.3 — explicit discovery repair

**Status:** complete; merged in PR #168.

Implemented scope:

- add a typed application repair action over the existing discovery `retryFailed` behavior rather than routing repair through OperatorContinuation;
- authorize repair only from canonical `nextAction.code === repair_discovery` and `repairable > 0`;
- acquire the existing per-research execution lock and repeat canonical eligibility checks under the lock before mutation;
- fail closed if repairability disappears or the current discovery generation changes while waiting for the lock;
- invoke the existing discovery resume path with `retryFailed: true` while the long-lived UI host retains process-signal ownership;
- expose a distinct `repair_discovery` ephemeral job/result surface instead of fabricating a config-first workflow result;
- add a dedicated same-origin JSON mutation endpoint and a separate Research Detail specialist repair action;
- preserve ordinary Continue as a disjoint allowlist that still excludes repair and human-input gates;
- refresh durable canonical status after repair completion;
- add application, job, HTTP, and browser regressions for repair eligibility and separation from ordinary continuation.

### Result

New and interrupted research plus explicit discovery repair can be operated without CLI commands while repair remains explicit rather than implicit.

---

## U3 — Research management and batches

**Status:** active; delivered as bounded mutation slices.

### U3.1 — mutable display label

**Status:** complete in PR #169.

Implemented scope:

- treat `research.json.label` as mutable display metadata while immutable OperatorConfig provenance retains the original configured label;
- rename without changing the research directory/original slug, `researchId`, current/known run IDs, batches, lineage, or immutable evidence;
- atomically rewrite only `label` and `updatedAt` in the validated managed research container;
- serialize rename against continuation and append using the existing composite `execution → batch` research lock;
- make same-label rename idempotent without rewriting `updatedAt`;
- refresh `results.zip` best-effort after the durable metadata commit, reporting archive failure as a warning rather than making the committed rename retryable;
- expose strict same-origin JSON label mutation and a managed-research-only browser inline editor;
- keep historical/legacy layouts non-renameable through this managed metadata action.

### U3.2 — batch preview, append, and resulting discovery

**Status:** next.

Scope:

- add batch to an existing managed research using the current append/fork semantics and canonical composite locks;
- accept pasted seeds through a temporary input artifact rather than inventing downstream seed semantics;
- preflight/preview supplied, new, duplicate, and promoted counts where those values can be derived without committing the batch;
- keep preview advisory and recompute authoritative counts under lock at commit time;
- create the batch/fork using the existing research append implementation rather than cloning it in the UI layer;
- run/resume the resulting current discovery generation and expose durable progress through existing job/status polling;
- preserve batch history and result run IDs exactly as the current research container contract defines them.

Do not combine U3.2 with human gates or configuration evolution.

### U3.3 — optional local folder convenience

Only add an OS "open research output folder" action if it remains a tiny portable convenience after U3.2. It must never become a requirement for operating the research or a new path-selection mechanism.

### Result

When U3.2 closes, long-lived research containers can be renamed and extended from the UI. U3.3 is optional comfort and is not an MVP gate.

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
