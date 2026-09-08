import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOperatorResearchConfigInput } from '../application/operatorInputs.js';
import {
  executeExistingResearch,
  executeNewResearch,
  type ResearchControlOptions,
} from '../application/researchControl.js';
import type { ResearchRunExecution } from '../application/researchWorkflow.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import type { OperatorResearchConfigSourceV1 } from '../operatorConfig/contracts.js';
import { ResearchError } from '../shared/errors.js';

export type UiCreateResearchDraftV1 = {
  version: 1;
  label: string;
  preset: string;
  keywords: string;
  market?: string;
  googleHl?: string;
  googleGl?: string;
};

export type UiResearchPlanPreviewV1 = {
  version: 1;
  inputLineCount: number;
  uniqueKeywordCount: number;
  effectiveConfigFingerprint: string;
  preset: { id: string; revision: number } | null;
  workflowTarget: 'discovery' | 'enrichment' | 'finalization';
  stages: Array<{ id: 'discovery' | 'enrichment' | 'finalization'; state: string; reason: string | null }>;
  unresolvedHumanRequirements: Array<'shortlist' | 'finalist_scope' | 'human_decisions'>;
  externalWork: Array<{ stage: 'discovery' | 'enrichment' | 'finalization'; providers: string[] }>;
  semantics: {
    research: {
      label: string;
      market: string;
      googleHl: string;
      googleGl: string;
    };
    discovery: {
      topN: number;
      expand: boolean;
      requireAhrefs: boolean;
    };
    enrichmentModules: string[];
    finalizationRequested: boolean;
  };
};

export type UiResearchExecutionDeps = {
  resolveOperatorResearchConfigInput: typeof resolveOperatorResearchConfigInput;
  executeNewResearch: typeof executeNewResearch;
  executeExistingResearch: typeof executeExistingResearch;
};

export const DEFAULT_UI_RESEARCH_EXECUTION_DEPS: UiResearchExecutionDeps = {
  resolveOperatorResearchConfigInput,
  executeNewResearch,
  executeExistingResearch,
};

type UiResearchExecutionOptions = Omit<ResearchControlOptions, 'manageProcessSignals'>;

export async function previewUiResearchDraft(
  value: unknown,
  deps: Pick<UiResearchExecutionDeps, 'resolveOperatorResearchConfigInput'> = DEFAULT_UI_RESEARCH_EXECUTION_DEPS,
): Promise<UiResearchPlanPreviewV1> {
  const draft = validateUiCreateResearchDraft(value);
  const keywords = parseKeywordLines(draft.keywords);
  const uniqueKeywords = buildSeedKeywords(
    keywords.map((keyword, index) => ({ keyword, rowNumber: index + 2 })),
  );
  const declaringPath = join(tmpdir(), 'runner-ui-preview', 'operator-config.json');
  const loaded = await deps.resolveOperatorResearchConfigInput(
    buildOperatorSource(draft),
    declaringPath,
  );
  const semantics = loaded.plan.semantics;
  return {
    version: 1,
    inputLineCount: keywords.length,
    uniqueKeywordCount: uniqueKeywords.length,
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    preset: loaded.plan.preset,
    workflowTarget: semantics.workflow.target,
    stages: loaded.plan.stages.map((stage) => ({ ...stage })),
    unresolvedHumanRequirements: [...loaded.plan.unresolvedHumanRequirements],
    externalWork: loaded.plan.externalWork.map((item) => ({
      stage: item.stage,
      providers: [...item.providers],
    })),
    semantics: {
      research: {
        label: semantics.research.label,
        market: semantics.research.market,
        googleHl: semantics.research.googleHl,
        googleGl: semantics.research.googleGl,
      },
      discovery: {
        topN: semantics.discovery.topN,
        expand: semantics.discovery.expand,
        requireAhrefs: semantics.discovery.requireAhrefs,
      },
      enrichmentModules: semantics.enrichment?.modules ? [...semantics.enrichment.modules] : [],
      finalizationRequested: semantics.workflow.target === 'finalization',
    },
  };
}

export async function executeUiResearchDraft(
  value: unknown,
  options: UiResearchExecutionOptions = {},
  deps: UiResearchExecutionDeps = DEFAULT_UI_RESEARCH_EXECUTION_DEPS,
): Promise<ResearchRunExecution> {
  const draft = validateUiCreateResearchDraft(value);
  const keywords = parseKeywordLines(draft.keywords);
  const workspace = await mkdtemp(join(tmpdir(), 'runner-ui-create-'));
  try {
    await writeFile(join(workspace, 'seeds.csv'), seedCsv(keywords), 'utf8');
    const loaded = await deps.resolveOperatorResearchConfigInput(
      buildOperatorSource(draft),
      join(workspace, 'operator-config.json'),
    );
    return deps.executeNewResearch(loaded, {
      ...options,
      manageProcessSignals: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function executeUiResearchResume(
  researchId: string,
  options: UiResearchExecutionOptions = {},
  deps: Pick<UiResearchExecutionDeps, 'executeExistingResearch'> = DEFAULT_UI_RESEARCH_EXECUTION_DEPS,
): Promise<ResearchRunExecution> {
  const normalizedId = researchId.trim();
  if (normalizedId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Research id is required for resume.');
  }
  return deps.executeExistingResearch(normalizedId, null, {
    ...options,
    manageProcessSignals: false,
  });
}

export function validateUiCreateResearchDraft(value: unknown): UiCreateResearchDraftV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'UI research draft must be an object with version: 1.');
  }
  const allowed = new Set(['version', 'label', 'preset', 'keywords', 'market', 'googleHl', 'googleGl']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown UI research draft field: ${key}.`);
    }
  }

  const label = requiredString(value.label, 'label');
  const preset = requiredString(value.preset, 'preset');
  const keywords = requiredString(value.keywords, 'keywords', false);
  parseKeywordLines(keywords);

  const result: UiCreateResearchDraftV1 = {
    version: 1,
    label,
    preset,
    keywords,
  };
  const market = optionalString(value.market, 'market');
  const googleHl = optionalString(value.googleHl, 'googleHl');
  const googleGl = optionalString(value.googleGl, 'googleGl');
  if (market !== undefined) result.market = market;
  if (googleHl !== undefined) result.googleHl = googleHl;
  if (googleGl !== undefined) result.googleGl = googleGl;
  return result;
}

function buildOperatorSource(draft: UiCreateResearchDraftV1): OperatorResearchConfigSourceV1 {
  const research: OperatorResearchConfigSourceV1['research'] = {
    label: draft.label,
    input: { type: 'seeds', path: './seeds.csv' },
  };
  if (draft.market !== undefined) research.market = draft.market;
  if (draft.googleHl !== undefined) research.googleHl = draft.googleHl;
  if (draft.googleGl !== undefined) research.googleGl = draft.googleGl;
  return {
    version: 1,
    preset: draft.preset,
    research,
  };
}

function parseKeywordLines(raw: string): string[] {
  const keywords = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (keywords.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'At least one non-empty keyword is required.');
  }
  return keywords;
}

function seedCsv(keywords: string[]): string {
  return `keyword\n${keywords.map(csvCell).join('\n')}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requiredString(value: unknown, field: string, trim = true): string {
  if (typeof value !== 'string') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must be a string.`);
  }
  const normalized = trim ? value.trim() : value;
  if (normalized.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must not be empty.`);
  }
  return normalized;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
