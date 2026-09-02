import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { entrantCohortFingerprint, loadCohortHistoryState } from '../db/cohortHistory.js';
import { loadCohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { RunStore } from '../db/store.js';
import { writeTextAtomic } from '../runs/run.js';
import { evidenceSnapshotFingerprint } from './evidenceSnapshotFingerprint.js';

export const FINALIST_EVIDENCE_ARTIFACTS = [
  'finalist-evidence-matrix.csv',
  'finalist-evidence-matrix.json',
] as const;

export type FinalistEvidencePublicationSummary = {
  version: string;
  representativeRevision: number;
  entrantFingerprint: string;
  cohortHistoryFingerprint: string | null;
  historicalPresenceFingerprint: string | null;
  finalistCount: number;
  cohortHistoryAvailableCount: number;
  importedTrafficSnapshotCount: number;
  matchedTrafficSnapshotCount: number | null;
  mismatchedTrafficSnapshotCount: number | null;
  staleTrafficTargetCount: number;
  currentHumanDecisionCount: number;
  staleHumanDecisionCount: number;
  unrecordedHumanDecisionCount: number;
  auditFlagCount: number;
};

type PublicationContext = {
  manifestPath: string;
  statusPath: string;
  originalManifest: string;
  originalStatus: string;
  manifest: Record<string, unknown>;
  status: Record<string, unknown>;
};

type FinalistEvidenceParent = {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  representativeRevision: number;
  entrantFingerprint: string;
  cohortHistoryFingerprint: string | null;
  historicalPresenceFingerprint: string | null;
};

export async function assertFinalistEvidencePublicationParent(input: FinalistEvidenceParent): Promise<void> {
  await loadPublicationContext(input);
}

export async function publishFinalistEvidenceMetadata(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  summary: FinalistEvidencePublicationSummary;
}): Promise<void> {
  const context = await loadPublicationContext({
    enrichmentDirectory: input.enrichmentDirectory,
    enrichmentId: input.enrichmentId,
    sourceRunId: input.sourceRunId,
    representativeRevision: input.summary.representativeRevision,
    entrantFingerprint: input.summary.entrantFingerprint,
    cohortHistoryFingerprint: input.summary.cohortHistoryFingerprint,
    historicalPresenceFingerprint: input.summary.historicalPresenceFingerprint,
  });

  const nextManifest: Record<string, unknown> = {
    ...context.manifest,
    artifacts: uniqueStrings([
      ...readStringArray(context.manifest.artifacts, 'manifest.json artifacts'),
      ...FINALIST_EVIDENCE_ARTIFACTS,
    ]),
    finalistEvidence: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...context.status,
    artifacts: uniqueStrings([
      ...readStringArray(context.status.artifacts, 'status.json artifacts'),
      ...FINALIST_EVIDENCE_ARTIFACTS,
    ]),
    finalistEvidence: input.summary,
  };

  await writeTextAtomic(
    context.statusPath,
    JSON.stringify(nextStatus, null, 2) + '\n',
    'enrichment status with finalist evidence',
  );
  try {
    await writeTextAtomic(
      context.manifestPath,
      JSON.stringify(nextManifest, null, 2) + '\n',
      'enrichment manifest with finalist evidence',
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

export async function invalidateFinalistEvidencePublication(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
}): Promise<void> {
  const manifestPath = join(input.enrichmentDirectory, 'manifest.json');
  const statusPath = join(input.enrichmentDirectory, 'status.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const originalStatus = await readFile(statusPath, 'utf8');
  const manifest = parsePublishedJson(originalManifest, 'manifest.json');
  const status = parsePublishedJson(originalStatus, 'status.json');
  assertArtifactIdentity(manifest, input.enrichmentId, input.sourceRunId, 'manifest.json');
  assertArtifactIdentity(status, input.enrichmentId, input.sourceRunId, 'status.json');

  const nextManifest = withoutFinalistEvidence(manifest);
  const nextStatus = withoutFinalistEvidence(status);
  nextManifest.artifacts = filterFinalistArtifacts(
    readStringArray(manifest.artifacts, 'manifest.json artifacts'),
  );
  nextStatus.artifacts = filterFinalistArtifacts(
    readStringArray(status.artifacts, 'status.json artifacts'),
  );

  const changed = JSON.stringify(nextManifest) !== JSON.stringify(manifest)
    || JSON.stringify(nextStatus) !== JSON.stringify(status);
  if (changed) {
    await writeTextAtomic(
      statusPath,
      JSON.stringify(nextStatus, null, 2) + '\n',
      'invalidate finalist evidence status',
    );
    try {
      await writeTextAtomic(
        manifestPath,
        JSON.stringify(nextManifest, null, 2) + '\n',
        'invalidate finalist evidence manifest',
      );
    } catch (error) {
      await writeTextAtomic(statusPath, originalStatus, 'restore enrichment status').catch(() => undefined);
      throw error;
    }
  }

  await Promise.all(FINALIST_EVIDENCE_ARTIFACTS.map((artifact) =>
    rm(join(input.enrichmentDirectory, artifact), { force: true })));
}

async function loadPublicationContext(input: FinalistEvidenceParent): Promise<PublicationContext> {
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
    throw new Error('Finalist evidence publication requires a completed enrichment publication');
  }
  assertRepresentativeRevision(manifest, input.representativeRevision, 'manifest.json');
  assertRepresentativeRevision(status, input.representativeRevision, 'status.json');
  assertEntrantRevision(manifest, input.representativeRevision, 'manifest.json');
  assertEntrantRevision(status, input.representativeRevision, 'status.json');

  const publishedEntrantFingerprint = fingerprintPublishedEntrant(entrant);
  if (publishedEntrantFingerprint !== input.entrantFingerprint) {
    throw new Error(
      `entrant-cohort.json fingerprint ${publishedEntrantFingerprint} does not match current finalist parent ${input.entrantFingerprint}`,
    );
  }

  const deepParents = loadCurrentDeepEvidenceFingerprints(input.enrichmentDirectory, input.enrichmentId);
  assertExpectedDeepParent(
    deepParents.cohortHistoryFingerprint,
    input.cohortHistoryFingerprint,
    'cohort history',
  );
  assertExpectedDeepParent(
    deepParents.historicalPresenceFingerprint,
    input.historicalPresenceFingerprint,
    'sampled historical presence',
  );
  assertOptionalPublishedSnapshot(
    manifest,
    input.cohortHistoryFingerprint,
    'cohortHistory',
    'cohort-history.json',
    'manifest.json',
  );
  assertOptionalPublishedSnapshot(
    status,
    input.cohortHistoryFingerprint,
    'cohortHistory',
    'cohort-history.json',
    'status.json',
  );
  assertOptionalPublishedSnapshot(
    manifest,
    input.historicalPresenceFingerprint,
    'historicalPresence',
    'cohort-historical-presence.json',
    'manifest.json',
  );
  assertOptionalPublishedSnapshot(
    status,
    input.historicalPresenceFingerprint,
    'historicalPresence',
    'cohort-historical-presence.json',
    'status.json',
  );

  return {
    manifestPath,
    statusPath,
    originalManifest,
    originalStatus,
    manifest,
    status,
  };
}

function loadCurrentDeepEvidenceFingerprints(
  enrichmentDirectory: string,
  enrichmentId: string,
): { cohortHistoryFingerprint: string | null; historicalPresenceFingerprint: string | null } {
  const store = RunStore.openReadOnly(join(enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const cohortHistory = loadCohortHistoryState(store, enrichmentId);
    const historicalPresence = loadCohortHistoricalPresenceState(store, enrichmentId);
    return {
      cohortHistoryFingerprint: cohortHistory === null ? null : evidenceSnapshotFingerprint(cohortHistory),
      historicalPresenceFingerprint: historicalPresence === null ? null : evidenceSnapshotFingerprint(historicalPresence),
    };
  } finally {
    store.close();
  }
}

function assertExpectedDeepParent(
  currentFingerprint: string | null,
  expectedFingerprint: string | null,
  label: string,
): void {
  if (currentFingerprint !== expectedFingerprint) {
    throw new Error(
      `Current durable ${label} fingerprint ${currentFingerprint ?? 'missing'} does not match finalist matrix parent ${expectedFingerprint ?? 'missing'}. Rebuild finalist evidence from the current parent generation.`,
    );
  }
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

function assertRepresentativeRevision(
  value: Record<string, unknown>,
  expectedRevision: number,
  label: string,
): void {
  const representatives = readRecord(value.representativeQueries, `${label} representativeQueries`);
  const revision = readInteger(representatives.revision, `${label} representativeQueries.revision`);
  if (revision !== expectedRevision) {
    throw new Error(`${label} representative revision ${revision} does not match current finalist parent ${expectedRevision}`);
  }
}

function assertEntrantRevision(
  value: Record<string, unknown>,
  expectedRevision: number,
  label: string,
): void {
  const entrant = readRecord(value.entrantCohort, `${label} entrantCohort`);
  const revision = readInteger(entrant.representativeRevision, `${label} entrantCohort.representativeRevision`);
  if (revision !== expectedRevision) {
    throw new Error(`${label} entrant revision ${revision} does not match current finalist parent ${expectedRevision}`);
  }
}

function assertOptionalPublishedSnapshot(
  value: Record<string, unknown>,
  expectedFingerprint: string | null,
  metadataKey: 'cohortHistory' | 'historicalPresence',
  artifactName: string,
  label: string,
): void {
  const artifacts = readStringArray(value.artifacts, `${label} artifacts`);
  const metadata = value[metadataKey];
  if (expectedFingerprint === null) {
    if (metadata !== undefined || artifacts.includes(artifactName)) {
      throw new Error(`${label} has stale ${metadataKey} publication state but no current durable parent exists.`);
    }
    return;
  }
  const published = readRecord(metadata, `${label} ${metadataKey}`);
  const fingerprint = readString(published.snapshotFingerprint, `${label} ${metadataKey}.snapshotFingerprint`);
  if (fingerprint !== expectedFingerprint || !artifacts.includes(artifactName)) {
    throw new Error(`${label} ${metadataKey} snapshot does not match current durable parent ${expectedFingerprint}.`);
  }
}

function withoutFinalistEvidence(value: Record<string, unknown>): Record<string, unknown> {
  const { finalistEvidence: _finalistEvidence, ...rest } = value;
  return rest;
}

function filterFinalistArtifacts(values: string[]): string[] {
  const invalid = new Set<string>(FINALIST_EVIDENCE_ARTIFACTS);
  return values.filter((value) => !invalid.has(value));
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
  return value as Record<string, unknown>;
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
