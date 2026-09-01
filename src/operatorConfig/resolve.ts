import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, posix, resolve, win32 } from 'node:path';
import { type OperatorContinuationV1, type OperatorResearchConfigV1, type WorkflowTargetV1, validateOperatorContinuation, validateOperatorResearchConfig } from './contracts.js';
import { ResearchError } from '../shared/errors.js';

export type SemanticOrigin = 'default' | 'file';
export type DeclaredFilePath = { logicalPath: string; resolvedPath: string };
export type ResolvedResearchSemantics = {
  research: { label: string; market: string; googleHl: string; googleGl: string; input: { type: 'seeds' | 'microsoft'; logicalPath: string; resolvedPath: string } };
  workflow: { target: WorkflowTargetV1 };
  discovery: { expand: boolean; requireAhrefs: boolean };
  enrichment: null | { modules: string[]; clustering: { topN: number; minSharedDomains: number; minDomainJaccard: number; minSharedUrls: number; minUrlJaccard: number } };
  finalization: null | { representativeCount: number; historyPolicy: { youngDomainMaxAgeDays: number; recentWebPresenceMaxAgeDays: number; repurposeGapMinDays: number }; historicalPresence: { collectionMode: 'latest' | 'annual'; recentMonths: number; maxCollections: number; domainCap: number } };
  provenance: Record<string, SemanticOrigin>;
};
export type StageSemanticFingerprints = { discoverySemanticFingerprint: string; enrichmentSemanticFingerprint: string; finalizationPolicyFingerprint: string };
export type NewResearchPlanStage = { id: 'discovery' | 'enrichment' | 'finalization'; state: 'ready' | 'requires_predecessor' | 'not_requested'; reason: string | null };
export type ResolvedExecutionPlan = {
  version: 1;
  stateContext: { kind: 'new' };
  configPath: string;
  effectiveConfigFingerprint: string;
  stageFingerprints: StageSemanticFingerprints;
  semantics: ResolvedResearchSemantics;
  stages: NewResearchPlanStage[];
  filesystemInputs: Array<{ purpose: 'research_input'; logicalPath: string; resolvedPath: string }>;
  unresolvedHumanRequirements: Array<'shortlist' | 'finalist_scope' | 'human_decisions'>;
  expectedStopPoint: 'discovery';
};
export type LoadedOperatorResearchConfig = { config: OperatorResearchConfigV1; plan: ResolvedExecutionPlan };
export type ResolvedOperatorContinuation = { continuation: OperatorContinuationV1; continuationPath: string; declaredFilePath: DeclaredFilePath | null };

const DEFAULT_MARKET = 'US';
const DEFAULT_GOOGLE_HL = 'en';
const DEFAULT_GOOGLE_GL = 'us';
const DEFAULT_WORKFLOW_TARGET: WorkflowTargetV1 = 'discovery';
const DEFAULT_EXPAND = false;
const DEFAULT_REQUIRE_AHREFS = false;
const DEFAULT_CLUSTER_TOP_N = 10;
const DEFAULT_CLUSTER_MIN_SHARED_DOMAINS = 3;
const DEFAULT_CLUSTER_MIN_DOMAIN_JACCARD = 0.3;
const DEFAULT_CLUSTER_MIN_SHARED_URLS = 2;
const DEFAULT_CLUSTER_MIN_URL_JACCARD = 0.1;
const DEFAULT_REPRESENTATIVE_COUNT = 5;
const DEFAULT_HISTORY_COLLECTION_MODE = 'annual' as const;
const DEFAULT_HISTORY_RECENT_MONTHS = 18;
const DEFAULT_HISTORY_MAX_COLLECTIONS = 24;
const DEFAULT_HISTORY_DOMAIN_CAP = 30;

export async function loadOperatorResearchConfig(configPath: string): Promise<LoadedOperatorResearchConfig> {
  const absoluteConfigPath = resolve(configPath);
  const raw = await readJson(absoluteConfigPath, 'operator research config');
  const config = validateOperatorResearchConfig(raw);
  return { config, plan: buildNewResearchPlan(config, absoluteConfigPath) };
}

export async function loadOperatorContinuation(continuationPath: string): Promise<ResolvedOperatorContinuation> {
  const absoluteContinuationPath = resolve(continuationPath);
  const raw = await readJson(absoluteContinuationPath, 'operator continuation');
  const continuation = validateOperatorContinuation(raw);
  const action = continuation.action;
  const declaredFilePath = 'path' in action ? resolveDeclaredPath(absoluteContinuationPath, action.path) : null;
  return { continuation, continuationPath: absoluteContinuationPath, declaredFilePath };
}

