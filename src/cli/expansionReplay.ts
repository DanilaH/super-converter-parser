import process from 'node:process';
import { resolve } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { RunStore, type StoredRun } from '../db/store.js';
import { resolveOutputRoot, resolveRunLocation } from '../outputs/researchLayout.js';
import { buildCandidates, resolveDrThresholds } from '../scoring/scoring.js';
import { EXPANSION_ADMISSION_VERSION } from '../runs/expansionAdmission.js';
import {
  buildExpansionReplay,
  expansionReplayChildKeywords,
  expansionReplayOriginalKeywords,
  type ExpansionReplayResult,
} from '../runs/expansionReplay.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  runId: string;
  outputRoot: string | null;
  json: boolean;
};

type ExpansionSnapshot = NonNullable<StoredRun['configSnapshot']['expansion']> & {
  admissionVersion?: string;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

export function parseExpansionReplayArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, runId: '', outputRoot: null, json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--run') parsed.runId = nextValue(args, '--run');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help && parsed.runId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--run <run-id> is required.');
  }
  return parsed;
}

function printUsage(): void {
  console.log('Expansion Admission Offline Replay');
  console.log('');
  console.log('Usage:');
  console.log('  npm run expansion:replay -- --run <run-id>');
  console.log('  npm run expansion:replay -- --run <run-id> --json');
  console.log('');
  console.log('Options:');
  console.log('  --run <run-id>          Completed or preserved V1 discovery run to replay.');
  console.log('  --output-root <path>    Durable research output root.');
  console.log('  --json                  Print the full deterministic machine-readable replay.');
  console.log('  --help, -h              Show this help.');
  console.log('');
  console.log('Read-only: selection variants use only persisted pre-SERP Related evidence.');
  console.log('Child SERP/scoring evidence is evaluator-only; uncollected counterfactuals stay unknown.');
}

export function renderExpansionReplay(result: ExpansionReplayResult): string {
  const lines = [
    'Expansion Admission offline replay',
    `  Run: ${result.runId}`,
    `  Admission: ${result.admissionVersion}`,
    `  Roots: ${result.originalKeywordCount}`,
    `  Raw candidates: ${result.rawCandidateCount}`,
    `  Eligible candidates: ${result.eligibleCandidateCount}`,
    `  Budget: ${result.budget}`,
  ];

  for (const variant of result.variants) {
    const postHoc = variant.postHocObservedOnly;
    lines.push(
      '',
      `${variant.id}`,
      `  ${variant.description}`,
      `  Selected: ${variant.selectedCount}`,
      `  Broadening-only: ${variant.preSerp.broadeningOnlyCount}/${variant.selectedCount} (${formatPercent(variant.preSerp.broadeningOnlyPercent)})`,
      `  Parent support tiers: t2=${variant.preSerp.parentSupportTierCounts.tier2} t1=${variant.preSerp.parentSupportTierCounts.tier1} t0=${variant.preSerp.parentSupportTierCounts.tier0}`,
      `  Related overlap median: ${formatNumber(variant.preSerp.medianBestOverlap)}`,
      `  Related volume: known=${variant.preSerp.knownRelatedVolumeCount}, median=${formatNumber(variant.preSerp.medianMaxRelatedVolume)}, sum=${formatNumber(variant.preSerp.sumMaxRelatedVolume)}`,
      `  vs V1: retained=${variant.versusV1.retainedCount}, added=${variant.versusV1.addedCount}, removed=${variant.versusV1.removedCount}, jaccard=${formatRatio(variant.versusV1.jaccard)}`,
      `  Post-hoc durable children: ${postHoc.durableChildCount}/${variant.selectedCount} (${formatPercent(postHoc.durableChildCoveragePercent)})`,
      `  Counterfactual unknown: ${postHoc.counterfactualUnknownCount}`,
      `  Trustworthy child SERP: ${postHoc.trustworthySerpCount}/${variant.selectedCount} (${formatPercent(postHoc.trustworthySerpCoveragePercent)})`,
      `  Child scoring: scored=${postHoc.scoredChildCount}, complete=${postHoc.completeScoringCount}, median=${formatNumber(postHoc.medianCandidateScore)}`,
      `  Weak SERP observed-only: >=1 weak domain=${postHoc.weakSerpAtLeastOneCount}, >=2=${postHoc.weakSerpAtLeastTwoCount}`,
    );
    if (variant.versusV1.addedKeywords.length > 0) {
      lines.push(`  Added sample: ${sample(variant.versusV1.addedKeywords)}`);
      lines.push(`  Removed sample: ${sample(variant.versusV1.removedKeywords)}`);
    }
  }

  lines.push(
    '',
    'Methodology',
    '  Selector: pre-SERP Related evidence only.',
    '  Evaluator: only child evidence already durably collected by the source run.',
    '  Missing counterfactual child outcomes remain unknown; they are never scored as zero.',
    '  No automatic winner is computed.',
  );
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  let store: RunStore | undefined;
  try {
    const args = parseExpansionReplayArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }

    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const location = await resolveRunLocation(outputRoot, args.runId);
    const storePath = resolve(location.discoveryDirectory, 'run.sqlite');
    store = RunStore.openReadOnly(storePath);
    const run = store.loadRun(args.runId);
    if (!run) throw new ResearchError('INPUT_SCHEMA_ERROR', `Discovery run not found: ${args.runId}`);

    const expansion = run.configSnapshot.expansion as ExpansionSnapshot | undefined;
    if (expansion?.enabled !== true) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Run ${args.runId} does not have expansion enabled.`);
    }
    if (expansion.admissionVersion !== EXPANSION_ADMISSION_VERSION) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Run ${args.runId} uses expansion admission ${expansion.admissionVersion ?? 'legacy/unmarked'}; offline replay requires persisted ${EXPANSION_ADMISSION_VERSION}.`,
      );
    }

    const keywords = store.loadKeywords(args.runId);
    const related = store.loadRelatedKeywords(args.runId);
    const serpRows = store.loadSerpRows(args.runId);
    const originals = expansionReplayOriginalKeywords(keywords);
    const children = expansionReplayChildKeywords(keywords);
    const candidateEvidence = buildCandidates(children, serpRows, resolveDrThresholds(run.configSnapshot));
    const replay = buildExpansionReplay({
      runId: args.runId,
      originalKeywords: originals,
      related,
      maxCandidatesPerKeyword: expansion.maxCandidatesPerKeyword,
      minOverlap: expansion.minOverlap,
      minVolume: expansion.minVolume,
      candidateEvidence,
    });

    process.stdout.write(args.json ? `${JSON.stringify(replay, null, 2)}\n` : renderExpansionReplay(replay));
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      exitCode = error.code === 'INPUT_SCHEMA_ERROR' || error.code === 'RESUME_NOT_FOUND'
        ? EXIT_INVALID_INPUT
        : EXIT_INTERNAL;
    } else {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      exitCode = EXIT_INTERNAL;
    }
  } finally {
    store?.close();
    process.exitCode = exitCode;
  }
}

function formatPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value}%`;
}

function formatNumber(value: number | null): string {
  return value === null ? 'n/a' : String(value);
}

function formatRatio(value: number | null): string {
  return value === null ? 'n/a' : String(Math.round(value * 10_000) / 10_000);
}

function sample(values: string[]): string {
  const shown = values.slice(0, 10);
  return `${shown.join(', ')}${values.length > shown.length ? ` (+${values.length - shown.length} more)` : ''}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/expansionReplay.ts') || process.argv[1]?.endsWith('\\expansionReplay.ts')) {
  void main();
}
