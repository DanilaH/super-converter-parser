import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import type { CohortHistoricalPresenceSnapshot } from '../db/cohortHistoricalPresence.js';
import { invalidateFinalistEvidencePublication } from '../enrichment/finalistEvidencePublication.js';
import { writeTextAtomic } from '../runs/run.js';

export const COHORT_HISTORICAL_PRESENCE_ARTIFACTS = [
  'cohort-historical-presence.csv',
  'cohort-historical-presence.json',
] as const;

type PublicationContext = {
  manifestPath: string;
  statusPath: string;
  originalManifest: string;
  originalStatus: string;
  manifest: Record<string, unknown>;
  status: Record<string, unknown>;
};

export async function publishCohortHistoricalPresenceMetadata(input: {
  enrichmentDirectory: string;
  snapshot: CohortHistoricalPresenceSnapshot;
  snapshotFingerprint: string;
  changed: boolean;
}): Promise<void> {
  let context = await loadPublicationContext(input.enrichmentDirectory, input.snapshot);
  if (input.changed) {
    await invalidateFinalistEvidencePublication({
      enrichmentDirectory: input.enrichmentDirectory,
      enrichmentId: input.snapshot.enrichmentId,
      sourceRunId: input.snapshot.sourceRunId,
    });
    context = await loadPublicationContext(input.enrichmentDirectory, input.snapshot);
  }

  const metadata = {
    changed: input.changed,
    version: input.snapshot.collectionVersion,
    snapshotFingerprint: input.snapshotFingerprint,
    provider: input.snapshot.config.provider,
    queryVersion: input.snapshot.config.queryVersion,
    collectionMode: input.snapshot.config.collectionMode,
    recentMonths: input.snapshot.config.recentMonths,
    maxCollections: input.snapshot.config.maxCollections,
    domainCap: input.snapshot.config.domainCap,
    entrantRepresentativeRevision: input.snapshot.entrantRepresentativeRevision,
    entrantFingerprint: input.snapshot.entrantFingerprint,
    ...input.snapshot.collection.summary,
    semantics: 'bounded_sampled_web_presence_not_exact_first_seen',
  };

  const nextManifest = {
    ...context.manifest,
    artifacts: uniqueStrings([
      ...readStringArray(context.manifest.artifacts, 'manifest.json artifacts'),
      ...COHORT_HISTORICAL_PRESENCE_ARTIFACTS,
    ]),
    historicalPresence: metadata,
  };
  const nextStatus = {
    ...context.status,
    artifacts: uniqueStrings([
      ...readStringArray(context.status.artifacts, 'status.json artifacts'),
      ...COHORT_HISTORICAL_PRESENCE_ARTIFACTS,
    ]),
    historicalPresence: metadata,
  };

  await writeTextAtomic(
    context.statusPath,
    `${JSON.stringify(nextStatus, null, 2)}\n`,
    'enrichment status with sampled historical presence',
  );
  try {
    await writeTextAtomic(
      context.manifestPath,
      `${JSON.stringify(nextManifest, null, 2)}\n`,
      'enrichment manifest with sampled historical presence',
    );
  } catch (error) {
    await writeTextAtomic(context.statusPath, context.originalStatus, 'restore enrichment status').catch(() => undefined);
    throw error;
  }
}

async function loadPublicationContext(
  enrichmentDirectory: string,
  snapshot: CohortHistoricalPresenceSnapshot,
): Promise<PublicationContext> {
  const manifestPath = join(enrichmentDirectory, 'manifest.json');
  const statusPath = join(enrichmentDirectory, 'status.json');
  const entrantPath = join(enrichmentDirectory, 'entrant-cohort.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const originalStatus = await readFile(statusPath, 'utf8');
  const manifest = parseObject(originalManifest, 'manifest.json');
  const status = parseObject(originalStatus, 'status.json');
  const entrant = parseObject(await readFile(entrantPath, 'utf8'), 'entrant-cohort.json');

  assertIdentity(manifest, snapshot, 'manifest.json');
  assertIdentity(status, snapshot, 'status.json');
  assertIdentity(entrant, snapshot, 'entrant-cohort.json');
  if (manifest.state !== 'completed' || status.status !== 'completed') {
    throw new Error('Sampled historical-presence publication requires a completed enrichment publication.');
  }

  const publishedFingerprint = fingerprintPublishedEntrant(entrant);
  if (publishedFingerprint !== snapshot.entrantFingerprint) {
    throw new Error(
      `entrant-cohort.json fingerprint ${publishedFingerprint} does not match sampled historical-presence parent ${snapshot.entrantFingerprint}`,
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
    drThresholds: readObject(value.drThresholds, 'entrant-cohort.json drThresholds') as EntrantCohortSnapshot['drThresholds'],
    sourceRunUpdatedAt: readString(value.sourceRunUpdatedAt, 'entrant-cohort.json sourceRunUpdatedAt'),
    clusteringUpdatedAt: readString(value.clusteringUpdatedAt, 'entrant-cohort.json clusteringUpdatedAt'),
    cohorts: readArray(value.cohorts, 'entrant-cohort.json cohorts') as EntrantCohortSnapshot['cohorts'],
  };
  return entrantCohortFingerprint(snapshot);
}

function assertIdentity(
  value: Record<string, unknown>,
  snapshot: CohortHistoricalPresenceSnapshot,
  label: string,
): void {
  if (value.enrichmentId !== snapshot.enrichmentId || value.sourceRunId !== snapshot.sourceRunId) {
    throw new Error(`${label} does not belong to enrichment ${snapshot.enrichmentId} / source run ${snapshot.sourceRunId}.`);
  }
}

function parseObject(content: string, label: string): Record<string, unknown> {
  try {
    return readObject(JSON.parse(content) as unknown, label);
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${label} must be a string array.`);
  return value as string[];
}

function readString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function readInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
  return value as number;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
