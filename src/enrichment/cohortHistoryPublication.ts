import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import { writeTextAtomic } from '../runs/run.js';
import type { CohortHistoryPolicy } from './cohortHistory.js';
import { invalidateFinalistEvidencePublication } from './finalistEvidencePublication.js';

export const COHORT_HISTORY_ARTIFACTS = [
  'cohort-history.csv',
  'cohort-history-summary.csv',
  'cohort-history.json',
] as const;

export type CohortHistoryPublicationSummary = {
  changed: boolean;
  version: string;
  entrantRepresentativeRevision: number;
  entrantFingerprint: string;
  finalistClusterCount: number;
  cohortDomainCount: number;
  checkedDomainCount: number;
  omittedDomainCount: number;
  unobservedDomainCount: number;
  registrationKnownDomainCount: number;
  youngDomainCount: number;
  firstSeenKnownDomainCount: number;
  recentWebPresenceCount: number;
  comparableHistoryDomainCount: number;
  possibleHistoryConflictCount: number;
  policy: CohortHistoryPolicy;
};

type PublicationContext = {
  manifestPath: string;
  statusPath: string;
  originalManifest: string;
  originalStatus: string;
  manifest: Record<string, unknown>;
  status: Record<string, unknown>;
};

export async function publishCohortHistoryMetadata(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  summary: CohortHistoryPublicationSummary;
}): Promise<void> {
  let context = await loadPublicationContext(input);

  if (input.summary.changed) {
    await invalidateFinalistEvidencePublication({
      enrichmentDirectory: input.enrichmentDirectory,
      enrichmentId: input.enrichmentId,
      sourceRunId: input.sourceRunId,
    });
    context = await loadPublicationContext(input);
  }

  const manifestArtifacts = uniqueStrings([
    ...readStringArray(context.manifest.artifacts, 'manifest.json artifacts'),
    ...COHORT_HISTORY_ARTIFACTS,
  ]);
  const statusArtifacts = uniqueStrings([
    ...readStringArray(context.status.artifacts, 'status.json artifacts'),
    ...COHORT_HISTORY_ARTIFACTS,
  ]);

  const nextManifest: Record<string, unknown> = {
    ...context.manifest,
    artifacts: manifestArtifacts,
    cohortHistory: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...context.status,
    artifacts: statusArtifacts,
    cohortHistory: input.summary,
  };

  await writeTextAtomic(
    context.statusPath,
    JSON.stringify(nextStatus, null, 2) + '\n',
    'enrichment status with cohort history',
  );
  try {
    await writeTextAtomic(
      context.manifestPath,
      JSON.stringify(nextManifest, null, 2) + '\n',
      'enrichment manifest with cohort history',
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

async function loadPublicationContext(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  summary: CohortHistoryPublicationSummary;
}): Promise<PublicationContext> {
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
    throw new Error('Cohort history publication requires a completed enrichment publication');
  }
  assertPublicEntrantRevision(manifest, input.summary.entrantRepresentativeRevision, 'manifest.json');
  assertPublicEntrantRevision(status, input.summary.entrantRepresentativeRevision, 'status.json');

  const publishedEntrantFingerprint = fingerprintPublishedEntrant(entrant);
  if (publishedEntrantFingerprint !== input.summary.entrantFingerprint) {
    throw new Error(
      `entrant-cohort.json fingerprint ${publishedEntrantFingerprint} does not match current entrant parent ${input.summary.entrantFingerprint}`,
    );
  }

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
  value: Record<string, unknown>,
  expectedRevision: number,
  label: string,
): void {
  const entrant = readRecord(value.entrantCohort, `${label} entrantCohort`);
  const revision = readInteger(entrant.representativeRevision, `${label} entrantCohort.representativeRevision`);
  if (revision !== expectedRevision) {
    throw new Error(
      `${label} entrant cohort representative revision ${revision} does not match current parent ${expectedRevision}`,
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
