import { mkdir, rename as fsRename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import type {
  MicrosoftAggregate,
  MicrosoftKeyword,
  MicrosoftOccurrence,
} from '../input/microsoft/normalize.js';
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
    kind: 'seeds' | 'microsoft';
    path: string;
  };
  configSnapshot: ResearchConfig;
  parserVersions: {
    surfer: string;
    google: string;
  };
  scoringVersion: string;
  pauseReason: string | null;
  ahrefs: {
    mode: 'required' | 'optional';
    state: 'complete' | 'degraded' | 'skipped' | 'failed';
    discovered: number;
    attempted: number;
    notAttempted: number;
    cache: number;
    fresh: number;
    ok: number;
    notFound: number;
    error: number;
    numericCoverage: number;
    requireAhrefs: boolean;
  };
  scoringCompleteness: {
    status: 'complete' | 'degraded';
    numericDrCoverage: number;
    missingDrDomains: number;
  };
  progress: {
    totalKeywords: number;
    completedKeywords: number;
    partialKeywords: number;
    failedKeywords: number;
    errors: number;
    lookups: number;
    totalDomains: number;
    completedDomains: number;
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

// One preserved Microsoft source row. It carries the full occurrence (not just
// the row number), so duplicate keywords keep every contributing row's ad
// group, volume, competition, and CPC provenance.
export type MicrosoftSource = { type: 'microsoft' } & MicrosoftOccurrence;

export type KeywordSource =
  | { type: 'seed'; rowNumbers: number[] }
  | MicrosoftSource
  | { type: 'surfer_related'; parentKeyword: string; overlap?: number | null; rowNumbers?: number[] };

export type KeywordRecord = {
  id: string;
  keyword: string;
  normalizedKeyword: string;
  sources: KeywordSource[];
  microsoft?: MicrosoftAggregate | null;
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

export function buildKeywordRecords(
  keywords: SeedKeyword[] | MicrosoftKeyword[],
  kind: 'seeds' | 'microsoft',
): KeywordRecord[] {
  return keywords.map((item, index) => {
    if (kind === 'microsoft') {
      const microsoft = item as MicrosoftKeyword;
      return {
        id: `kw-${String(index + 1).padStart(4, '0')}`,
        keyword: microsoft.keyword,
        normalizedKeyword: microsoft.normalizedKeyword,
        sources: microsoft.occurrences.map((occurrence) => ({ type: 'microsoft', ...occurrence })),
        microsoft: microsoft.microsoft,
        surfer: null,
        google: null,
        status: 'pending',
        error: null,
      };
    }

    const seed = item as SeedKeyword;
    return {
      id: `kw-${String(index + 1).padStart(4, '0')}`,
      keyword: seed.keyword,
      normalizedKeyword: seed.normalizedKeyword,
      sources: [{ type: 'seed', rowNumbers: seed.sourceRows }],
      microsoft: null,
      surfer: null,
      google: null,
      status: 'pending',
      error: null,
    };
  });
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
