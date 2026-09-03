import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import {
  resolveRunLocation,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { usesGlobalExpansionAdmission } from '../runs/expansionRuntime.js';
import { createRunId } from '../runs/run.js';
import { ResearchError } from '../shared/errors.js';

export const RESEARCH_CONTAINER_VERSION = 1;
export const RESEARCH_CONTAINER_FILE = 'research.json';

export type ResearchBatch = {
  batchId: string;
  createdAt: string;
  input: {
    kind: 'seeds' | 'microsoft';
    originalPath: string;
    storedPath: string | null;
  };
  sourceRowCount: number | null;
  inputUniqueKeywordCount: number;
  addedKeywordCount: number;
  duplicateKeywordCount: number;
  promotedKeywordCount?: number;
  normalizedKeywords: string[];
  newNormalizedKeywords: string[];
  promotedNormalizedKeywords?: string[];
  resultRunId: string;
};

export type ResearchContainer = {
  version: 1;
  researchId: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  currentRunId: string;
  batches: ResearchBatch[];
};

export type PreparedResearchAppend = {
  researchId: string;
  researchDirectory: string;
  previousRunId: string;
  currentRunId: string;
  batchId: string;
  inputUniqueKeywordCount: number;
  addedKeywordCount: number;
  duplicateKeywordCount: number;
  promotedKeywordCount: number;
  promotedNormalizedKeywords: string[];
  changed: boolean;
};

export async function acquireResearchBatchLock(
  outputRoot: string,
  targetRunId: string,
): Promise<{ researchDirectory: string; release: () => Promise<void> }> {
  const location = await resolveRunLocation(outputRoot, targetRunId);
  const researchDirectory = location.researchDirectory;
  const locksDirectory = join(outputRoot, 'index', 'research-locks');
  await mkdir(locksDirectory, { recursive: true });
  const lockId = createHash('sha256').update(resolve(researchDirectory)).digest('hex');
  const lockPath = join(locksDirectory, `${lockId}.sqlite`);
  let db: Database.Database | null = null;
  try {
    db = new Database(lockPath);
    db.pragma('journal_mode = DELETE');
    db.pragma('busy_timeout = 250');
    db.exec(`
      CREATE TABLE IF NOT EXISTS lock_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO lock_meta (singleton, schema_version) VALUES (1, 1);
      BEGIN EXCLUSIVE;
    `);
  } catch (error) {
    try { db?.close(); } catch { /* preserve original error */ }
    if (isSqliteBusy(error)) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        'Another research operation is already running for this research. Retry after it finishes.',
        { cause: error },
      );
    }
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to acquire research lock: ${lockPath}`,
      { cause: error },
    );
  }
  if (db === null) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to initialize research lock: ${lockPath}`);
  }
  const lockDb = db;
  let released = false;
  return {
    researchDirectory,
    release: async () => {
      if (released) return;
      released = true;
      try {
        lockDb.exec('COMMIT');
      } catch (error) {
        try { lockDb.exec('ROLLBACK'); } catch { /* connection may already be closed */ }
        throw new ResearchError('OUTPUT_WRITE_ERROR', 'Failed to release research lock cleanly.', { cause: error });
      } finally {
        lockDb.close();
      }
    },
  };
}