export function buildNewResearchPlan(config: OperatorResearchConfigV1, declaringConfigPath: string): ResolvedExecutionPlan {
  const validated = validateOperatorResearchConfig(config);
  const configPath = resolve(declaringConfigPath);
  const semantics = resolveResearchSemantics(validated, configPath);
  const stageFingerprints = buildStageSemanticFingerprints(semantics);
  const effectiveConfigFingerprint = fingerprint('operator-config-v1', effectiveConfigProjection(semantics));
  const target = semantics.workflow.target;
  const requiresShortlist = target !== 'discovery' && semantics.enrichment !== null && semantics.enrichment.modules.some((module) => module !== 'clusters');
  return {
    version: 1,
    stateContext: { kind: 'new' },
    configPath,
    effectiveConfigFingerprint,
    stageFingerprints,
    semantics,
    stages: [
      { id: 'discovery', state: 'ready', reason: null },
      target === 'discovery' ? { id: 'enrichment', state: 'not_requested', reason: null } : { id: 'enrichment', state: 'requires_predecessor', reason: 'Requires a completed discovery generation.' },
      target === 'finalization' ? { id: 'finalization', state: 'requires_predecessor', reason: 'Requires a completed enrichment and explicit finalist scope.' } : { id: 'finalization', state: 'not_requested', reason: null },
    ],
    filesystemInputs: [{ purpose: 'research_input', logicalPath: semantics.research.input.logicalPath, resolvedPath: semantics.research.input.resolvedPath }],
    unresolvedHumanRequirements: [...(requiresShortlist ? ['shortlist' as const] : []), ...(target === 'finalization' ? ['finalist_scope' as const, 'human_decisions' as const] : [])],
    expectedStopPoint: 'discovery',
  };
}

export function resolveResearchSemantics(config: OperatorResearchConfigV1, declaringConfigPath: string): ResolvedResearchSemantics {
  const provenance: Record<string, SemanticOrigin> = {};
  const inputPath = resolveDeclaredPath(declaringConfigPath, config.research.input.path);
  const market = withOrigin(config.research.market, DEFAULT_MARKET, '$.research.market', provenance);
  const googleHl = withOrigin(config.research.googleHl, DEFAULT_GOOGLE_HL, '$.research.googleHl', provenance);
  const googleGl = withOrigin(config.research.googleGl, DEFAULT_GOOGLE_GL, '$.research.googleGl', provenance);
  const target = withOrigin(config.workflow?.target, DEFAULT_WORKFLOW_TARGET, '$.workflow.target', provenance);
  const expand = withOrigin(config.discovery?.expand, DEFAULT_EXPAND, '$.discovery.expand', provenance);
  const requireAhrefs = withOrigin(config.discovery?.requireAhrefs, DEFAULT_REQUIRE_AHREFS, '$.discovery.requireAhrefs', provenance);
  provenance['$.research.label'] = 'file';
  provenance['$.research.input.type'] = 'file';
  provenance['$.research.input.path'] = 'file';

  let enrichment: ResolvedResearchSemantics['enrichment'] = null;
  if (config.enrichment !== undefined) {
    const clustering = config.enrichment.clustering;
    enrichment = {
      modules: [...config.enrichment.modules].sort(),
      clustering: {
        topN: withOrigin(clustering?.topN, DEFAULT_CLUSTER_TOP_N, '$.enrichment.clustering.topN', provenance),
        minSharedDomains: withOrigin(clustering?.minSharedDomains, DEFAULT_CLUSTER_MIN_SHARED_DOMAINS, '$.enrichment.clustering.minSharedDomains', provenance),
        minDomainJaccard: withOrigin(clustering?.minDomainJaccard, DEFAULT_CLUSTER_MIN_DOMAIN_JACCARD, '$.enrichment.clustering.minDomainJaccard', provenance),
        minSharedUrls: withOrigin(clustering?.minSharedUrls, DEFAULT_CLUSTER_MIN_SHARED_URLS, '$.enrichment.clustering.minSharedUrls', provenance),
        minUrlJaccard: withOrigin(clustering?.minUrlJaccard, DEFAULT_CLUSTER_MIN_URL_JACCARD, '$.enrichment.clustering.minUrlJaccard', provenance),
      },
    };
    provenance['$.enrichment.modules'] = 'file';
  }

  let finalization: ResolvedResearchSemantics['finalization'] = null;
  if (config.finalization !== undefined) {
    const historical = config.finalization.historicalPresence;
    finalization = {
      representativeCount: withOrigin(config.finalization.representativeCount, DEFAULT_REPRESENTATIVE_COUNT, '$.finalization.representativeCount', provenance),
      historyPolicy: { ...config.finalization.historyPolicy },
      historicalPresence: {
        collectionMode: withOrigin(historical?.collectionMode, DEFAULT_HISTORY_COLLECTION_MODE, '$.finalization.historicalPresence.collectionMode', provenance),
        recentMonths: withOrigin(historical?.recentMonths, DEFAULT_HISTORY_RECENT_MONTHS, '$.finalization.historicalPresence.recentMonths', provenance),
        maxCollections: withOrigin(historical?.maxCollections, DEFAULT_HISTORY_MAX_COLLECTIONS, '$.finalization.historicalPresence.maxCollections', provenance),
        domainCap: withOrigin(historical?.domainCap, DEFAULT_HISTORY_DOMAIN_CAP, '$.finalization.historicalPresence.domainCap', provenance),
      },
    };
    provenance['$.finalization.historyPolicy.youngDomainMaxAgeDays'] = 'file';
    provenance['$.finalization.historyPolicy.recentWebPresenceMaxAgeDays'] = 'file';
    provenance['$.finalization.historyPolicy.repurposeGapMinDays'] = 'file';
  }

  return { research: { label: config.research.label, market, googleHl, googleGl, input: { type: config.research.input.type, logicalPath: inputPath.logicalPath, resolvedPath: inputPath.resolvedPath } }, workflow: { target }, discovery: { expand, requireAhrefs }, enrichment, finalization, provenance };
}

