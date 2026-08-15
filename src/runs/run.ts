import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ResearchError, type ResearchErrorCode } from '../shared/errors.js';
import type { ResearchConfig } from '../config/config.js';
import type { SeedKeyword } from '../input/seeds/normalize.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';

export type RunState = 'created' | 'running' | 'completed' | 'completed_with_errors' | 'failed';

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
  progress: {
    totalKeywords: number;
    completedKeywords: number;
    errors: number;
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
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  error: { code: ResearchErrorCode; message: string } | null;
};

// Millisecond precision plus a randomUUID fragment make collisions
// effectively impossible even for two runs started in the same instant.
export function createRunId(date: Date = new Date()): string {
  const base = date.toISOString().replace(/[-:T.]/g, '').replace(/Z$/, '');
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  return `${base}_${suffix}`;
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

export async function writeJsonFile(
  path: string,
  data: unknown,
  description: string,
): Promise<void> {
  try {
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Failed to write ${description} to "${path}".`,
      { cause: error },
    );
  }
}