export async function prepareResearchAppend(input: {
  outputRoot: string;
  targetRunId: string;
  seedsPath: string;
  seeds: SeedKeyword[];
  now?: () => Date;
}): Promise<PreparedResearchAppend> {
  const now = input.now?.() ?? new Date();
  const targetLocation = await resolveRunLocation(input.outputRoot, input.targetRunId);
  const researchDirectory = targetLocation.researchDirectory;
  let container = await readResearchContainer(researchDirectory);

  if (container === null) {
    container = adoptExistingResearch({
      researchDirectory,
      sourceRunId: input.targetRunId,
      sourceDiscoveryDirectory: targetLocation.discoveryDirectory,
      now,
    });
  }

  const currentLocation = await resolveRunLocation(input.outputRoot, container.currentRunId);
  if (resolve(currentLocation.researchDirectory) !== resolve(researchDirectory)) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research ${container.researchId} current run points outside its research directory.`,
    );
  }

  const sourceStore = RunStore.openReadOnly(join(currentLocation.discoveryDirectory, 'run.sqlite'));
  let targetStore: RunStore | null = null;
  let newDiscoveryDirectory: string | null = null;
  let newRunId: string | null = null;
  let copiedBatchPath: string | null = null;
  let containerCommitted = false;
  try {
    const sourceRun = sourceStore.loadRun(container.currentRunId);
    if (!sourceRun) {
      throw new ResearchError('RESUME_NOT_FOUND', `Current research run not found: ${container.currentRunId}`);
    }
    if (sourceRun.state !== 'completed' && sourceRun.state !== 'completed_with_errors') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Cannot append while current run ${container.currentRunId} is ${sourceRun.state}. Resume/finish it first.`,
      );
    }
    if (
      sourceRun.parserVersions.surfer !== SURFER_PARSER_VERSION
      || sourceRun.parserVersions.google !== GOOGLE_PARSER_VERSION
    ) {
      throw new ResearchError(
        'RESUME_PARSER_MISMATCH',
        `Current research run used parser versions ${sourceRun.parserVersions.surfer}/${sourceRun.parserVersions.google}; this build uses ${SURFER_PARSER_VERSION}/${GOOGLE_PARSER_VERSION}. Start a new research instead of mixing parser generations.`,
      );
    }
    const globalExpansionAdmission = usesGlobalExpansionAdmission(sourceRun.configSnapshot);

    const sourceKeywords = sourceStore.loadKeywords(container.currentRunId);
    if (sourceKeywords.some((keyword) => !isTerminalKeywordStatus(keyword.status))) {
      throw new ResearchError(
        'DB_ERROR',
        `Current research run ${container.currentRunId} is terminal but contains non-terminal keyword checkpoints.`,
      );
    }

    const sourceByNormalized = new Map(
      sourceKeywords.map((keyword) => [keyword.normalizedKeyword, keyword] as const),
    );
    const promotedNormalizedKeywords = input.seeds
      .filter((seed) => {
        const keyword = sourceByNormalized.get(seed.normalizedKeyword);
        return keyword !== undefined && isExpansionChildKeyword(keyword);
      })
      .map((seed) => seed.normalizedKeyword);
    const promotedNormalized = new Set(promotedNormalizedKeywords);
    const newSeeds = input.seeds.filter((seed) => !sourceByNormalized.has(seed.normalizedKeyword));
    const batchNumber = container.batches.length + 1;
    const batchId = `batch-${String(batchNumber).padStart(4, '0')}`;
    const batchesDirectory = join(researchDirectory, 'batches');
    await mkdir(batchesDirectory, { recursive: true });
    const extension = extname(input.seedsPath).toLowerCase() || '.csv';
    const storedBatchPath = join(batchesDirectory, `${batchId}${extension}`);
    await rm(storedBatchPath, { force: true });
    await copyFileAtomic(resolve(input.seedsPath), storedBatchPath);
    copiedBatchPath = storedBatchPath;
    const storedBatchRelativePath = toResearchRelative(researchDirectory, storedBatchPath);
    const batchSeedByNormalized = new Map(
      input.seeds.map((seed) => [seed.normalizedKeyword, seed] as const),
    );

    const batch: ResearchBatch = {
      batchId,
      createdAt: now.toISOString(),
      input: {
        kind: 'seeds',
        originalPath: input.seedsPath,
        storedPath: storedBatchRelativePath,
      },
      sourceRowCount: input.seeds.reduce((sum, seed) => sum + seed.sourceRows.length, 0),
      inputUniqueKeywordCount: input.seeds.length,
      addedKeywordCount: newSeeds.length,
      duplicateKeywordCount: input.seeds.length - newSeeds.length,
      promotedKeywordCount: promotedNormalizedKeywords.length,
      normalizedKeywords: input.seeds.map((seed) => seed.normalizedKeyword),
      newNormalizedKeywords: newSeeds.map((seed) => seed.normalizedKeyword),
      promotedNormalizedKeywords,
      resultRunId: container.currentRunId,
    };

    if (newSeeds.length === 0 && promotedNormalized.size === 0) {
      const unchangedContainer: ResearchContainer = {
        ...container,
        updatedAt: now.toISOString(),
        batches: [...container.batches, batch],
      };
      await writeResearchContainer(researchDirectory, unchangedContainer);
      containerCommitted = true;
      return {
        researchId: unchangedContainer.researchId,
        researchDirectory,
        previousRunId: unchangedContainer.currentRunId,
        currentRunId: unchangedContainer.currentRunId,
        batchId,
        inputUniqueKeywordCount: input.seeds.length,
        addedKeywordCount: 0,
        duplicateKeywordCount: input.seeds.length,
        promotedKeywordCount: 0,
        promotedNormalizedKeywords: [],
        changed: false,
      };
    }

    newRunId = createRunId(now);
    newDiscoveryDirectory = await allocateDiscoveryVersion(researchDirectory);
    targetStore = RunStore.open(join(newDiscoveryDirectory, 'run.sqlite'));
    targetStore.createRun({
      runId: newRunId,
      configSnapshot: sourceRun.configSnapshot,
      parserVersions: sourceRun.parserVersions,
      input: { kind: 'seeds', path: join(researchDirectory, RESEARCH_CONTAINER_FILE) },
      keywords: [],
    });

    for (const sourceKeyword of sourceKeywords) {
      const duplicateSeed = batchSeedByNormalized.get(sourceKeyword.normalizedKeyword);
      const promoted = promotedNormalized.has(sourceKeyword.normalizedKeyword);
      const sources = promoted && duplicateSeed
        ? [buildBatchSeedSource(duplicateSeed, batchId, storedBatchRelativePath)]
        : duplicateSeed
          ? [
              ...sourceKeyword.sources,
              buildBatchSeedSource(duplicateSeed, batchId, storedBatchRelativePath),
            ]
          : sourceKeyword.sources;
      const created = targetStore.addKeyword(newRunId, {
        keyword: sourceKeyword.keyword,
        normalizedKeyword: sourceKeyword.normalizedKeyword,
        sources,
      });
      if (created.idx !== sourceKeyword.idx) {
        throw new ResearchError(
          'DB_ERROR',
          `Keyword index changed while forking research: ${sourceKeyword.idx} -> ${created.idx}.`,
        );
      }
    }
    for (const seed of newSeeds) {
      targetStore.addKeyword(newRunId, {
        keyword: seed.keyword,
        normalizedKeyword: seed.normalizedKeyword,
        sources: [buildBatchSeedSource(seed, batchId, storedBatchRelativePath)],
      });
    }

    const serpByKeyword = groupByKeywordIdx(sourceStore.loadSerpRows(container.currentRunId));
    for (const sourceKeyword of sourceKeywords) {
      if (promotedNormalized.has(sourceKeyword.normalizedKeyword)) continue;
      const targetKeyword = targetStore.loadKeyword(newRunId, sourceKeyword.idx);
      if (!targetKeyword) {
        throw new ResearchError('DB_ERROR', `Forked keyword ${sourceKeyword.idx} was not persisted.`);
      }
      targetStore.commitKeyword(
        newRunId,
        {
          ...targetKeyword,
          status: sourceKeyword.status,
          surfer: sourceKeyword.surfer,
          google: sourceKeyword.google,
          error: sourceKeyword.error,
          collectedAt: sourceKeyword.collectedAt,
          cacheStatus: sourceKeyword.cacheStatus,
        },
        serpByKeyword.get(sourceKeyword.idx) ?? [],
        sourceKeyword.cacheStatus,
      );
    }

    const promotedIdxs = new Set(
      sourceKeywords
        .filter((keyword) => promotedNormalized.has(keyword.normalizedKeyword))
        .map((keyword) => keyword.idx),
    );
    copyRelatedEvidence(
      sourceStore,
      targetStore,
      container.currentRunId,
      newRunId,
      {
        excludedParentIdxs: promotedIdxs,
        preserveSelectedForExpansion: !globalExpansionAdmission,
      },
    );
    copyDomainEvidence(
      sourceStore,
      targetStore,
      container.currentRunId,
      newRunId,
      sourceKeywords
        .filter((keyword) => !promotedNormalized.has(keyword.normalizedKeyword))
        .map((keyword) => ({ idx: keyword.idx, keyword: keyword.keyword })),
      serpByKeyword,
    );
    for (let index = 0; index < sourceRun.lookups; index += 1) {
      targetStore.incrementLookups(newRunId);
    }

    targetStore.close();
    targetStore = null;
    try {
      await writeRunIndex(input.outputRoot, {
        version: 1,
        runId: newRunId,
        researchDirectory,
        discoveryDirectory: newDiscoveryDirectory,
      });
    } catch (error) {
      await rm(newDiscoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
      newDiscoveryDirectory = null;
      throw error;
    }

    batch.resultRunId = newRunId;
    const nextContainer: ResearchContainer = {
      ...container,
      updatedAt: now.toISOString(),
      currentRunId: newRunId,
      batches: [...container.batches, batch],
    };
    try {
      await writeResearchContainer(researchDirectory, nextContainer);
      containerCommitted = true;
    } catch (error) {
      await removeRunIndex(input.outputRoot, newRunId);
      await rm(newDiscoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
      newDiscoveryDirectory = null;
      throw error;
    }

    return {
      researchId: nextContainer.researchId,
      researchDirectory,
      previousRunId: container.currentRunId,
      currentRunId: newRunId,
      batchId,
      inputUniqueKeywordCount: input.seeds.length,
      addedKeywordCount: newSeeds.length,
      duplicateKeywordCount: input.seeds.length - newSeeds.length,
      promotedKeywordCount: promotedNormalizedKeywords.length,
      promotedNormalizedKeywords,
      changed: true,
    };
  } catch (error) {
    if (targetStore) targetStore.close();
    if (!containerCommitted && newDiscoveryDirectory) {
      if (newRunId) await removeRunIndex(input.outputRoot, newRunId);
      await rm(newDiscoveryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    if (copiedBatchPath && !(await manifestReferencesBatch(researchDirectory, copiedBatchPath))) {
      await rm(copiedBatchPath, { force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    sourceStore.close();
  }
}

export async function readResearchContainer(researchDirectory: string): Promise<ResearchContainer | null> {
  try {
    const value = JSON.parse(await readFile(join(researchDirectory, RESEARCH_CONTAINER_FILE), 'utf8')) as unknown;
    return validateContainer(value, researchDirectory);
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof ResearchError) throw error;
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to read ${join(researchDirectory, RESEARCH_CONTAINER_FILE)}.`,
      { cause: error },
    );
  }
}

function adoptExistingResearch(input: {
  researchDirectory: string;
  sourceRunId: string;
  sourceDiscoveryDirectory: string;
  now: Date;
}): ResearchContainer {
  const store = RunStore.openReadOnly(join(input.sourceDiscoveryDirectory, 'run.sqlite'));
  try {
    const run = store.loadRun(input.sourceRunId);
    if (!run) {
      throw new ResearchError('RESUME_NOT_FOUND', `Run not found while adopting research: ${input.sourceRunId}`);
    }
    return buildAdoptedContainer(
      input.researchDirectory,
      run,
      store.loadKeywords(input.sourceRunId),
      input.now,
    );
  } finally {
    store.close();
  }
}

function buildAdoptedContainer(
  researchDirectory: string,
  run: NonNullable<ReturnType<RunStore['loadRun']>>,
  keywords: ReturnType<RunStore['loadKeywords']>,
  now: Date,
): ResearchContainer {
  const rootKeywords = keywords.filter(
    (keyword) => !keyword.sources.some((source) => source.type === 'surfer_related'),
  );
  return {
    version: RESEARCH_CONTAINER_VERSION,
    researchId: run.runId,
    label: basename(researchDirectory),
    createdAt: run.createdAt,
    updatedAt: now.toISOString(),
    currentRunId: run.runId,
    batches: [
      {
        batchId: 'batch-0001',
        createdAt: run.createdAt,
        input: {
          kind: run.input.kind,
          originalPath: run.input.path,
          storedPath: null,
        },
        sourceRowCount: null,
        inputUniqueKeywordCount: rootKeywords.length,
        addedKeywordCount: rootKeywords.length,
        duplicateKeywordCount: 0,
        promotedKeywordCount: 0,
        normalizedKeywords: rootKeywords.map((keyword) => keyword.normalizedKeyword),
        newNormalizedKeywords: rootKeywords.map((keyword) => keyword.normalizedKeyword),
        promotedNormalizedKeywords: [],
        resultRunId: run.runId,
      },
    ],
  };
}

async function writeResearchContainer(
  researchDirectory: string,
  container: ResearchContainer,
): Promise<void> {
  const path = join(researchDirectory, RESEARCH_CONTAINER_FILE);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(container, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to write research container ${path}.`, { cause: error });
  }
}

async function allocateDiscoveryVersion(researchDirectory: string): Promise<string> {
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = join(researchDirectory, `discovery-${String(suffix).padStart(2, '0')}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') continue;
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to allocate discovery version ${candidate}.`, { cause: error });
    }
  }
  throw new ResearchError('OUTPUT_WRITE_ERROR', `Could not allocate another discovery version in ${researchDirectory}.`);
}

function copyRelatedEvidence(
  source: RunStore,
  target: RunStore,
  sourceRunId: string,
  targetRunId: string,
  options: {
    excludedParentIdxs?: ReadonlySet<number>;
    preserveSelectedForExpansion?: boolean;
  } = {},
): void {
  const excludedParentIdxs = options.excludedParentIdxs ?? new Set<number>();
  const preserveSelectedForExpansion = options.preserveSelectedForExpansion ?? true;
  const groups = new Map<number, ReturnType<RunStore['loadRelatedKeywords']>>();
  for (const row of source.loadRelatedKeywords(sourceRunId)) {
    if (excludedParentIdxs.has(row.parentIdx)) continue;
    const rows = groups.get(row.parentIdx) ?? [];
    rows.push(row);
    groups.set(row.parentIdx, rows);
  }
  for (const [parentIdx, rows] of groups) {
    const first = rows[0];
    if (!first) continue;
    const okRows = rows.filter((row) => row.status === 'ok' && row.relatedKeyword !== '');
    if (okRows.length > 0) {
      target.recordRelatedKeywords(
        targetRunId,
        parentIdx,
        first.parentKeyword,
        {
          status: 'ok',
          error: null,
          rows: okRows.map((row) => ({
            keyword: row.relatedKeyword,
            overlap: row.overlap,
            volume: row.volume,
          })),
        },
        new Set(
          preserveSelectedForExpansion
            ? okRows.filter((row) => row.selectedForExpansion).map((row) => row.relatedKeyword)
            : [],
        ),
      );
    } else {
      target.recordRelatedKeywords(
        targetRunId,
        parentIdx,
        first.parentKeyword,
        { status: first.status, error: first.error, rows: [] },
        new Set(),
      );
    }
  }
}

function copyDomainEvidence(
  source: RunStore,
  target: RunStore,
  sourceRunId: string,
  targetRunId: string,
  keywords: Array<{ idx: number; keyword: string }>,
  serpByKeyword: Map<number, ReturnType<RunStore['loadSerpRows']>>,
): void {
  const domainMeta = new Map(source.loadDomains(sourceRunId).map((domain) => [domain.domain, domain]));
  for (const keyword of [...keywords].sort((a, b) => a.idx - b.idx)) {
    const rows = serpByKeyword.get(keyword.idx) ?? [];
    const sourceByDomain = new Map<string, { source: 'cache' | 'fresh' | 'none'; fetchedAt: string | null }>();
    for (const row of rows) {
      const meta = domainMeta.get(row.registrableDomain);
      if (meta) sourceByDomain.set(row.registrableDomain, { source: meta.source, fetchedAt: meta.fetchedAt });
    }
    target.recordDomains(targetRunId, keyword.idx, keyword.keyword, rows, sourceByDomain);
  }
}

function groupByKeywordIdx<T extends { keywordIdx?: number }>(rows: T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const keywordIdx = row.keywordIdx;
    if (keywordIdx === undefined) {
      throw new ResearchError('DB_ERROR', 'Persisted SERP row has no keyword owner index while forking research.');
    }
    const group = groups.get(keywordIdx) ?? [];
    group.push(row);
    groups.set(keywordIdx, group);
  }
  return groups;
}

