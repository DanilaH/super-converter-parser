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

The U1 browser shell remains focused on inspection while U2 operator forms are built. It can:

- browse researches discovered from the canonical run index;
- search by persisted label, stable `researchId`, current run id, or another indexed run id;
- open one research and inspect its canonical durable status;
- show/copy stable research, current discovery, and current enrichment IDs;
- inspect discovery keyword counts and quality warnings;
- inspect pipeline state and the Runner's current next operator action;
- inspect batch/run history from `research.json`;
- inspect immutable OperatorConfig provenance when available;
- inspect canonical output-root diagnostics.

## U2 execution boundary

The local server also exposes the bounded execution primitives needed by the next browser screens:

- preview a new-research draft through the existing OperatorConfig/preset resolver;
- start a new research from pasted seed keywords using the existing application workflow;
- resume an existing configured research by stable `researchId`;
- poll ephemeral in-process job state and the canonical workflow result.

Mutation requests are deliberately stricter than reads: they require `POST`, `Content-Type: application/json`, and a same-origin loopback `Origin` using the actual UI port. Request bodies are bounded. An unrelated webpage cannot drive localhost research operations merely because the Runner UI is open.

Only one UI execution job is admitted at a time. The job registry is RAM-only convenience state, not durable Runner truth. Restarting the UI can therefore forget an in-process job record, but the research itself is recovered from the existing durable SQLite/index/status contracts.

New-research seed text is materialized only into a temporary local workspace long enough for the normal seed loader/workflow to consume it; that workspace is removed after execution. OperatorConfig provenance and research evidence keep their existing semantics.

Repair, batch mutation, rename, and human-gate editing are not part of this execution-boundary slice.

## Truth model

The console does not have a UI database. Existing Runner SQLite/research files and indexes remain truth.

The research list is deliberately lightweight: it reads canonical run indexes and `research.json` rather than executing full deep status inspection for every row. Full status is built only when a research is opened.

Historical indexed runs without a durable `research.json` container are shown independently; the console does not invent lineage between them.

## Roadmap

See [`UI_ROADMAP.md`](./UI_ROADMAP.md) for the active U0–U6 sequence. U4 is the MVP completion gate for operating a normal research end-to-end without hand-authored continuation JSON or a coding agent driving the CLI.
