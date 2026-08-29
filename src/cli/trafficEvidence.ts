import process from 'node:process';
import { join } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import {
  appendTrafficSnapshots,
  loadTrafficEvidencePolicy,
  loadTrafficImportRecords,
  saveTrafficEvidencePolicy,
  trafficSnapshotId,
} from '../db/trafficEvidence.js';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { RunStore } from '../db/store.js';
import {
  TRAFFIC_EVIDENCE_VERSION,
  normalizeTrafficSnapshots,
  type TrafficEvidencePolicy,
  type TrafficSnapshot,
} from '../enrichment/trafficEvidence.js';
import { resolveTrafficEvidencePolicy } from '../enrichment/trafficEvidenceConfig.js';
import { projectCurrentTrafficEvidence } from '../enrichment/trafficEvidenceCurrent.js';
import {
  writeTrafficEvidenceCsv,
  writeTrafficEvidenceJson,
  writeTrafficVelocityCsv,
  type TrafficEvidenceArtifact,
} from '../enrichment/trafficEvidenceOutputs.js';
import {
  assertTrafficEvidencePublicationParent,
  publishTrafficEvidenceMetadata,
} from '../enrichment/trafficEvidencePublication.js';
import { loadTrafficSnapshotRows } from '../input/traffic/load.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveOutputRoot,
} from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

type ParsedArgs = {
  help: boolean;
  enrichmentId: string;
  inputPath: string | null;
  outputRoot: string | null;
  lowBaseOrganicTrafficThreshold: number | undefined;
};

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseNonNegativeNumber(raw: string, option: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `${option} must be a non-negative finite number, got ${raw}`,
    );
  }
  return value;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let inputPath: string | null = null;
  let outputRoot: string | null = null;
  let lowBaseOrganicTrafficThreshold: number | undefined;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--input') {
      inputPath = nextOptionValue(args, '--input');
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg === '--low-base-organic-traffic-threshold') {
      lowBaseOrganicTrafficThreshold = parseNonNegativeNumber(
        nextOptionValue(args, '--low-base-organic-traffic-threshold'),
        '--low-base-organic-traffic-threshold',
      );
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }

  if (!help && enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required');
  }
  return {
    help,
    enrichmentId,
    inputPath,
    outputRoot,
    lowBaseOrganicTrafficThreshold,
  };
}

