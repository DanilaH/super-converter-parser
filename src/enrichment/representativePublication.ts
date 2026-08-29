import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeTextAtomic } from '../runs/run.js';
import type { RepresentativeQueryRunConfigSnapshot } from './types.js';

export type RepresentativePublicationSummary = {
  revision: number;
  changed: boolean;
  setVersion: string;
  targetCount: number;
  setCount: number;
  queryCount: number;
  manualOverrideCount: number;
};

export async function publishRepresentativeMetadata(input: {
  enrichmentDirectory: string;
  enrichmentId: string;
  sourceRunId: string;
  config: RepresentativeQueryRunConfigSnapshot;
  summary: RepresentativePublicationSummary;
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
    throw new Error('Representative queries require a completed enrichment publication');
  }
  if (!isRecord(manifest.config)) {
    throw new Error('manifest.json config must be an object');
  }

  const artifacts = uniqueStrings([
    ...readStringArray(manifest.artifacts, 'manifest.json artifacts'),
    'representative-queries.csv',
    'representative-queries.json',
  ]);
  const statusArtifacts = uniqueStrings([
    ...readStringArray(status.artifacts, 'status.json artifacts'),
    'representative-queries.csv',
    'representative-queries.json',
  ]);

  const nextManifest: Record<string, unknown> = {
    ...manifest,
    config: {
      ...manifest.config,
      representative_queries: input.config,
    },
    artifacts,
    representativeQueries: input.summary,
  };
  const nextStatus: Record<string, unknown> = {
    ...status,
    artifacts: statusArtifacts,
    representativeQueries: input.summary,
  };

  await writeTextAtomic(
    statusPath,
    JSON.stringify(nextStatus, null, 2) + '\n',
    'enrichment status with representative queries',
  );
  try {
    await writeTextAtomic(
      manifestPath,
      JSON.stringify(nextManifest, null, 2) + '\n',
      'enrichment manifest with representative queries',
    );
  } catch (error) {
    await writeTextAtomic(statusPath, originalStatus, 'restore enrichment status').catch(() => undefined);
    throw error;
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
