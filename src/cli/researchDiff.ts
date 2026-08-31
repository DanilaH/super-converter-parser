import process from 'node:process';
import { loadDotEnv } from '../config/env.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import {
  buildResearchGenerationDiff,
  parseResearchGenerationRef,
  type ResearchGenerationDiff,
} from '../research/diff.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  research: string;
  from: string;
  to: string;
  outputRoot: string | null;
  json: boolean;
};

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

export function parseResearchDiffArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = {
    help: false,
    research: '',
    from: '',
    to: '',
    outputRoot: null,
    json: false,
  };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--research') parsed.research = nextValue(args, '--research');
    else if (arg === '--from') parsed.from = nextValue(args, '--from');
    else if (arg === '--to') parsed.to = nextValue(args, '--to');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help) {
    if (parsed.research === '') throw new ResearchError('INPUT_SCHEMA_ERROR', '--research <research-id-or-run-id> is required.');
    if (parsed.from === '') throw new ResearchError('INPUT_SCHEMA_ERROR', '--from <generation-ref> is required.');
    if (parsed.to === '') throw new ResearchError('INPUT_SCHEMA_ERROR', '--to <generation-ref> is required.');
    const from = parseResearchGenerationRef(parsed.from);
    const to = parseResearchGenerationRef(parsed.to);
    if (from.kind !== to.kind) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', '--from and --to must use the same generation kind.');
    }
  }
  return parsed;
}

function printUsage(): void {
  console.log('Utility Research Generation Diff');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research:diff -- --research <research-id-or-run-id> --from discovery:1 --to discovery:2');
  console.log('  npm run research:diff -- --research <research-id-or-run-id> --from enrichment:1 --to enrichment:2');
  console.log('');
  console.log('Options:');
  console.log('  --research <id>      Stable research id or any indexed discovery run id in that research.');
  console.log('  --from <kind:n>      Explicit immutable generation ref.');
  console.log('  --to <kind:n>        Explicit immutable generation ref of the same kind.');
  console.log('  --output-root <path> Durable research output root.');
  console.log('  --json               Print the deterministic machine-readable diff.');
  console.log('  --help, -h           Show this help.');
  console.log('');
  console.log('The diff is read-only and descriptive. It does not score, rank, or reinterpret opportunity quality.');
}

function coverageLine(value: { numerator: number; denominator: number }): string {
  return `${value.numerator}/${value.denominator}`;
}

function listLine(values: string[]): string {
  return values.length === 0 ? 'none' : values.join(', ');
}

