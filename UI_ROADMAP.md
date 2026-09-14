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

**Status:** implemented through U3.2; U3.3 is optional comfort and not an MVP gate.

### U3.1 — mutable display label

**Status:** complete; merged in PR #169.

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

**Status:** complete; merged in PR #170.

Implemented scope:

- add a read-only append preview for existing managed researches with supplied-line, normalized-unique, new, already-known, and promoted-root counts;
- derive preview from the current terminal discovery generation without writing batch/fork state;
- make preview advisory only and recompute authoritative append state after acquiring the canonical composite `execution → batch` research lock;
- materialize pasted browser seeds through a temporary CSV and the existing seed loader/normalizer rather than inventing downstream seed semantics;
- fail closed for historical/indexed researches without a managed `research.json` container instead of implicitly adopting them through the UI;
- reuse the existing `prepareResearchAppend` fork/promotion/evidence-carry-forward implementation for commit;
- persist duplicate-only batches as history without allocating a pointless new discovery generation;
- keep the composite lock through collection of a newly forked current discovery generation;
- invoke discovery directly with `manageProcessSignals: false` and do not implicitly enter enrichment/finalization;
- expose a distinct `append_batch` ephemeral job/result rather than fabricating a config-first workflow result;
- expose same-origin JSON plan/commit endpoints and a managed Research Detail batch editor with mandatory preview invalidation and canonical discovery polling;
- preserve batch lineage/result run IDs and immutable old generations exactly as the existing append contract defines them;
- add research/application/job/HTTP/browser regressions, including preview-versus-commit classification parity.

### U3.3 — optional local folder convenience

**Status:** optional/deferred unless personal usage makes it useful.

Only add an OS "open research output folder" action if it remains a tiny portable convenience. It must never become a requirement for operating the research or a new path-selection mechanism.

### Result

Long-lived managed research containers can be renamed and extended with new batches from the UI. U3.3 is not required for MVP completion.

---

## U4 — Human gates

**Status:** complete; U4.1–U4.3 merged through PR #173.

### U4.1 — explicit shortlist selection

**Status:** complete; merged in PR #171.

Implemented scope:

- expose shortlist candidate evidence only when the canonical existing-research plan reports unresolved `shortlist` input;
- project candidates from the current discovery run through the existing Runner candidate/scoring implementation rather than introduce UI scoring;
- show explicit evidence fields including keyword, volume, Score, Tier, organic count, median DR, weak-domain count, and scoring completeness;
- preserve missing/unscored/degraded evidence without converting it to zero or a recommendation;
- require 5–200 unique normalized keywords from the current discovery generation, matching the existing enrichment shortlist contract;
- preselect nothing and provide filtering/select-visible controls as presentation convenience only;
- bind the submitted selection to its `discoveryRunId` and reject candidate membership/generation drift;
- materialize a temporary canonical `keyword` CSV only long enough to resolve the existing shortlist `OperatorContinuationV1` action;
- continue through the existing `executeExistingResearch` config-first workflow;
- repeat discovery-generation validation through an injected status guard while the existing workflow holds its canonical per-research execution lock;
- remove the temporary shortlist workspace after execution while the resulting enrichment run persists its own canonical shortlist scope;
- expose a distinct `shortlist_research` ephemeral job label while retaining the normal `ResearchRunExecution` workflow result;
- add application, HTTP, and browser regressions without introducing a durable UI selection store.

### U4.2 — finalist scope

**Status:** complete; merged in PR #172.

Implemented scope:

- expose finalist scope only when the canonical existing-research plan reports unresolved `finalist_scope` input;
- read current persisted cluster identity/evidence from the completed current enrichment rather than derive a UI-only cluster model;
- require the same current clustering algorithm/version, URL identity, complete-link grouping, completed cluster checkpoint, and concrete keyword identities that representative finalization already requires;
- show canonical keyword, exact cluster ID, membership/volume/cohesion context, member keywords, and representative domains without scoring or recommendation;
- preserve persisted cluster order and preselect nothing;
- support a non-empty exact selected-cluster mode mapping to canonical `finalists` continuation;
- preserve the distinct explicit-all action by mapping `Use all` to canonical `finalists_all` instead of expanding it into a UI-selected ID list;
- reject unknown, duplicate, blank, or whitespace-mutated explicit cluster IDs rather than normalize identities;
- bind submission to the displayed current enrichment;
- repeat research/discovery/enrichment identity and unopened `finalization:not_started` validation through a workflow status guard under the existing execution lock;
- fail closed when lineage or finalization state advances while the operator is looking at the gate;
- continue through the existing configured finalization workflow rather than add a UI finalization state machine;
- expose a distinct `finalist_scope_research` ephemeral job label while preserving normal `ResearchRunExecution` results;
- add application, HTTP, and browser regressions with no durable UI finalist-selection store.