function printUsage(): void {
  console.log('Utility Research Competitor Traffic Evidence');
  console.log('');
  console.log('Usage:');
  console.log('  npm run traffic-evidence -- --enrichment <enrichment-id> [--input <traffic.csv>] \\');
  console.log('    [--low-base-organic-traffic-threshold <traffic>]');
  console.log('');
  console.log('Options:');
  console.log('  --input <path>                              Append canonical manual/imported traffic snapshots.');
  console.log('  --low-base-organic-traffic-threshold <n>    Explicit low-base warning threshold. Required on first run.');
  console.log('                                                Later reruns reuse the persisted value when omitted.');
  console.log('  --output-root <path>                         Durable research output root.');
  console.log('  --help                                       Show this help.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outputRoot = resolveOutputRoot(args.outputRoot);
  const enrichmentLocation = await resolveEnrichmentLocation(outputRoot, args.enrichmentId);
  const store = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));

  try {
    const enrichment = store.loadEnrichmentRun(args.enrichmentId);
    if (!enrichment) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${args.enrichmentId}`);
    }
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Traffic evidence requires a completed enrichment; ${args.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const entrant = loadEntrantCohortState(store, args.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no persisted entrant-cohort snapshot. Run npm run entrant-cohort first.`,
      );
    }

    let policy: TrafficEvidencePolicy;
    try {
      policy = resolveTrafficEvidencePolicy({
        previous: loadTrafficEvidencePolicy(store, args.enrichmentId),
        ...(args.lowBaseOrganicTrafficThreshold === undefined
          ? {}
          : { lowBaseOrganicTrafficThreshold: args.lowBaseOrganicTrafficThreshold }),
      });
    } catch (error) {
      throw inputError(error);
    }

    const existing = loadTrafficImportRecords(store, args.enrichmentId);
    let incoming: TrafficSnapshot[] = [];
    if (args.inputPath !== null) {
      const rows = await loadTrafficSnapshotRows(args.inputPath);
      try {
        incoming = normalizeTrafficSnapshots({ rows, cohorts: entrant.cohorts });
      } catch (error) {
        throw inputError(error);
      }
    }

    const combined = dedupeSnapshots([
      ...existing.map((record) => record.snapshot),
      ...incoming,
    ]);
    if (combined.length === 0) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        'No traffic evidence is persisted. Provide --input <traffic.csv> for the first evidence import.',
      );
    }

    try {
      projectCurrentTrafficEvidence({
        importedSnapshots: combined,
        cohorts: entrant.cohorts,
        policy,
      });
    } catch (error) {
      throw inputError(error);
    }

    const appendResult = incoming.length === 0
      ? { inserted: 0, duplicates: 0 }
      : appendTrafficSnapshots(store, args.enrichmentId, incoming);
    saveTrafficEvidencePolicy(store, args.enrichmentId, policy);

    const imports = loadTrafficImportRecords(store, args.enrichmentId);
    const current = projectCurrentTrafficEvidence({
      importedSnapshots: imports.map((record) => record.snapshot),
      cohorts: entrant.cohorts,
      policy,
    });
    const currentEntrantFingerprint = entrantCohortFingerprint(entrant);

    try {
      await assertTrafficEvidencePublicationParent({
        enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
        enrichmentId: args.enrichmentId,
        sourceRunId: enrichment.sourceRunId,
        currentEntrantFingerprint,
      });
    } catch (error) {
      throw inputError(error);
    }

    const artifact: TrafficEvidenceArtifact = {
      version: TRAFFIC_EVIDENCE_VERSION,
      enrichmentId: args.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      currentEntrantFingerprint,
      policy,
      imports,
      current,
    };

    const evidencePath = join(enrichmentLocation.enrichmentDirectory, 'traffic-evidence.csv');
    const velocityPath = join(enrichmentLocation.enrichmentDirectory, 'traffic-velocity.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'traffic-evidence.json');
    await writeTrafficEvidenceCsv(evidencePath, artifact);
    await writeTrafficVelocityCsv(velocityPath, current);
    await writeTrafficEvidenceJson(jsonPath, artifact);

    const velocities = current.projection.histories.flatMap((history) => history.velocities);
    const lowBaseWarningCount = velocities.filter(
      (velocity) => velocity.warnings.includes('low_base_organic_traffic'),
    ).length;
    const trafficValueCurrencyMismatchCount = velocities.filter(
      (velocity) => velocity.warnings.includes('traffic_value_currency_mismatch'),
    ).length;

    await publishTrafficEvidenceMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: args.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      summary: {
        version: TRAFFIC_EVIDENCE_VERSION,
        currentEntrantFingerprint,
        importedSnapshotCount: current.importedSnapshotCount,
        currentTargetSnapshotCount: current.currentTargetSnapshotCount,
        matchedSnapshotCount: current.projection.matchedSnapshotCount,
        mismatchedSnapshotCount: current.projection.mismatchedSnapshotCount,
        staleTargetSnapshotCount: current.staleTargetSnapshotCount,
        historyCount: current.projection.histories.length,
        velocityCount: velocities.length,
        lowBaseWarningCount,
        trafficValueCurrencyMismatchCount,
        policy,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    console.log(
      `Traffic evidence: ${imports.length} imported snapshot(s); `
      + `${current.projection.matchedSnapshotCount} current target match(es), `
      + `${current.projection.mismatchedSnapshotCount} mismatch(es), `
      + `${current.staleTargetSnapshotCount} stale target(s).`,
    );
    console.log(
      `Compatible histories: ${current.projection.histories.length}; velocity intervals: ${velocities.length}; `
      + `low-base warnings: ${lowBaseWarningCount}; currency mismatches: ${trafficValueCurrencyMismatchCount}.`,
    );
    if (args.inputPath !== null) {
      console.log(`Import: ${appendResult.inserted} inserted, ${appendResult.duplicates} duplicate(s).`);
    }
    console.log(`Policy: low-base organic traffic <= ${policy.lowBaseOrganicTrafficThreshold}.`);
    console.log(`Artifacts: ${evidencePath}, ${velocityPath}, ${jsonPath}`);
  } finally {
    store.close();
  }
}

function dedupeSnapshots(snapshots: TrafficSnapshot[]): TrafficSnapshot[] {
  const byId = new Map<string, TrafficSnapshot>();
  for (const snapshot of snapshots) {
    const id = trafficSnapshotId(snapshot);
    if (!byId.has(id)) byId.set(id, snapshot);
  }
  return [...byId.values()];
}

function inputError(error: unknown): ResearchError {
  return new ResearchError(
    'INPUT_SCHEMA_ERROR',
    error instanceof Error ? error.message : String(error),
    { cause: error },
  );
}

main()
  .then(() => {
    process.exitCode = EXIT_OK;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR'
      ? EXIT_INVALID_INPUT
      : EXIT_INTERNAL;
  });
