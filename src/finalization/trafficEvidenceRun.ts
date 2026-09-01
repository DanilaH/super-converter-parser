import { join } from 'node:path';
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
import { invalidateFinalistEvidencePublication } from '../enrichment/finalistEvidencePublication.js';
import { loadTrafficSnapshotRows } from '../input/traffic/load.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
} from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';

export type TrafficEvidenceRunRequest = {
  outputRoot: string;
  enrichmentId: string;
  inputPath?: string | null;
  lowBaseOrganicTrafficThreshold?: number;
  logger?: (line: string) => void;
};

export type TrafficEvidenceRunResult = {
  enrichmentId: string;
  sourceRunId: string;
  changed: boolean;
  importedSnapshotCount: number;
  currentTargetSnapshotCount: number;
  matchedSnapshotCount: number;
  mismatchedSnapshotCount: number;
  staleTargetSnapshotCount: number;
  historyCount: number;
  velocityCount: number;
  lowBaseWarningCount: number;
  trafficValueCurrencyMismatchCount: number;
  inserted: number;
  duplicates: number;
  policy: TrafficEvidencePolicy;
  evidencePath: string;
  velocityPath: string;
  jsonPath: string;
};

export async function runTrafficEvidence(
  request: TrafficEvidenceRunRequest,
): Promise<TrafficEvidenceRunResult> {
  const logger = request.logger ?? ((line: string) => console.log(line));
  const inputPath = request.inputPath ?? null;
  const enrichmentLocation = await resolveEnrichmentLocation(request.outputRoot, request.enrichmentId);
  const store = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));

  try {
    const enrichment = store.loadEnrichmentRun(request.enrichmentId);
    if (!enrichment) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${request.enrichmentId}`);
    }
    if (enrichment.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Traffic evidence requires a completed enrichment; ${request.enrichmentId} is ${enrichment.state}.`,
      );
    }

    const entrant = loadEntrantCohortState(store, request.enrichmentId);
    if (!entrant) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${request.enrichmentId} has no persisted entrant-cohort snapshot. Run npm run entrant-cohort first.`,
      );
    }

    const previousPolicy = loadTrafficEvidencePolicy(store, request.enrichmentId);
    let policy: TrafficEvidencePolicy;
    try {
      policy = resolveTrafficEvidencePolicy({
        previous: previousPolicy,
        ...(request.lowBaseOrganicTrafficThreshold === undefined
          ? {}
          : { lowBaseOrganicTrafficThreshold: request.lowBaseOrganicTrafficThreshold }),
      });
    } catch (error) {
      throw inputError(error);
    }

    const existing = loadTrafficImportRecords(store, request.enrichmentId);
    let incoming: TrafficSnapshot[] = [];
    if (inputPath !== null) {
      const rows = await loadTrafficSnapshotRows(inputPath);
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

    const currentEntrantFingerprint = entrantCohortFingerprint(entrant);
    const existingSnapshotIds = new Set(existing.map((record) => record.snapshotId));
    const trafficChanged = incoming.some(
      (snapshot) => !existingSnapshotIds.has(trafficSnapshotId(snapshot)),
    )
      || previousPolicy === null
      || JSON.stringify(previousPolicy) !== JSON.stringify(policy);

    try {
      await assertTrafficEvidencePublicationParent({
        enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
        enrichmentId: request.enrichmentId,
        sourceRunId: enrichment.sourceRunId,
        currentEntrantFingerprint,
      });
    } catch (error) {
      throw inputError(error);
    }

    if (trafficChanged) {
      await invalidateFinalistEvidencePublication({
        enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
        enrichmentId: request.enrichmentId,
        sourceRunId: enrichment.sourceRunId,
      });
    }

    const appendResult = incoming.length === 0
      ? { inserted: 0, duplicates: 0 }
      : appendTrafficSnapshots(store, request.enrichmentId, incoming);
    saveTrafficEvidencePolicy(store, request.enrichmentId, policy);

    const imports = loadTrafficImportRecords(store, request.enrichmentId);
    const current = projectCurrentTrafficEvidence({
      importedSnapshots: imports.map((record) => record.snapshot),
      cohorts: entrant.cohorts,
      policy,
    });

    const artifact: TrafficEvidenceArtifact = {
      version: TRAFFIC_EVIDENCE_VERSION,
      enrichmentId: request.enrichmentId,
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
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      summary: {
        changed: trafficChanged,
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

    logger(
      `Traffic evidence: ${imports.length} imported snapshot(s); `
      + `${current.projection.matchedSnapshotCount} current target match(es), `
      + `${current.projection.mismatchedSnapshotCount} mismatch(es), `
      + `${current.staleTargetSnapshotCount} stale target(s).`,
    );
    logger(
      `Compatible histories: ${current.projection.histories.length}; velocity intervals: ${velocities.length}; `
      + `low-base warnings: ${lowBaseWarningCount}; currency mismatches: ${trafficValueCurrencyMismatchCount}.`,
    );
    if (inputPath !== null) {
      logger(`Import: ${appendResult.inserted} inserted, ${appendResult.duplicates} duplicate(s).`);
    }
    logger(`Policy: low-base organic traffic <= ${policy.lowBaseOrganicTrafficThreshold}.`);
    logger(`Artifacts: ${evidencePath}, ${velocityPath}, ${jsonPath}`);

    return {
      enrichmentId: request.enrichmentId,
      sourceRunId: enrichment.sourceRunId,
      changed: trafficChanged,
      importedSnapshotCount: current.importedSnapshotCount,
      currentTargetSnapshotCount: current.currentTargetSnapshotCount,
      matchedSnapshotCount: current.projection.matchedSnapshotCount,
      mismatchedSnapshotCount: current.projection.mismatchedSnapshotCount,
      staleTargetSnapshotCount: current.staleTargetSnapshotCount,
      historyCount: current.projection.histories.length,
      velocityCount: velocities.length,
      lowBaseWarningCount,
      trafficValueCurrencyMismatchCount,
      inserted: appendResult.inserted,
      duplicates: appendResult.duplicates,
      policy,
      evidencePath,
      velocityPath,
      jsonPath,
    };
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
