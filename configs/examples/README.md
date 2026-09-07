# Operator continuation examples

These files are copy/edit templates for the normal config-first human gates. They do not weaken or automate the gates: the operator still supplies the shortlist, finalist scope, or finalist decisions explicitly.

## Normal human-gate templates

| Planner/status requirement | Template | What the operator must supply |
| --- | --- | --- |
| `shortlist` | `continuation.shortlist.json` | a path to the explicit shortlist file |
| `finalist_scope` | `continuation.finalists.json` | one or more explicit cluster IDs |
| `finalist_scope` | `continuation.finalists-all.json` | deliberate all-cluster selection |
| `human_decisions` | `continuation.decisions.json` | a path to the explicit finalist-decisions file |

For every template:

1. replace `<research-id>` with the stable research ID reported by `research:run` / `research:status`;
2. replace only the human input required by the current gate;
3. keep file paths relative to the continuation JSON file that declares them;
4. validate the continuation before mutation:

```bash
npm run research:plan -- --research <research-id> --continue path/to/continuation.json
```

Then execute the same explicit continuation:

```bash
npm run research:run -- --research <research-id> --continue path/to/continuation.json
```

The planner validates that the continuation targets the exact research and is applicable to its current durable state. A stale, mismatched, or out-of-order continuation is rejected rather than becoming a silent no-op.

## Scope

The continuation contract also supports specialist finalization inputs such as representative overrides, optional traffic evidence, and the explicit publication-without-decisions override. They are intentionally not presented here as ordinary human-gate templates: use them only when the corresponding specialist workflow requires them.

These examples are convenience surfaces only. `OperatorContinuationV1` in `src/operatorConfig/contracts.ts` remains the authoritative typed contract.
