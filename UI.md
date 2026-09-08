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

## Current U1 surface

The current console is intentionally read-only. It can:

- browse researches discovered from the canonical run index;
- search by persisted label, stable `researchId`, current run id, or another indexed run id;
- open one research and inspect its canonical durable status;
- show/copy stable research, current discovery, and current enrichment IDs;
- inspect discovery keyword counts and quality warnings;
- inspect pipeline state and the Runner's current next operator action;
- inspect batch/run history from `research.json`;
- inspect immutable OperatorConfig provenance when available;
- inspect canonical output-root diagnostics.

It does not create, resume, repair, rename, append, finalize, publish, or otherwise mutate research state yet. Non-GET API requests fail closed.

## Truth model

The console does not have a UI database. Existing Runner SQLite/research files and indexes remain truth.

The research list is deliberately lightweight: it reads canonical run indexes and `research.json` rather than executing full deep status inspection for every row. Full status is built only when a research is opened.

Historical indexed runs without a durable `research.json` container are shown independently; the console does not invent lineage between them.

## Roadmap

See [`UI_ROADMAP.md`](./UI_ROADMAP.md) for the active U0–U6 sequence. U4 is the MVP completion gate for operating a normal research end-to-end without hand-authored continuation JSON or a coding agent driving the CLI.
