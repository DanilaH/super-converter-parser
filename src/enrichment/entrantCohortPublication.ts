import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writeTextAtomic } from '../runs/run.js';
import type { ResearchConfig } from '../config/config.js';
import { COHORT_HISTORY_ARTIFACTS } from './cohortHistoryPublication.js';
import { FINALIST_EVIDENCE_ARTIFACTS } from './finalistEvidencePublication.js';
import { TRAFFIC_EVIDENCE_ARTIFACTS } from './trafficEvidencePublication.js';
import { COHORT_HISTORICAL_PRESENCE_ARTIFACTS } from '../historicalPresence/cohortPublication.js';

export const ENTRANT_COHORT_ARTIFACTS = [
  'entrant-cohort.csv',
  'entrant-cohort-occurrences.csv',
  'entrant-cohort.json',
] as const;

const ENTRANT_DEPENDENT_ARTIFACTS = [
  ...COHORT_HISTORICAL_PRESENCE_ARTIFACTS,
  ...COHORT_HISTORY_ARTIFACTS,
  ...TRAFFIC_EVIDENCE_ARTIFACTS,
  ...FINALIST_EVIDENCE_ARTIFACTS,
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

  const manifestBase = input.summary.changed ? withoutEntrantDependents(manifest) : manifest;
  const statusBase = input.summary.changed ? withoutEntrantDependents(status) : status;
  const manifestArtifacts = uniqueStrings([
    ...filterInvalidatedDependentArtifacts(
      readStringArray(manifestBase.artifacts, 'manifest.json artifacts'),
      input.summary.changed,
    ),
    ...ENTRANT_COHORT_ARTIFACTS,
  ]);
  const statusArtifacts = uniqueStrings([
    ...filterInvalidatedDependentArtifacts(
      readStringArray(statusBase.artifacts, 'status.json artifacts'),
      input.summary.changed,
    ),
    ...ENTRANT_COHORT_ARTIFACTS,
  ]);

  const nextManifest: Record<string, unknown> = {
    ...manifestBase,
    artifacts: manifestArtifacts,
    entrantCohort: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...statusBase,
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

  if (input.summary.changed) {
    await Promise.all(
      ENTRANT_DEPENDENT_ARTIFACTS.map((artifact) =>
        rm(join(input.enrichmentDirectory, artifact), { force: true })),
    );
  }
}

function withoutEntrantDependents(value: Record<string, unknown>): Record<string, unknown> {
  const {
    historicalPresence: _historicalPresence,
    cohortHistory: _cohortHistory,
    trafficEvidence: _trafficEvidence,
    finalistEvidence: _finalistEvidence,
    ...rest
  } = value;
  return rest;
}

function filterInvalidatedDependentArtifacts(values: string[], changed: boolean): string[] {
  if (!changed) return values;
  const invalid = new Set<string>(ENTRANT_DEPENDENT_ARTIFACTS);
  return values.filter((value) => !invalid.has(value));
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
