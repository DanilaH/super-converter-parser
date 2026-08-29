import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { writeTextAtomic } from '../runs/run.js';
import { invalidateFinalistEvidencePublication } from './finalistEvidencePublication.js';
import type { TrafficEvidencePolicy } from './trafficEvidence.js';

export const TRAFFIC_EVIDENCE_ARTIFACTS = [
  'traffic-evidence.csv',
  'traffic-velocity.csv',
  'traffic-evidence.json',
] as const;

export type TrafficEvidencePublicationSummary = {
  changed: boolean;
  version: string;
  currentEntrantFingerprint: string;
  importedSnapshotCount: number;
  currentTargetSnapshotCount: number;
  matchedSnapshotCount: number;
  mismatchedSnapshotCount: number;
  staleTargetSnapshotCount: number;
  historyCount: number;
  velocityCount: number;
  lowBaseWarningCount: number;
  trafficValueCurrencyMismatchCount: number;
  policy: TrafficEvidencePolicy;
};

type PublicationParentInput = {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  currentEntrantFingerprint: string;
};

type PublicationContext = {
  manifestPath: string;
  statusPath: string;
  originalManifest: string;
  originalStatus: string;
  manifest: Record<string, unknown>;
  status: Record<string, unknown>;
};

export async function assertTrafficEvidencePublicationParent(
  input: PublicationParentInput,
): Promise<void> {
  await loadPublicationContext(input);
}

export async function publishTrafficEvidenceMetadata(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  summary: TrafficEvidencePublicationSummary;
}): Promise<void> {
  const parentInput: PublicationParentInput = {
    enrichmentDirectory: input.enrichmentDirectory,
    enrichmentId: input.enrichmentId,
    sourceRunId: input.sourceRunId,
    currentEntrantFingerprint: input.summary.currentEntrantFingerprint,
  };
  let context = await loadPublicationContext(parentInput);

  if (input.summary.changed) {
    await invalidateFinalistEvidencePublication({
      enrichmentDirectory: input.enrichmentDirectory,
      enrichmentId: input.enrichmentId,
      sourceRunId: input.sourceRunId,
    });
    context = await loadPublicationContext(parentInput);
  }

  const nextManifest: Record<string, unknown> = {
    ...context.manifest,
    artifacts: uniqueStrings([
      ...readStringArray(context.manifest.artifacts, 'manifest.json artifacts'),
      ...TRAFFIC_EVIDENCE_ARTIFACTS,
    ]),
    trafficEvidence: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...context.status,
    artifacts: uniqueStrings([
      ...readStringArray(context.status.artifacts, 'status.json artifacts'),
      ...TRAFFIC_EVIDENCE_ARTIFACTS,
    ]),
    trafficEvidence: input.summary,
  };

  await writeTextAtomic(
    context.statusPath,
    JSON.stringify(nextStatus, null, 2) + '\n',
    'enrichment status with traffic evidence',
  );
  try {
    await writeTextAtomic(
      context.manifestPath,
      JSON.stringify(nextManifest, null, 2) + '\n',
      'enrichment manifest with traffic evidence',
    );
  } catch (error) {
    await writeTextAtomic(
      context.statusPath,
      context.originalStatus,
      'restore enrichment status',
    ).catch(() => undefined);
    throw error;
  }
}

async function loadPublicationContext(
  input: PublicationParentInput,
): Promise<PublicationContext> {
  const manifestPath = join(input.enrichmentDirectory, 'manifest.json');
  const statusPath = join(input.enrichmentDirectory, 'status.json');
  const entrantPath = join(input.enrichmentDirectory, 'entrant-cohort.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const originalStatus = await readFile(statusPath, 'utf8');
  const manifest = parsePublishedJson(originalManifest, 'manifest.json');
  const status = parsePublishedJson(originalStatus, 'status.json');
  const entrant = parsePublishedJson(await readFile(entrantPath, 'utf8'), 'entrant-cohort.json');

  assertArtifactIdentity(manifest, input.enrichmentId, input.sourceRunId, 'manifest.json');
  assertArtifactIdentity(status, input.enrichmentId, input.sourceRunId, 'status.json');
  assertArtifactIdentity(entrant, input.enrichmentId, input.sourceRunId, 'entrant-cohort.json');
  if (manifest.state !== 'completed' || status.status !== 'completed') {
    throw new Error('Traffic evidence publication requires a completed enrichment publication');
  }

  const publishedEntrantFingerprint = fingerprintPublishedEntrant(entrant);
  if (publishedEntrantFingerprint !== input.currentEntrantFingerprint) {
    throw new Error(
      `entrant-cohort.json fingerprint ${publishedEntrantFingerprint} does not match current traffic parent ${input.currentEntrantFingerprint}`,
    );
  }
  assertPublicEntrantRevision(manifest, entrant, 'manifest.json');
  assertPublicEntrantRevision(status, entrant, 'status.json');

  return {
    manifestPath,
    statusPath,
    originalManifest,
    originalStatus,
    manifest,
    status,
  };
}

function fingerprintPublishedEntrant(value: Record<string, unknown>): string {
  const snapshot: EntrantCohortSnapshot = {
    enrichmentId: readString(value.enrichmentId, 'entrant-cohort.json enrichmentId'),
    sourceRunId: readString(value.sourceRunId, 'entrant-cohort.json sourceRunId'),
    representativeRevision: readInteger(value.representativeRevision, 'entrant-cohort.json representativeRevision'),
    cohortVersion: readString(value.cohortVersion, 'entrant-cohort.json cohortVersion'),
    serpTopN: readInteger(value.serpTopN, 'entrant-cohort.json serpTopN'),
    drThresholds: readRecord(value.drThresholds, 'entrant-cohort.json drThresholds') as EntrantCohortSnapshot['drThresholds'],
    sourceRunUpdatedAt: readString(value.sourceRunUpdatedAt, 'entrant-cohort.json sourceRunUpdatedAt'),
    clusteringUpdatedAt: readString(value.clusteringUpdatedAt, 'entrant-cohort.json clusteringUpdatedAt'),
    cohorts: readArray(value.cohorts, 'entrant-cohort.json cohorts') as EntrantCohortSnapshot['cohorts'],
  };
  return entrantCohortFingerprint(snapshot);
}

function assertPublicEntrantRevision(
  publication: Record<string, unknown>,
  entrant: Record<string, unknown>,
  label: string,
): void {
  const metadata = readRecord(publication.entrantCohort, `${label} entrantCohort`);
  const publishedRevision = readInteger(
    metadata.representativeRevision,
    `${label} entrantCohort.representativeRevision`,
  );
  const artifactRevision = readInteger(
    entrant.representativeRevision,
    'entrant-cohort.json representativeRevision',
  );
  if (publishedRevision !== artifactRevision) {
    throw new Error(
      `${label} entrant cohort representative revision ${publishedRevision} does not match entrant-cohort.json revision ${artifactRevision}`,
    );
  }
}

function parsePublishedJson(content: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed)) throw new Error('expected object');
    return parsed;
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertArtifactIdentity(
  value: Record<string, unknown>,
  enrichmentId: string,
  sourceRunId: string,
  label: string,
): void {
  if (value.enrichmentId !== enrichmentId || value.sourceRunId !== sourceRunId) {
    throw new Error(`${label} does not belong to enrichment ${enrichmentId} / source run ${sourceRunId}`);
  }
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function readInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
