import { access, readFile, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { outputLayout } from '../outputs/researchLayout.js';
import { readResearchContainer } from '../research/batches.js';
import { ResearchError } from '../shared/errors.js';

export type ResearchCatalogItem = {
  researchId: string;
  label: string;
  currentRunId: string;
  knownRunIds: string[];
  batchCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  researchDirectory: string;
  managed: boolean;
  operatorConfigAvailable: boolean;
};

type RunIndexRecord = {
  version: 1;
  runId: string;
  researchDirectory: string;
  discoveryDirectory: string;
};

export async function listResearchCatalog(outputRoot: string): Promise<ResearchCatalogItem[]> {
  const root = resolve(outputRoot);
  const runsIndexDirectory = join(outputLayout(root).index, 'runs');
  let names: string[];
  try {
    names = (await readdir(runsIndexDirectory))
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to list run indexes under ${runsIndexDirectory}.`, { cause: error });
  }

  const grouped = new Map<string, RunIndexRecord[]>();
  for (const name of names) {
    const path = join(runsIndexDirectory, name);
    const expectedRunId = name.slice(0, -'.json'.length);
    const record = await readRunIndex(path, expectedRunId);
    assertWithin(root, record.researchDirectory, path);
    assertWithin(record.researchDirectory, record.discoveryDirectory, path);
    const researchDirectory = resolve(record.researchDirectory);
    const records = grouped.get(researchDirectory) ?? [];
    records.push(record);
    grouped.set(researchDirectory, records);
  }

  const items: ResearchCatalogItem[] = [];
  for (const [researchDirectory, records] of grouped) {
    const knownRunIds = [...new Set(records.map((record) => record.runId))]
      .sort((a, b) => a.localeCompare(b));
    const container = await readResearchContainer(researchDirectory);
    const operatorConfigAvailable = await exists(join(researchDirectory, 'operator-config.json'));

    if (container !== null) {
      if (!knownRunIds.includes(container.researchId) || !knownRunIds.includes(container.currentRunId)) {
        throw new ResearchError(
          'OUTPUT_WRITE_ERROR',
          `Research ${container.researchId} references a run missing from the canonical run index.`,
        );
      }
      items.push({
        researchId: container.researchId,
        label: container.label,
        currentRunId: container.currentRunId,
        knownRunIds,
        batchCount: container.batches.length,
        createdAt: container.createdAt,
        updatedAt: container.updatedAt,
        researchDirectory,
        managed: true,
        operatorConfigAvailable,
      });
      continue;
    }

    // A directory without research.json has no durable container lineage. Do not
    // invent one merely because multiple historical run indexes happen to point
    // into the same directory; expose each indexed run independently.
    for (const record of records.sort((a, b) => a.runId.localeCompare(b.runId))) {
      items.push({
        researchId: record.runId,
        label: basename(researchDirectory),
        currentRunId: record.runId,
        knownRunIds: [record.runId],
        batchCount: 1,
        createdAt: null,
        updatedAt: null,
        researchDirectory,
        managed: false,
        operatorConfigAvailable,
      });
    }
  }

  return items.sort(compareCatalogItems);
}

async function readRunIndex(path: string, expectedRunId: string): Promise<RunIndexRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to read run output index ${path}.`, { cause: error });
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.runId !== 'string'
    || typeof parsed.researchDirectory !== 'string'
    || typeof parsed.discoveryDirectory !== 'string'
  ) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Invalid run output index ${path}.`);
  }
  if (parsed.runId !== expectedRunId) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Run output index ${path} identifies ${parsed.runId}, not ${expectedRunId}.`,
    );
  }
  return parsed as RunIndexRecord;
}

function assertWithin(parent: string, child: string, source: string): void {
  const rel = relative(resolve(parent), resolve(child));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Run output index ${source} points outside its allowed root: ${child}`);
  }
}

function compareCatalogItems(a: ResearchCatalogItem, b: ResearchCatalogItem): number {
  if (a.updatedAt !== null && b.updatedAt !== null && a.updatedAt !== b.updatedAt) {
    return b.updatedAt.localeCompare(a.updatedAt);
  }
  if (a.updatedAt !== null) return -1;
  if (b.updatedAt !== null) return 1;
  const label = a.label.localeCompare(b.label);
  return label !== 0 ? label : a.researchId.localeCompare(b.researchId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
