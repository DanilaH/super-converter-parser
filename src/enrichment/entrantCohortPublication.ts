import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeTextAtomic } from '../runs/run.js';
import type { ResearchConfig } from '../config/config.js';

export const ENTRANT_COHORT_ARTIFACTS = [
  'entrant-cohort.csv',
  'entrant-cohort-occurrences.csv',
  'entrant-cohort.json',
] as const;

export type EntrantCohortPublicationSummary = {
  changed: boolean;
  version: string;
  representativeRevision: number;
  serpTopN: number;
  finalistClusterCount: number;
  uniqueDomainCount: number;
  observedOccurrenceCount: number;
  excludedOccurrenceCount: number;
  weakDomainCount: number;
  knownDrDomainCount: number;
  repeatedDomainCount: number;
  survivorshipWarning: string;
  drThresholds: ResearchConfig['scoring']['drThresholds'];
};

export async function publishEntrantCohortMetadata(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  summary: EntrantCohortPublicationSummary;
}): Promise<void> {
  const manifestPath = join(input.enrichmentDirectory, 'manifest.json');
  const statusPath = join(input.enrichmentDirectory, 'status.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  const originalStatus = await readFile(statusPath, 'utf8');
  const manifest = parsePublishedJson(originalManifest, 'manifest.json');
  const status = parsePublishedJson(originalStatus, 'status.json');

  assertArtifactIdentity(manifest, input.enrichmentId, input.sourceRunId, 'manifest.json');
  assertArtifactIdentity(status, input.enrichmentId, input.sourceRunId, 'status.json');
  if (manifest.state !== 'completed' || status.status !== 'completed') {
    throw new Error('Entrant cohort publication requires a completed enrichment publication');
  }
  assertRepresentativeRevision(manifest, input.summary.representativeRevision, 'manifest.json');
  assertRepresentativeRevision(status, input.summary.representativeRevision, 'status.json');

  const manifestArtifacts = uniqueStrings([
    ...readStringArray(manifest.artifacts, 'manifest.json artifacts'),
    ...ENTRANT_COHORT_ARTIFACTS,
  ]);
  const statusArtifacts = uniqueStrings([
    ...readStringArray(status.artifacts, 'status.json artifacts'),
    ...ENTRANT_COHORT_ARTIFACTS,
  ]);

  const nextManifest: Record<string, unknown> = {
    ...manifest,
    artifacts: manifestArtifacts,
    entrantCohort: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...status,
    artifacts: statusArtifacts,
    entrantCohort: input.summary,
  };

  await writeTextAtomic(
    statusPath,
    JSON.stringify(nextStatus, null, 2) + '\n',
    'enrichment status with entrant cohort',
  );
  try {
    await writeTextAtomic(
      manifestPath,
      JSON.stringify(nextManifest, null, 2) + '\n',
      'enrichment manifest with entrant cohort',
    );
  } catch (error) {
    await writeTextAtomic(statusPath, originalStatus, 'restore enrichment status').catch(() => undefined);
    throw error;
  }
}

function assertRepresentativeRevision(
  value: Record<string, unknown>,
  expectedRevision: number,
  label: string,
): void {
  if (!isRecord(value.representativeQueries)) {
    throw new Error(`${label} has no published representative-query metadata`);
  }
  const revision = value.representativeQueries.revision;
  if (revision !== expectedRevision) {
    throw new Error(
      `${label} representative revision ${String(revision)} does not match entrant cohort revision ${expectedRevision}`,
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

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