export function renderResearchGenerationDiff(diff: ResearchGenerationDiff): string {
  const lines = [
    'Research generation diff',
    `  Research: ${diff.researchId} (${diff.label})`,
    `  Kind: ${diff.kind}`,
  ];

  if (diff.discovery !== null) {
    const value = diff.discovery;
    lines.push(
      `  From: discovery:${value.from.generation} ${value.from.runId} [${value.from.state}]`,
      `  To: discovery:${value.to.generation} ${value.to.runId} [${value.to.state}]`,
      '',
      'Keywords',
      `  Count: ${value.keywords.fromCount} -> ${value.keywords.toCount}`,
      `  Added: ${listLine(value.keywords.added.map((row) => row.normalizedKeyword))}`,
      `  Removed: ${listLine(value.keywords.removed.map((row) => row.normalizedKeyword))}`,
      `  Status changes: ${value.keywords.statusChanges.length}`,
    );
    for (const change of value.keywords.statusChanges) {
      lines.push(`    - ${change.normalizedKeyword}: ${change.from} -> ${change.to}`);
    }
    lines.push(
      '',
      'Google SERP evidence',
      `  Trustworthy coverage: ${coverageLine(value.googleSerpCoverage.from)} -> ${coverageLine(value.googleSerpCoverage.to)}`,
    );
  }

  if (diff.enrichment !== null) {
    const value = diff.enrichment;
    lines.push(
      `  From: enrichment:${value.from.generation} ${value.from.enrichmentId} [${value.from.state}] source=${value.from.sourceRunId}`,
      `  To: enrichment:${value.to.generation} ${value.to.enrichmentId} [${value.to.state}] source=${value.to.sourceRunId}`,
      '',
      'Modules',
      `  Added: ${listLine(value.modules.added)}`,
      `  Removed: ${listLine(value.modules.removed)}`,
      '',
      `Clusters (matching basis: ${value.clusters.matchingBasis})`,
      `  Added: ${listLine(value.clusters.added.map((row) => row.clusterId))}`,
      `  Removed: ${listLine(value.clusters.removed.map((row) => row.clusterId))}`,
      `  Changed same-id clusters: ${value.clusters.changed.length}`,
    );
    for (const change of value.clusters.changed) {
      lines.push(
        `    - ${change.clusterId}: members +[${listLine(change.addedMembers)}] -[${listLine(change.removedMembers)}]`,
      );
      if (change.canonicalKeywordFrom !== change.canonicalKeywordTo) {
        lines.push(`      canonical: ${change.canonicalKeywordFrom} -> ${change.canonicalKeywordTo}`);
      }
    }

    lines.push('', `Representative-query changes: ${value.representatives.length}`);
    for (const change of value.representatives) {
      lines.push(
        `  - ${change.clusterId}: [${listLine(change.from ?? [])}] -> [${listLine(change.to ?? [])}]`,
      );
    }

    lines.push('', `Entrant-domain changes: ${value.entrantDomains.length}`);
    for (const change of value.entrantDomains) {
      lines.push(`  - ${change.clusterId}: +[${listLine(change.added)}] -[${listLine(change.removed)}]`);
    }

    lines.push('', 'Historical evidence');
    if (value.historyCoverage.from === null && value.historyCoverage.to === null) {
      lines.push('  Cohort history: not collected in either generation');
    } else {
      lines.push(
        `  Checked coverage: ${value.historyCoverage.from ? coverageLine(value.historyCoverage.from.checked) : 'n/a'} -> ${value.historyCoverage.to ? coverageLine(value.historyCoverage.to.checked) : 'n/a'}`,
        `  RDAP known: ${value.historyCoverage.from ? coverageLine(value.historyCoverage.from.registrationKnown) : 'n/a'} -> ${value.historyCoverage.to ? coverageLine(value.historyCoverage.to.registrationKnown) : 'n/a'}`,
        `  Web first-seen known: ${value.historyCoverage.from ? coverageLine(value.historyCoverage.from.firstSeenKnown) : 'n/a'} -> ${value.historyCoverage.to ? coverageLine(value.historyCoverage.to.firstSeenKnown) : 'n/a'}`,
      );
    }

    lines.push(
      '',
      'Traffic evidence',
      `  Imported snapshots: ${value.trafficEvidence.from.importedSnapshotCount} -> ${value.trafficEvidence.to.importedSnapshotCount}`,
      `  Current-target snapshots: ${value.trafficEvidence.from.currentTargetSnapshotCount ?? 'n/a'} -> ${value.trafficEvidence.to.currentTargetSnapshotCount ?? 'n/a'}`,
      `  Stale-target snapshots: ${value.trafficEvidence.from.staleTargetSnapshotCount ?? 'n/a'} -> ${value.trafficEvidence.to.staleTargetSnapshotCount ?? 'n/a'}`,
    );
  }

  return `${lines.join('\n')}\n`;
}

async function main(): Promise<void> {
  let exitCode = EXIT_OK;
  try {
    const args = parseResearchDiffArgs(process.argv.slice(2));
    if (args.help) {
      printUsage();
      return;
    }
    const outputRoot = resolveOutputRoot(args.outputRoot, process.env);
    const diff = await buildResearchGenerationDiff({
      outputRoot,
      targetRunId: args.research,
      from: args.from,
      to: args.to,
    });
    process.stdout.write(args.json ? `${JSON.stringify(diff, null, 2)}\n` : renderResearchGenerationDiff(diff));
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
    process.exitCode = exitCode;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/researchDiff.ts') || process.argv[1]?.endsWith('\\researchDiff.ts')) {
  void main();
}