export function buildStageSemanticFingerprints(semantics: ResolvedResearchSemantics): StageSemanticFingerprints {
  return {
    discoverySemanticFingerprint: fingerprint('operator-config-v1:discovery', { market: semantics.research.market, googleHl: semantics.research.googleHl, googleGl: semantics.research.googleGl, input: { type: semantics.research.input.type, logicalPath: semantics.research.input.logicalPath }, discovery: semantics.discovery }),
    enrichmentSemanticFingerprint: fingerprint('operator-config-v1:enrichment', semantics.enrichment ?? { requested: false }),
    finalizationPolicyFingerprint: fingerprint('operator-config-v1:finalization', semantics.finalization ?? { requested: false }),
  };
}

export function resolveDeclaredPath(declaringJsonPath: string, authoredPath: string): DeclaredFilePath {
  const logicalPath = normalizeLogicalPath(authoredPath);
  return { logicalPath, resolvedPath: resolve(dirname(resolve(declaringJsonPath)), logicalPath) };
}

export function normalizeLogicalPath(authoredPath: string): string {
  const portable = authoredPath.replaceAll('\\', '/');
  if (portable.trim() === '') throw new ResearchError('INPUT_SCHEMA_ERROR', 'Declared file path must not be blank.');
  if (posix.isAbsolute(portable) || win32.isAbsolute(authoredPath)) throw new ResearchError('INPUT_SCHEMA_ERROR', 'Declared file path must be relative to the JSON file that declares it.');
  const normalized = posix.normalize(portable);
  if (normalized === '.') throw new ResearchError('INPUT_SCHEMA_ERROR', 'Declared file path must identify a file, not the declaring directory.');
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new ResearchError('INPUT_SCHEMA_ERROR', 'Cannot fingerprint a non-finite number.'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot fingerprint value of type ${typeof value}.`);
}

export function fingerprint(namespace: string, value: unknown): string {
  return createHash('sha256').update(`${namespace}\n${canonicalJson(value)}`).digest('hex');
}

function effectiveConfigProjection(semantics: ResolvedResearchSemantics): unknown {
  return { version: 1, research: { label: semantics.research.label, market: semantics.research.market, googleHl: semantics.research.googleHl, googleGl: semantics.research.googleGl, input: { type: semantics.research.input.type, path: semantics.research.input.logicalPath } }, workflow: semantics.workflow, discovery: semantics.discovery, enrichment: semantics.enrichment, finalization: semantics.finalization };
}

function withOrigin<T>(value: T | undefined, fallback: T, path: string, provenance: Record<string, SemanticOrigin>): T {
  if (value === undefined) { provenance[path] = 'default'; return fallback; }
  provenance[path] = 'file';
  return value;
}

async function readJson(path: string, label: string): Promise<unknown> {
  let content: string;
  try { content = await readFile(path, 'utf8'); } catch (error) { throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read ${label} "${path}".`, { cause: error }); }
  try { return JSON.parse(content) as unknown; } catch (error) { throw new ResearchError('INPUT_SCHEMA_ERROR', `${label} "${path}" is not valid JSON.`, { cause: error }); }
}
