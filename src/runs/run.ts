import { mkdir, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';

export type RunState =
  | 'created'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'cancelled';

export type KeywordStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed';

export const TERMINAL_KEYWORD_STATUSES: ReadonlySet<KeywordStatus> = new Set([
  'completed',
  'partial',
  'failed',
]);

export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  'completed',
  'completed_with_errors',
  'failed',
  'cancelled',
]);

export const RESUMABLE_RUN_STATES: ReadonlySet<RunState> = new Set(['created', 'running', 'paused']);

export type RunManifest = {
  runId: string;
  createdAt: string;
  updatedAt: string;
  state: RunState;
  input: {
    kind: 'seeds';
    path: string;
  };
  configSnapshot: ResearchConfig;
  parserVersions: {
    surfer: string;
    google: string;
  };
  pauseReason: string | null;
  progress: {
    totalKeywords: number;
    completedKeywords: number;
    partialKeywords: number;
    failedKeywords: number;
    errors: number;
    lookups: number;
    cache: {
      hits: number;
      misses: number;
      expired: number;
      refreshed: number;
      // Share of processed keywords served from the cache, same calculation
      // as the live CLI progress line (rounded percent).
      hitRatePercent: number;
    };
  };
};

export type KeywordRecord = {
  id: string;
  keyword: string;
  normalizedKeyword: string;
  sources: Array<{ type: 'seed'; rowNumbers: number[] }>;
  surfer: {
    volume: number | null;
    cpc: number | null;
    market: string;
    fetchedAt: string;
  } | null;
  google: {
    hl: string;
    gl: string;
    pageUrl: string;
    detectedLocation: string | null;
    geoWarning: boolean;
  } | null;
  status: KeywordStatus;
  error: { code: ResearchErrorCode; message: string } | null;
};

export type UuidFactory = () => string;

// Keep the complete UUID so uniqueness does not depend on a shortened entropy
// fragment. The factory parameter makes the format deterministic in tests.
export function createRunId(
  date: Date = new Date(),
  uuidFactory: UuidFactory = randomUUID,
): string {
  const base = date.toISOString().replace(/[-:T.]/g, '').replace(/Z$/, '');
  return `${base}_${uuidFactory()}`;
}

export function keywordSlug(keyword: string): string {
  const slug = keyword
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, 60) || 'keyword';
}

export function buildKeywordRecords(keywords: SeedKeyword[]): KeywordRecord[] {
  return keywords.map((seed, index) => ({
    id: `kw-${String(index + 1).padStart(4, '0')}`,
    keyword: seed.keyword,
    normalizedKeyword: seed.normalizedKeyword,
    sources: [{ type: 'seed', rowNumbers: seed.sourceRows }],
    surfer: null,
    google: null,
    status: 'pending',
    error: null,
  }));
}

export async function ensureWritableDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true });
    const probePath = `${directory}/.write-probe`;
    await writeFile(probePath, 'ok', 'utf8');
    await rm(probePath, { force: true });
  } catch (error) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Directory "${directory}" is not writable.`,
      { cause: error },
    );
  }
}

export async function createRunDirectory(directory: string): Promise<void> {
  try {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory);

    const probePath = `${directory}/.write-probe`;
    await writeFile(probePath, 'ok', 'utf8');
    await rm(probePath, { force: true });
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Run directory "${directory}" already exists; refusing to overwrite an existing run.`,
        { cause: error },
      );
    }

    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to create writable run directory "${directory}".`,
      { cause: error },
    );
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

export async function writeJsonAtomic(
  path: string,
  data: unknown,
  description: string,
): Promise<void> {
  let content: string;
  try {
    content = `${JSON.stringify(data, null, 2)}\n`;
  } catch (error) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to serialize ${description} for "${path}".`,
      { cause: error },
    );
  }
  await writeTextAtomic(path, content, description);
}

// Atomic text publication with the same recoverable semantics as JSON: write
// to a temp file, rename over the target, and clean the temp file up on
// failure, so a crash or an error never exposes a partially-written target.
export async function writeTextAtomic(
  path: string,
  content: string,
  description: string,
): Promise<void> {
  const tempPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(tempPath, content, 'utf8');
    await renameImpl(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to atomically write ${description} to "${path}".`,
      { cause: error },
    );
  }
}

// Test seam: lets tests force a deterministic rename failure without deleting
// the target file first (which would not prove the existing file is preserved).
let renameImpl: (oldPath: string, newPath: string) => Promise<void> = fsRename;

export function setRenameForTesting(fn: (oldPath: string, newPath: string) => Promise<void>): void {
  renameImpl = fn;
}
