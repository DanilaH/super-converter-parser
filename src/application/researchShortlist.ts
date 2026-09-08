import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { RunStore } from '../db/store.js';
import type { CancellationSignal } from '../enrichment/types.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { resolveOutputRoot, resolveRunLocation } from '../outputs/researchLayout.js';
import { buildExistingResearchPlan } from '../operatorConfig/planner.js';
import { readOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { buildResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { buildCandidates, resolveDrThresholds } from '../scoring/scoring.js';
import { ResearchError } from '../shared/errors.js';
import { resolveOperatorContinuationInput } from './operatorInputs.js';
import { executeExistingResearch, type ResearchControlOptions } from './researchControl.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  type ResearchRunDeps,
  type ResearchRunExecution,
} from './researchWorkflow.js';

export const SHORTLIST_MIN_SELECTION = 5;
export const SHORTLIST_MAX_SELECTION = 200;

export type ResearchShortlistCandidateV1 = {
  keyword: string;
  normalizedKeyword: string;
  status: string;
  surferVolume: number | null;
  surferCpc: number | null;
  score: number | null;
  tier: 'A' | 'B' | 'C' | 'D' | null;
  organicResultCount: number | null;
  medianDr: number | null;
  weakDomainsCount: number | null;
  scoringCompleteness: 'complete' | 'degraded';
  serpStatus: string;
};

export type ResearchShortlistGateV1 = {
  version: 1;
  researchId: string;
  discoveryRunId: string;
  minSelection: number;
  maxSelection: number;
  candidateCount: number;
  candidates: ResearchShortlistCandidateV1[];
};

export type ResearchShortlistSelectionV1 = {
  version: 1;
  discoveryRunId: string;
  normalizedKeywords: string[];
};

export type ResearchShortlistServiceDeps = {
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  loadProvenance: typeof readOperatorConfigProvenance;
  buildPlan: typeof buildExistingResearchPlan;
  loadCandidates: typeof loadShortlistCandidates;
  resolveContinuation: typeof resolveOperatorContinuationInput;
  executeExistingResearch: typeof executeExistingResearch;
};

export const DEFAULT_RESEARCH_SHORTLIST_DEPS: ResearchShortlistServiceDeps = {
  buildStatus: buildResearchStatusWithHistoricalPresence,
  loadProvenance: readOperatorConfigProvenance,
  buildPlan: buildExistingResearchPlan,
  loadCandidates: loadShortlistCandidates,
  resolveContinuation: resolveOperatorContinuationInput,
  executeExistingResearch,
};

export type ResearchShortlistOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: CancellationSignal;
  serviceDeps?: ResearchShortlistServiceDeps;
  workflowDeps?: ResearchRunDeps;
  runtime?: ResearchControlOptions['runtime'];
};

export async function inspectResearchShortlist(
  researchIdValue: string,
  options: Pick<ResearchShortlistOptions, 'outputRoot' | 'env' | 'serviceDeps'> = {},
): Promise<ResearchShortlistGateV1> {
  const researchId = requireResearchId(researchIdValue);
  const env = options.env ?? process.env;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_SHORTLIST_DEPS;
  const status = await deps.buildStatus({ outputRoot, targetRunId: researchId });
  if (status.legacy) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Shortlist selection requires a managed research with persisted OperatorConfig provenance.');
  }
  const provenance = await deps.loadProvenance(status.researchDirectory);
  if (provenance === null) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} has no persisted OperatorConfig provenance; shortlist continuation is unavailable.`,
    );
  }
  const plan = deps.buildPlan(status, null, provenance);
  if (!plan.unresolvedHumanRequirements.includes('shortlist')) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research ${status.researchId} is not currently awaiting an explicit shortlist.`,
    );
  }

  const candidates = await deps.loadCandidates(outputRoot, status.discovery.runId);
  return {
    version: 1,
    researchId: status.researchId,
    discoveryRunId: status.discovery.runId,
    minSelection: SHORTLIST_MIN_SELECTION,
    maxSelection: SHORTLIST_MAX_SELECTION,
    candidateCount: candidates.length,
    candidates,
  };
}