### U4.3 — human decisions and terminal continuation

**Status:** complete; merged in PR #173.

Implemented scope:

- expose the exact existing decision contract rather than invent a UI vocabulary: `buildDecision = build | watch | reject | unknown | null` and `seoProductRole = acquisition_anchor | strong_supporting_tool | completeness_tool | experimental | not_applicable | null`;
- show every current finalist from the current published finalist-evidence matrix together with the current persisted decision, evidence context, and audit flags;
- prefill only already-persisted current decisions; never auto-select business judgment;
- preserve canonical partial-decision semantics: either non-null field records a decision, while a row with both fields null remains unresolved and leaves finalization at `awaiting_decisions`;
- submit exactly one row for every current finalist so the existing replace-style durable decision write cannot accidentally erase previously recorded decisions; undecided rows remain explicit null/null adapter rows and are filtered by the canonical persistence layer;
- bind the browser submission to current discovery run, enrichment, representative revision, entrant fingerprint, and persisted decision-state timestamp;
- require the current finalist matrix to remain published/current and the exact finalist membership to remain unchanged;
- repeat discovery/enrichment/finalization/matrix/representative/entrant/decision-state/finalist-membership validation through an injected status/evidence guard while the existing workflow holds its canonical execution lock;
- materialize only a temporary raw decisions JSON array, resolve the existing `OperatorContinuationV1` `decisions` action, and `return await` the same `executeExistingResearch` workflow before removing the temporary workspace;
- let existing configured finalization own terminal behavior: partial decisions remain `awaiting_decisions`; all-current decisions proceed through the existing Library publication step without a UI publication state machine;
- expose read + same-origin bounded JSON mutation endpoints and a separate CSP-safe browser specialist module with a distinct `decisions_research` ephemeral workflow job;
- keep SQLite/current Runner files as the only durable truth and add application, stale-lineage, HTTP, mutation-security, and browser regressions.

### Result

The stated UI MVP Definition of Done is met. A normal config-first research can now be operated end-to-end through the local UI without hand-authored continuation JSON or a coding agent driving the CLI. Remaining U5/U6 work is post-MVP configuration/comfort scope and should be driven by observed operator friction rather than treated as an operability blocker.

---

## Post-MVP hardening — browser coordination

**Status:** complete; merged in PR #175. Exact-head CI #934 passed on Ubuntu and Windows.

This is a bounded correctness/robustness slice discovered by independent review of the completed MVP. It does **not** reopen U5/U6 scope.

Implemented scope:

- remove obsolete U2.3 placeholder copy from Research Detail;
- remove the repair specialist's duplicate full Research Detail request and reuse the already-rendered canonical deep-status projection;
- derive the active explicit human gate directly from canonical `buildExistingResearchPlan(...).unresolvedHumanRequirements`, exposing only `shortlist`, `finalist_scope`, `human_decisions`, or null to Research Console clients;
- publish a small ephemeral machine-readable Research Detail projection (`researchId`, canonical human requirement, next-action code, repairable count) so independently loaded specialist modules no longer parse English UI labels/copy;
- keep that browser projection non-authoritative and disposable; all mutation endpoints/application services retain canonical revalidation and lock checks;
- ensure non-human fail-closed blocked stages are not misclassified as finalist/shortlist gates merely because they lack an executable command;
- show shortlist/finalist/decision gate-load failures with an explicit reload action instead of silently hiding an active canonical gate;
- handle malformed percent-encoded research hashes without throwing out of the router;
- add planner-projection and browser-contract regressions, including a non-human blocked-finalization case.

Independent precheck also revalidated the pre-existing derived Library snapshot-repair path and found it already correct through `operatorConfig/planner.ts` plus configured finalization; no Library workflow change is included in this PR.

Explicitly not included:

- finalist-decision persistence/revision redesign;
- automatic scoring/recommendations;
- configuration UX, GSC, charts, Library browsing, React/Electron, or other U5/U6 comfort work;
- any new durable UI database or publication state machine.

