# Config-First Operator Acceptance

## Status

This document is the acceptance record for **PR G** from `CONFIG_FIRST_OPERATOR_UX_PLAN.md`.

PR G is not a feature-expansion phase. Its purpose is to prove that the config-first operator path can replace remembered CLI sequences without changing accepted discovery, enrichment, finalization, cache, durable-state, or human-decision semantics.

GUI work remains blocked until the deterministic gates pass in CI **and** the live operator-machine acceptance below is completed with Research Chrome + Keyword Surfer.

## 12 source-of-truth gates

| # | Gate | Deterministic evidence | Live acceptance |
|---|---|---|---|
| 1 | Create a new research from a config | `src/cli/researchRun.test.ts`, `src/cli/researchRun.acceptance.test.ts` | Required |
| 2 | Inspect the dry-run first | `src/cli/researchPlan.test.ts`, `src/cli/researchRun.acceptance.test.ts` | Required |
| 3 | Execute discovery | `src/cli/researchRun.test.ts`, acceptance lifecycle | Required with real Chrome/Surfer |
| 4 | Capture the stable research ID | `src/cli/researchRun.test.ts`, acceptance lifecycle | Required |
| 5 | Continue that exact research after a human gate without copying run/enrichment IDs | `src/cli/researchRun.enrichment.test.ts`, acceptance lifecycle | Required |
| 6 | Stop truthfully at each missing human input | shortlist tests + finalist-scope/decision tests + acceptance lifecycle | Required for every applicable live gate |
| 7 | Continue finalization after explicit choices | `src/cli/researchRun.finalization.test.ts`, acceptance lifecycle | Required through normal human decisions |
| 8 | Rerun/reuse caches safely | `src/cli/researchRun.cacheAcceptance.test.ts` | Required: second fresh run must reuse cache without reusing research identity |
| 9 | Inspect `research:status` and machine JSON | existing status/planner/run machine contracts + acceptance lifecycle | Required |
| 10 | Stage fingerprints do not trigger unrelated upstream invalidation | `src/operatorConfig/resolve.test.ts`, preset parity tests | Required spot-check from persisted provenance |
| 11 | Compare config-first vs legacy semantic/core behavior deterministically | `src/cli/researchRun.test.ts` discovery parity; shared enrichment/finalization application-service contracts | CI required; architecture changes only for an observed defect |
| 12 | Secrets/machine settings/absolute machine paths stay out of semantic identity/snapshots where they do not belong | provenance tests + `src/cli/researchRun.portabilityAcceptance.test.ts` + legacy secret-leak guard | Required spot-check of `operator-config.json` |

A gate is not accepted merely because a similarly named unit test exists. The acceptance tests exercise public config-first planner/runner entrypoints and immutable provenance boundaries. Provider/browser-dependent behavior is additionally checked on the operator machine.

## Live acceptance fixture

Use:

```text
configs/acceptance/pr-g-live/research.config.json
configs/acceptance/pr-g-live/seeds.csv
```

The fixture intentionally uses `finalist-validation@1` but overrides discovery expansion to `false`. This keeps the live smoke bounded while still exercising real Google + Keyword Surfer discovery, local clustering, finalization evidence, Common Crawl sampled historical presence, human decisions, and Library publication.

Do **not** add a special acceptance-only runtime path. The commands below are the normal product commands.

## Live operator-machine procedure

Run from the repository root on the normal Research Chrome machine.

### 0. Isolate acceptance state

PowerShell example:

```powershell
Remove-Item -Recurse -Force .tmp/pr-g-live-output -ErrorAction SilentlyContinue
Remove-Item -Force .tmp/pr-g-live-cache.sqlite -ErrorAction SilentlyContinue
$env:CACHE_DB_PATH = "$PWD/.tmp/pr-g-live-cache.sqlite"
```

Keep the normal machine/runtime settings for Research Chrome, Keyword Surfer, provider timeouts, and credentials. They must not be copied into the operator JSON.

### 1. Plan before execution

```powershell
npm run research:plan -- --config configs/acceptance/pr-g-live/research.config.json --json
```

Acceptance:

- `stateContext.kind = new`;
- preset identity is `finalist-validation@1`;
- discovery is `ready`;
- enrichment/finalization are blocked on missing durable parents rather than pretended-ready;
- the command creates no research state and invokes no browser/provider work.

### 2. Execute the first fresh config-first research

```powershell
npm run research:run -- --config configs/acceptance/pr-g-live/research.config.json --output-root .tmp/pr-g-live-output --json
```

Record the final machine JSON and its `researchId` as **PRIMARY_RESEARCH_ID**.

Acceptance:

- exit code `0`;
- discovery is exactly `completed` (not `completed_with_errors`);
- no CAPTCHA regression;
- clustering completes;
- workflow stops at `awaiting_finalist_scope`;
- unresolved human requirement is exactly `finalist_scope`;
- `operator-config.json` exists before downstream continuation;
- no human choice was invented.

### 3. Inspect read-only status and plan

```powershell
npm run research:status -- --research <PRIMARY_RESEARCH_ID> --output-root .tmp/pr-g-live-output --json
npm run research:plan -- --research <PRIMARY_RESEARCH_ID> --output-root .tmp/pr-g-live-output --json
```