export async function executeResearchShortlistSelection(
  researchIdValue: string,
  selectionValue: unknown,
  options: ResearchShortlistOptions = {},
): Promise<ResearchRunExecution> {
  const selection = validateResearchShortlistSelection(selectionValue);
  const deps = options.serviceDeps ?? DEFAULT_RESEARCH_SHORTLIST_DEPS;
  const gate = await inspectResearchShortlist(researchIdValue, {
    ...(options.outputRoot !== undefined ? { outputRoot: options.outputRoot } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    serviceDeps: deps,
  });
  if (selection.discoveryRunId !== gate.discoveryRunId) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Shortlist selection targets discovery ${selection.discoveryRunId}, but current discovery is ${gate.discoveryRunId}. Reload shortlist candidates.`,
    );
  }

  const available = new Set(gate.candidates.map((candidate) => candidate.normalizedKeyword));
  const rejected = selection.normalizedKeywords.filter((keyword) => !available.has(keyword));
  if (rejected.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Shortlist keywords are not present in current discovery ${gate.discoveryRunId}: ${rejected.join(', ')}`,
    );
  }

  const workspace = await mkdtemp(join(tmpdir(), 'runner-ui-shortlist-'));
  try {
    const shortlistPath = join(workspace, 'shortlist.csv');
    await writeFile(shortlistPath, shortlistCsv(selection.normalizedKeywords), 'utf8');
    const continuation = deps.resolveContinuation(
      {
        version: 1,
        researchId: gate.researchId,
        action: { type: 'shortlist', path: './shortlist.csv' },
      },
      join(workspace, 'continuation.json'),
    );

    const baseWorkflowDeps = options.workflowDeps ?? DEFAULT_RESEARCH_RUN_DEPS;
    const guardedWorkflowDeps: ResearchRunDeps = {
      ...baseWorkflowDeps,
      buildStatus: async (input) => {
        const status = await baseWorkflowDeps.buildStatus(input);
        if (status.researchId !== gate.researchId || status.discovery.runId !== selection.discoveryRunId) {
          throw new ResearchError(
            'INPUT_SCHEMA_ERROR',
            `Shortlist selection is stale: expected research ${gate.researchId} discovery ${selection.discoveryRunId}, current research is ${status.researchId} discovery ${status.discovery.runId}. Reload current shortlist candidates.`,
          );
        }
        return status;
      },
    };

    return deps.executeExistingResearch(gate.researchId, continuation, {
      outputRoot: options.outputRoot ?? null,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      deps: guardedWorkflowDeps,
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      manageProcessSignals: false,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function validateResearchShortlistSelection(value: unknown): ResearchShortlistSelectionV1 {
  if (!isRecord(value) || value.version !== 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Shortlist selection must be an object with version: 1.');
  }
  const allowed = new Set(['version', 'discoveryRunId', 'normalizedKeywords']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown shortlist selection field: ${key}.`);
  }
  const discoveryRunId = requiredString(value.discoveryRunId, 'discoveryRunId');
  if (!Array.isArray(value.normalizedKeywords) || value.normalizedKeywords.some((item) => typeof item !== 'string')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'normalizedKeywords must be an array of strings.');
  }
  const normalizedKeywords = [...new Set(value.normalizedKeywords.map((keyword) => normalizeKeyword(keyword)).filter(Boolean))];
  if (normalizedKeywords.length < SHORTLIST_MIN_SELECTION || normalizedKeywords.length > SHORTLIST_MAX_SELECTION) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Shortlist must contain ${SHORTLIST_MIN_SELECTION}-${SHORTLIST_MAX_SELECTION} unique keywords, got ${normalizedKeywords.length}.`,
    );
  }
  return { version: 1, discoveryRunId, normalizedKeywords };
}

export async function loadShortlistCandidates(
  outputRoot: string,
  discoveryRunId: string,
): Promise<ResearchShortlistCandidateV1[]> {
  const location = await resolveRunLocation(outputRoot, discoveryRunId);
  const store = RunStore.openReadOnly(join(location.discoveryDirectory, 'run.sqlite'));
  try {
    const run = store.loadRun(discoveryRunId);
    if (!run) throw new ResearchError('RESUME_NOT_FOUND', `Discovery run not found: ${discoveryRunId}.`);
    const candidates = buildCandidates(
      store.loadKeywords(discoveryRunId),
      store.loadSerpRows(discoveryRunId),
      resolveDrThresholds(run.configSnapshot),
    );
    return candidates.map((candidate) => ({
      keyword: candidate.keyword,
      normalizedKeyword: candidate.normalizedKeyword,
      status: candidate.status,
      surferVolume: candidate.surferVolume,
      surferCpc: candidate.surferCpc,
      score: candidate.score,
      tier: candidate.tier,
      organicResultCount: candidate.organicResultCount,
      medianDr: candidate.medianDr,
      weakDomainsCount: candidate.weakDomainsCount === null || candidate.veryWeakDomainsCount === null
        ? null
        : candidate.weakDomainsCount + candidate.veryWeakDomainsCount,
      scoringCompleteness: candidate.scoringCompleteness,
      serpStatus: candidate.serpStatus,
    }));
  } finally {
    store.close();
  }
}

function shortlistCsv(keywords: string[]): string {
  return `keyword\n${keywords.map(csvCell).join('\n')}\n`;
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function requireResearchId(value: string): string {
  return requiredString(value, 'researchId');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${field} must be a non-empty string.`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
