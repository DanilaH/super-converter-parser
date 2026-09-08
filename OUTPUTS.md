# Canonical Durable Output Contract

## Purpose

Utility Research Runner has exactly one canonical durable output root for ordinary operation.

Agents, worktrees, shells, and specialist CLIs must not invent their own output directories. The filesystem location of research evidence is application policy, not an agent preference.

## Canonical root

Resolution order for ordinary operation is:

```text
RESEARCH_OUTPUT_ROOT (when explicitly configured once)
        ↓
<user-home>/super-converter-parser-output
```

`RESEARCH_OUTPUT_ROOT` must be absolute. It configures the **whole Runner**, not one command or one agent session.

Inspect the effective location with:

```bash
npm run outputs:where
npm run outputs:where -- --json
```

Diagnose legacy repo-local output folders with:

```bash
npm run outputs:doctor
npm run outputs:doctor -- --json
```

## Canonical layout

New durable writes use this namespace layout:

```text
<canonical-root>/
├── researches/
│   └── YYYY-MM-DD-<research-slug>/
│       ├── discovery/
│       ├── enrichment/
│       └── results.zip
├── index/
│   ├── runs/
│   └── enrichments/
├── research-library/
└── first-party-search/
```

Additional internal durable namespaces may be added only by Runner code and must remain under the same canonical root.

Research folders are allocated only under `researches/`. Agents must never construct research paths themselves.

## `--output-root` policy

`--output-root` is **not an ordinary operator/agent choice**.

If a command supplies an `--output-root` different from the canonical root, Runner fails closed unless the explicit escape hatch is enabled:

```text
RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE=true
```

That environment variable is reserved for an intentional migration/test operation. It must not be enabled by an agent merely to make a command convenient or to keep outputs near its current worktree.

An `--output-root` equal to the already configured canonical root is harmless but unnecessary.

## Agent rules

Agents must:

1. use the application-resolved canonical root;
2. run `npm run outputs:where` when they need to report or verify the physical location;
3. never create ad-hoc `runs/`, `enrichments/`, `output/`, `results/`, or similar research-output folders inside a worktree;
4. never set `RESEARCH_OUTPUT_ROOT` per task merely to redirect one run;
5. never enable `RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE` without an explicit migration/test requirement from the user;
6. refer to research by stable `researchId` / persisted indexes rather than guessing paths.

## Backward compatibility

This contract applies to **new writes**.

Existing indexed research directories created before the `researches/` namespace remain valid because indexes persist their exact paths. Legacy `./runs/<id>` and `./enrichments/<id>` fallback reads remain supported where the current resolver already supports them.

No automatic migration, move, rename, or deletion of historical output directories is performed.

`outputs:doctor` may warn about repo-local legacy directories, but warnings do not mutate them.

## Truth and portability

SQLite remains durable evidence truth. Output indexes remain the path-resolution authority for indexed runs/enrichments.

The canonical root is intentionally outside git/worktrees by default so multiple agents/worktrees converge on the same durable state rather than producing isolated copies.