Acceptance:

- both resolve the same stable research without an enrichment ID;
- discovery/enrichment identities are read from durable state;
- plan still reports `finalist_scope` as the missing human requirement;
- read-only commands do not mutate timestamps, generations, decisions, or publication state.

### 4. Prove shared-cache reuse with a second fresh research

Run the same config again with the same `CACHE_DB_PATH`:

```powershell
npm run research:run -- --config configs/acceptance/pr-g-live/research.config.json --output-root .tmp/pr-g-live-output --json
```

Acceptance:

- a **different** `researchId` is allocated;
- stage/effective semantic fingerprints match the first research;
- the five compatible discovery keywords are served from cache;
- no Research Chrome navigation/preflight is needed for fully cached browser evidence;
- the first research remains untouched.

Continue all downstream acceptance using **PRIMARY_RESEARCH_ID**, not the second cache-smoke research.

### 5. Supply explicit finalist scope

Create `.tmp/pr-g-finalists.json`:

```json
{
  "version": 1,
  "researchId": "<PRIMARY_RESEARCH_ID>",
  "action": {
    "type": "finalists_all"
  }
}
```

Plan it first:

```powershell
npm run research:plan -- --research <PRIMARY_RESEARCH_ID> --continue .tmp/pr-g-finalists.json --output-root .tmp/pr-g-live-output --json
```

Then execute:

```powershell
npm run research:run -- --research <PRIMARY_RESEARCH_ID> --continue .tmp/pr-g-finalists.json --output-root .tmp/pr-g-live-output --json
```

Acceptance:

- continuation targets only the stable research ID; it contains no run/enrichment IDs;
- planner shows finalization ready against the current completed enrichment;
- accepted finalization evidence is produced without changing discovery/enrichment semantics;
- workflow stops at `awaiting_decisions`;
- no publication is represented as human-complete yet.

If the fixture unexpectedly produces zero clusters, that is a live-fixture failure: record it and replace the seed fixture with another small coherent set. Do not weaken the finalist contract.

### 6. Inspect finalist evidence and make real human decisions

Locate the current enrichment directory from `research:status`. Inspect:

```text
finalist-evidence-matrix.json
finalist-evidence-matrix.csv
```

Create `.tmp/pr-g-decisions.json` as a JSON array with **one row for every current finalist**. Example shape only:

```json
[
  {
    "clusterId": "<actual cluster id>",
    "buildDecision": "watch",
    "seoProductRole": "experimental"
  }
]
```

Allowed `buildDecision` values are `build`, `watch`, `reject`, `unknown`, or `null`. Allowed `seoProductRole` values are `acquisition_anchor`, `strong_supporting_tool`, `completeness_tool`, `experimental`, `not_applicable`, or `null`.

These must be genuine operator decisions from the current finalist evidence. Do not auto-generate them merely to make acceptance pass.

Create `.tmp/pr-g-decisions-continuation.json`:

```json
{
  "version": 1,
  "researchId": "<PRIMARY_RESEARCH_ID>",
  "action": {
    "type": "decisions",
    "path": "pr-g-decisions.json"
  }
}
```

The path is relative to the continuation JSON that declares it.

### 7. Plan and execute the human-decision continuation

```powershell
npm run research:plan -- --research <PRIMARY_RESEARCH_ID> --continue .tmp/pr-g-decisions-continuation.json --output-root .tmp/pr-g-live-output --json
npm run research:run -- --research <PRIMARY_RESEARCH_ID> --continue .tmp/pr-g-decisions-continuation.json --output-root .tmp/pr-g-live-output --json
```

Acceptance:

- all decisions match the current finalist scope;
- stale/mismatched decision scope fails closed rather than being partially applied;
- successful current decisions allow normal Library publication;
- machine result becomes `workflowState = completed`, `stopPoint = complete`, `finalizationState = published`;
- publication has a non-null `publicationId`.

### 8. Final status and provenance audit

```powershell
npm run research:status -- --research <PRIMARY_RESEARCH_ID> --output-root .tmp/pr-g-live-output --json
npm run research:plan -- --research <PRIMARY_RESEARCH_ID> --output-root .tmp/pr-g-live-output --json
```

Acceptance:

- discovery/enrichment remain satisfied, not rerun;
- finalization is published and plan stop point is complete;
- human decision count equals finalist count;
- `operator-config.json` retains exact preset snapshot + effective semantics;
- its semantic fingerprints are unchanged by finalist/decision continuation;
- it contains no API key, CDP URL, cache path, timeout setting, or absolute source-config path.

## PR G completion rule

PR G can merge only when:

1. exact-head Ubuntu and Windows CI pass strict TypeScript and the full test suite;
2. cold review finds no semantic blocker or open review thread;
3. the live operator-machine procedure above is completed on the same PR head (or a later exact head after fixes);
4. any failure is classified as either a real product defect or a bad acceptance fixture; product contracts are not weakened merely to turn a check green.

After PR G passes, the config-first track may proceed to PR H, the intentionally small local GUI.