function buildBatchSeedSource(seed: SeedKeyword, batchId: string, inputPath: string) {
  return {
    type: 'seed' as const,
    rowNumbers: seed.sourceRows,
    batchId,
    inputPath,
  };
}

function isExpansionChildKeyword(keyword: { sources: ReadonlyArray<{ type: string }> }): boolean {
  return keyword.sources.some((source) => source.type === 'surfer_related');
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  const tempPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  try {
    await copyFile(source, tempPath);
    await rename(tempPath, target);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to preserve batch input ${source}.`, { cause: error });
  }
}

function toResearchRelative(researchDirectory: string, path: string): string {
  const rel = relative(resolve(researchDirectory), resolve(path));
  if (rel.startsWith('..')) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Batch path escaped research directory: ${path}`);
  }
  return rel.split(sep).join('/');
}

function validateContainer(value: unknown, researchDirectory: string): ResearchContainer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Invalid research container in ${researchDirectory}.`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== RESEARCH_CONTAINER_VERSION
    || typeof record.researchId !== 'string'
    || typeof record.label !== 'string'
    || typeof record.createdAt !== 'string'
    || typeof record.updatedAt !== 'string'
    || typeof record.currentRunId !== 'string'
    || !Array.isArray(record.batches)
  ) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt research container in ${researchDirectory}.`);
  }
  return value as ResearchContainer;
}

async function manifestReferencesBatch(researchDirectory: string, batchPath: string): Promise<boolean> {
  const container = await readResearchContainer(researchDirectory).catch(() => null);
  if (!container) return false;
  const rel = toResearchRelative(researchDirectory, batchPath);
  return container.batches.some((batch) => batch.input.storedPath === rel);
}

async function removeRunIndex(outputRoot: string, runId: string): Promise<void> {
  await rm(join(outputRoot, 'index', 'runs', `${runId}.json`), { force: true }).catch(() => undefined);
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED');
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
