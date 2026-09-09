import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendResearchBatch,
  previewResearchBatch,
  type ResearchBatchExecutionResultV1,
  type ResearchBatchOptions,
} from '../application/researchBatches.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { ResearchError } from '../shared/errors.js';
import { ensureResearchChromeForDiscovery } from './researchChromeDiscovery.js';

export type UiBatchDraftV1 = {
  version: 1;
  keywords: string;
};

export type UiBatchPlanPreviewV1 = {
  version: 1;
  researchId: string;
  currentRunId: string;
  batchId: string;
  inputLineCount: number;
  inputUniqueKeywordCount: number;
  addedKeywordCount: number;
  duplicateKeywordCount: number;
  promotedKeywordCount: number;
  promotedNormalizedKeywords: string[];
  changed: boolean;
};

export type UiBatchExecutionDeps = {
  previewResearchBatch: typeof previewResearchBatch;
  appendResearchBatch: typeof appendResearchBatch;
  loadSeedRows: typeof loadSeedRows;
  ensureResearchChromeForDiscovery?: typeof ensureResearchChromeForDiscovery;
};

export const DEFAULT_UI_BATCH_EXECUTION_DEPS: UiBatchExecutionDeps = {
  previewResearchBatch,
  appendResearchBatch,
  loadSeedRows,
  ensureResearchChromeForDiscovery,
};

export async function previewUiResearchBatch(
  researchId: string,
  value: unknown,
  options: ResearchBatchOptions = {},
  deps: UiBatchExecutionDeps = DEFAULT_UI_BATCH_EXECUTION_DEPS,
): Promise<UiBatchPlanPreviewV1> {
  const draft = validateUiBatchDraft(value);
  const lines = parseKeywordLines(draft.keywords);
  const seeds = buildSeedKeywords(lines.map((keyword, index) => ({ keyword, rowNumber: index + 2 })));
  const preview = await deps.previewResearchBatch(researchId, seeds, options);
  return {
    version: 1,
    researchId: preview.researchId,
    currentRunId: preview.currentRunId,
    batchId: preview.batchId,
    inputLineCount: lines.length,
    inputUniqueKeywordCount: preview.inputUniqueKeywordCount,
    addedKeywordCount: preview.addedKeywordCount,
    duplicateKeywordCount: preview.duplicateKeywordCount,
    promotedKeywordCount: preview.promotedKeywordCount,
    promotedNormalizedKeywords: [...preview.promotedNormalizedKeywords],
    changed: preview.changed,
  };
}

export async function executeUiResearchBatch(
  researchId: string,
  value: unknown,
  options: ResearchBatchOptions = {},
  deps: UiBatchExecutionDeps = DEFAULT_UI_BATCH_EXECUTION_DEPS,
): Promise<ResearchBatchExecutionResultV1> {
  const draft = validateUiBatchDraft(value);
  const lines = parseKeywordLines(draft.keywords);
  const workspace = await mkdtemp(join(tmpdir(), 'runner-ui-batch-'));
  try {
    const seedsPath = join(workspace, 'seeds.csv');
    await writeFile(seedsPath, seedCsv(lines), 'utf8');
    const rows = await deps.loadSeedRows(seedsPath);
    const seeds = buildSeedKeywords(rows);
    if (seeds.length === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'Batch input contains no research keywords after normalization.');
    }
    const preview = await deps.previewResearchBatch(researchId, seeds, options);
    if (preview.changed) {
      await deps.ensureResearchChromeForDiscovery?.({ env: options.env });
    }
    return deps.appendResearchBatch(researchId, seedsPath, seeds, options);
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function validateUiBatchDraft(value: unknown): UiBatchDraftV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'UI batch draft must be an object with version: 1.');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('version') || !keys.includes('keywords')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'UI batch draft must contain exactly version and keywords.');
  }
  if (typeof value.keywords !== 'string') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Batch keywords must be a string.');
  }
  parseKeywordLines(value.keywords);
  return { version: 1, keywords: value.keywords };
}

function parseKeywordLines(raw: string): string[] {
  const keywords = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (keywords.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'At least one non-empty batch keyword is required.');
  }
  return keywords;
}

function seedCsv(keywords: string[]): string {
  return `keyword\n${keywords.map(csvCell).join('\n')}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