---

## Post-MVP operator ergonomics — single workspace and zero-terminal discovery

**Status:** complete; merged in PR #179. Exact-head CI #977 passed on Ubuntu and Windows.

This slice is driven by observed first-use friction, not speculative U5/U6 expansion. The operator reported that Chrome startup was unclear/manual, seed entry was unnecessarily text-only, and primary work was spread across too many screens.

Implemented scope:

- replace primary Researches/New/System full-screen navigation with a persistent split workspace: lightweight research/search/machine/job rail on the left and the selected work surface on the right;
- keep existing hash routes only as deep-link/state mechanics so specialist human-gate modules and durable workflow semantics remain unchanged;
- keep the research rail lightweight by continuing to use the catalog projection rather than deep-inspecting every research;
- expose Research Chrome status and one-time `Setup once` in the persistent rail; normal operation does not ask the operator to decide whether to press a separate Chrome Start button;
- add a just-in-time Research Chrome discovery preflight for normal new-research execution: connected Chrome is reused, a prepared managed local profile is started automatically, missing first-time setup fails clearly, invalid configuration fails clearly, and valid unsupported/remote CDP ownership remains external;
- apply the same preflight to batch append only after a current read-only batch classification proves discovery work is actually required, so duplicate-only batches do not open Chrome;
- apply the same preflight inside the already-admitted UI job before canonical `resume_discovery` and explicit `repair_discovery`, while enrichment/finalization/Library continuation deliberately skips Chrome startup;
- add TXT/CSV/JSON file picker and drag-and-drop convenience to new-research and batch seed editors while retaining normal paste/edit flow and canonical preview/normalization;
- keep CSV semantics aligned with the existing required `keyword` column and restrict JSON to explicit string-array shapes rather than guessing arbitrary schemas;
- keep new browser assets on the server's explicit static allowlist and preserve the existing CSP/same-origin mutation boundary;
- add browser/parser/execution regressions for split layout, file import, static-asset serving, Chrome preflight, continuation/repair gating, and batch ordering.

Cold review corrections within the slice:

- new static assets were added to the explicit server allowlist rather than broadening static-file serving;
- a prepared-but-disconnected Chrome state is visually distinct from a healthy CDP connection;
- duplicate-only batch append skips Chrome preflight;
- the first JIT cut covered new/batch execution, but cold review found that `resume_discovery` and `repair_discovery` would reintroduce manual Chrome/terminal friction; both now preflight inside their admitted UI jobs while non-discovery continuation does not;
- malformed/invalid Research Chrome configuration fails at the preflight boundary instead of being mistaken for externally managed CDP;
- optional Chrome discovery options are normalized explicitly to satisfy strict `exactOptionalPropertyTypes` rather than weakening compiler settings;
- workspace static-asset regression uses exact allowlist strings rather than a dynamically constructed regular expression that could fail independently of runtime behavior.

Subsequent operator-guidance hardening is intentionally still part of this same observed-friction track rather than a new Runner workflow:

- New Research keeps plan preview automatic/advisory and exposes one primary `Start discovery` action; mutation still performs a fresh plan validation immediately before create;
- the running create job automatically opens Research Detail as soon as durable identity exists;
- preview stages use operator-facing sequencing (`Starts now`, `After discovery`, `After enrichment`) rather than presenting expected future stages as blocked errors;
- Research Detail owns a single Workflow focus panel that explains the next action and places the ordinary continuation CTA beside that explanation;
- shortlist/finalist/decision steps use direct stage actions (`Start enrichment`, `Start finalization`, `Finish research`), sticky action footers for long evidence lists, and retryable transient-error handling that preserves the current browser selection;
- finalist scope visually promotes `all` only while no explicit selection exists, then promotes the explicit-selected action once the operator selects clusters;
- one-time Research Chrome setup immediately attempts browser start, while later discovery owns just-in-time launch; a post-setup launch failure is reported as a launch failure rather than falsely telling the operator that setup failed;
- UI contract tests assert the actual preview render path and retry/CTA behavior, avoiding string-presence tests that can pass while the visible wiring is wrong.

Explicitly not included:

- a new UI database or durable navigation state;
- React/Electron migration;
- automatic shortlist/finalist/business decisions;
- eager Chrome launch merely from opening `npm run ui`;
- Stop/Kill/general process control;
- broad U5/U6 configuration, Library, GSC, or analytics work.

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
