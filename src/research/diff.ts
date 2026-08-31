import Database from 'better-sqlite3';
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { loadCohortHistoryState } from '../db/cohortHistory.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import { loadTrafficEvidencePolicy, loadTrafficImportRecords } from '../db/trafficEvidence.js';
import { projectCurrentTrafficEvidence } from '../enrichment/trafficEvidenceCurrent.js';
import { resolveRunLocation } from '../outputs/researchLayout.js';
import { buildRunQuality } from '../runs/runQuality.js';
import { ResearchError } from '../shared/errors.js';
import { readResearchContainer } from './batches.js';
import { generationFromDirectoryName } from './status.js';

export type ResearchGenerationKind = 'discovery' | 'enrichment';

export type ResearchGenerationRef = {
  kind: ResearchGenerationKind;
  generation: number;
};

export type GenerationCoverage = {
  numerator: number;
  denominator: number;
  ratio: number | null;
};

export type DiscoveryGenerationDescriptor = {
  kind: 'discovery';
  generation: number;
  directoryName: string;
  runId: string;
  state: string;
};

export type EnrichmentGenerationDescriptor = {
  kind: 'enrichment';
  generation: number;
  directoryName: string;
  enrichmentId: string;
  sourceRunId: string;
  state: string;
};

export type DiscoveryGenerationDiff = {
  from: DiscoveryGenerationDescriptor;
  to: DiscoveryGenerationDescriptor;
  keywords: {
    fromCount: number;
    toCount: number;
    added: Array<{ normalizedKeyword: string; keyword: string; status: string }>;
    removed: Array<{ normalizedKeyword: string; keyword: string; status: string }>;
    statusChanges: Array<{ normalizedKeyword: string; keyword: string; from: string; to: string }>;
  };
  googleSerpCoverage: {
    from: GenerationCoverage;
    to: GenerationCoverage;
  };
};

export type ClusterGenerationSnapshot = {
  clusterId: string;
  canonicalKeyword: string;
  members: string[];
};

export type EnrichmentHistoryCoverage = {
  cohortDomainCount: number;
  checked: GenerationCoverage;
  registrationKnown: GenerationCoverage;
  firstSeenKnown: GenerationCoverage;
  omittedDomainCount: number;
  unobservedDomainCount: number;
};

export type EnrichmentTrafficCoverage = {
  importedSnapshotCount: number;
  policyAvailable: boolean;
  currentTargetSnapshotCount: number | null;
  staleTargetSnapshotCount: number | null;
  matchedSnapshotCount: number | null;
  mismatchedSnapshotCount: number | null;
};

export type EnrichmentGenerationDiff = {
  from: EnrichmentGenerationDescriptor;
  to: EnrichmentGenerationDescriptor;
  modules: {
    added: string[];
    removed: string[];
  };
  clusters: {
    added: ClusterGenerationSnapshot[];
    removed: ClusterGenerationSnapshot[];
    changed: Array<{
      clusterId: string;
      canonicalKeywordFrom: string;
      canonicalKeywordTo: string;
      addedMembers: string[];
      removedMembers: string[];
    }>;
    matchingBasis: 'persisted_cluster_id';
  };
  representatives: Array<{
    clusterId: string;
    from: string[] | null;
    to: string[] | null;
  }>;
  entrantDomains: Array<{
    clusterId: string;
    added: string[];
    removed: string[];
  }>;
  historyCoverage: {
    from: EnrichmentHistoryCoverage | null;
    to: EnrichmentHistoryCoverage | null;
  };
  trafficEvidence: {
    from: EnrichmentTrafficCoverage;
    to: EnrichmentTrafficCoverage;
  };
};

export type ResearchGenerationDiff = {
  version: '1.0.0';
  researchId: string;
  label: string;
  researchDirectory: string;
  kind: ResearchGenerationKind;
  discovery: DiscoveryGenerationDiff | null;
  enrichment: EnrichmentGenerationDiff | null;
};

type GenerationDirectory = {
  generation: number;
  directoryName: string;
  directory: string;
};

type DiscoverySnapshot = {
  descriptor: DiscoveryGenerationDescriptor;
  keywords: ReturnType<RunStore['loadKeywords']>;
  googleSerpCoverage: GenerationCoverage;
};

type EnrichmentSnapshot = {
  descriptor: EnrichmentGenerationDescriptor;
  modules: string[];
  clusters: ClusterGenerationSnapshot[];
  representatives: Map<string, string[]> | null;
  entrantDomains: Map<string, string[]> | null;
  historyCoverage: EnrichmentHistoryCoverage | null;
  trafficEvidence: EnrichmentTrafficCoverage;
};

export function parseResearchGenerationRef(value: string): ResearchGenerationRef {
  const match = value.trim().match(/^(discovery|enrichment):(\d+)$/);
  if (!match) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Invalid generation ref "${value}". Use discovery:<n> or enrichment:<n>.`,
    );
  }
  const generation = Number(match[2]);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Generation must be a positive integer: ${value}`);
  }
  return { kind: match[1] as ResearchGenerationKind, generation };
}

export async function buildResearchGenerationDiff(input: {
  outputRoot: string;
  targetRunId: string;
  from: ResearchGenerationRef | string;
  to: ResearchGenerationRef | string;
}): Promise<ResearchGenerationDiff> {
  const from = typeof input.from === 'string' ? parseResearchGenerationRef(input.from) : input.from;
  const to = typeof input.to === 'string' ? parseResearchGenerationRef(input.to) : input.to;
  if (from.kind !== to.kind) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot compare ${from.kind} and ${to.kind} generations in one diff. Use two refs of the same kind.`,
    );
  }

  const target = await resolveRunLocation(input.outputRoot, input.targetRunId);
  if (target.legacy) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'research:diff requires the current immutable research layout; legacy run directories have no research-generation contract.',
    );
  }
  const container = await readResearchContainer(target.researchDirectory);
  const directories = await listGenerationDirectories(target.researchDirectory, from.kind);
  const fromDirectory = requireGeneration(directories, from);
  const toDirectory = requireGeneration(directories, to);

  if (from.kind === 'discovery') {
    const left = loadDiscoverySnapshot(fromDirectory);
    const right = loadDiscoverySnapshot(toDirectory);
    return {
      version: '1.0.0',
      researchId: container?.researchId ?? input.targetRunId,
      label: container?.label ?? basename(target.researchDirectory),
      researchDirectory: target.researchDirectory,
      kind: 'discovery',
      discovery: diffDiscovery(left, right),
      enrichment: null,
    };
  }

  const left = loadEnrichmentSnapshot(fromDirectory);
  const right = loadEnrichmentSnapshot(toDirectory);
  return {
    version: '1.0.0',
    researchId: container?.researchId ?? input.targetRunId,
    label: container?.label ?? basename(target.researchDirectory),
    researchDirectory: target.researchDirectory,
    kind: 'enrichment',
    discovery: null,
    enrichment: diffEnrichment(left, right),
  };
}

async function listGenerationDirectories(
  researchDirectory: string,
  kind: ResearchGenerationKind,
): Promise<GenerationDirectory[]> {
  const entries = await readdir(researchDirectory, { withFileTypes: true });
  const prefix = kind;
  const result = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      entry,
      generation: generationFromDirectoryName(entry.name, prefix),
    }))
    .filter((item): item is { entry: typeof entries[number]; generation: number } => item.generation !== null)
    .map((item) => ({
      generation: item.generation,
      directoryName: item.entry.name,
      directory: join(researchDirectory, item.entry.name),
    }))
    .sort((a, b) => a.generation - b.generation);

  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.generation === result[index]!.generation) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Research contains duplicate ${kind} generation ${result[index]!.generation}.`,
      );
    }
  }
  return result;
}

function requireGeneration(
  directories: GenerationDirectory[],
  ref: ResearchGenerationRef,
): GenerationDirectory {
  const found = directories.find((item) => item.generation === ref.generation);
  if (!found) {
    throw new ResearchError(
      'RESUME_NOT_FOUND',
      `${ref.kind} generation ${ref.generation} was not found in this research.`,
    );
  }
  return found;
}

function loadDiscoverySnapshot(generation: GenerationDirectory): DiscoverySnapshot {
  const dbPath = join(generation.directory, 'run.sqlite');
  const runId = onlyIdentity(dbPath, 'SELECT run_id AS id FROM runs ORDER BY rowid', 'discovery run');
  const store = RunStore.openReadOnly(dbPath);
  try {
    const run = store.loadRun(runId);
    if (!run) throw new ResearchError('DB_ERROR', `Discovery generation ${generation.generation} is missing run ${runId}.`);
    const keywords = store.loadKeywords(runId);
    const quality = buildRunQuality({
      run,
      state: run.state,
      keywords,
      serpRows: store.loadSerpRows(runId),
      relatedKeywords: store.loadRelatedKeywords(runId),
      domains: store.loadDomains(runId),
    });
    return {
      descriptor: {
        kind: 'discovery',
        generation: generation.generation,
        directoryName: generation.directoryName,
        runId,
        state: run.state,
      },
      keywords,
      googleSerpCoverage: fraction(
        quality.sources.googleSerp.trustworthy,
        quality.sources.googleSerp.denominator,
      ),
    };
  } finally {
    store.close();
  }
}

function diffDiscovery(left: DiscoverySnapshot, right: DiscoverySnapshot): DiscoveryGenerationDiff {
  const leftByKeyword = keywordMap(left.keywords, left.descriptor.runId);
  const rightByKeyword = keywordMap(right.keywords, right.descriptor.runId);
  const added = [...rightByKeyword.keys()]
    .filter((key) => !leftByKeyword.has(key))
    .sort()
    .map((key) => keywordFact(rightByKeyword.get(key)!));
  const removed = [...leftByKeyword.keys()]
    .filter((key) => !rightByKeyword.has(key))
    .sort()
    .map((key) => keywordFact(leftByKeyword.get(key)!));
  const statusChanges = [...leftByKeyword.keys()]
    .filter((key) => rightByKeyword.has(key))
    .sort()
    .flatMap((key) => {
      const fromKeyword = leftByKeyword.get(key)!;
      const toKeyword = rightByKeyword.get(key)!;
      if (fromKeyword.status === toKeyword.status) return [];
      return [{
        normalizedKeyword: key,
        keyword: toKeyword.keyword,
        from: fromKeyword.status,
        to: toKeyword.status,
      }];
    });

  return {
    from: left.descriptor,
    to: right.descriptor,
    keywords: {
      fromCount: left.keywords.length,
      toCount: right.keywords.length,
      added,
      removed,
      statusChanges,
    },
    googleSerpCoverage: {
      from: left.googleSerpCoverage,
      to: right.googleSerpCoverage,
    },
  };
}

function keywordMap(
  keywords: ReturnType<RunStore['loadKeywords']>,
  runId: string,
): Map<string, ReturnType<RunStore['loadKeywords']>[number]> {
  const result = new Map<string, ReturnType<RunStore['loadKeywords']>[number]>();
  for (const keyword of keywords) {
    if (result.has(keyword.normalizedKeyword)) {
      throw new ResearchError(
        'DB_ERROR',
        `Run ${runId} contains duplicate normalized keyword identity "${keyword.normalizedKeyword}".`,
      );
    }
    result.set(keyword.normalizedKeyword, keyword);
  }
  return result;
}

function keywordFact(keyword: ReturnType<RunStore['loadKeywords']>[number]) {
  return {
    normalizedKeyword: keyword.normalizedKeyword,
    keyword: keyword.keyword,
    status: keyword.status,
  };
}

function loadEnrichmentSnapshot(generation: GenerationDirectory): EnrichmentSnapshot {
  const dbPath = join(generation.directory, 'enrichment.sqlite');
  const row = onlyEnrichmentIdentity(dbPath);
  const store = RunStore.openReadOnly(dbPath);
  try {
    const clusters = store.loadKeywordClusters(row.enrichmentId)
      .map((cluster) => ({
        clusterId: cluster.clusterId,
        canonicalKeyword: cluster.canonicalKeyword,
        members: uniqueSorted(cluster.members.map((member) => member.normalizedKeyword)),
      }))
      .sort((a, b) => compareClusterIds(a.clusterId, b.clusterId));
    const representatives = loadRepresentativeQueryState(store, row.enrichmentId);
    const entrant = loadEntrantCohortState(store, row.enrichmentId);
    const history = loadCohortHistoryState(store, row.enrichmentId);
    const trafficPolicy = loadTrafficEvidencePolicy(store, row.enrichmentId);
    const trafficRecords = loadTrafficImportRecords(store, row.enrichmentId);
    const currentTraffic = entrant !== null && trafficPolicy !== null
      ? projectCurrentTrafficEvidence({
          importedSnapshots: trafficRecords.map((record) => record.snapshot),
          cohorts: entrant.cohorts,
          policy: trafficPolicy,
        })
      : null;

    return {
      descriptor: {
        kind: 'enrichment',
        generation: generation.generation,
        directoryName: generation.directoryName,
        enrichmentId: row.enrichmentId,
        sourceRunId: row.sourceRunId,
        state: row.state,
      },
      modules: uniqueSorted(row.modules),
      clusters,
      representatives: representatives === null
        ? null
        : new Map(representatives.sets.map((set) => [
            set.clusterId,
            uniqueSorted(set.representatives.map((representative) => representative.normalizedKeyword)),
          ])),
      entrantDomains: entrant === null
        ? null
        : new Map(entrant.cohorts.map((cohort) => [
            cohort.clusterId,
            uniqueSorted(cohort.domains.map((domain) => domain.registrableDomain)),
          ])),
      historyCoverage: history === null ? null : summarizeHistory(history.projections),
      trafficEvidence: {
        importedSnapshotCount: trafficRecords.length,
        policyAvailable: trafficPolicy !== null,
        currentTargetSnapshotCount: currentTraffic?.currentTargetSnapshotCount ?? null,
        staleTargetSnapshotCount: currentTraffic?.staleTargetSnapshotCount ?? null,
        matchedSnapshotCount: currentTraffic?.projection.matchedSnapshotCount ?? null,
        mismatchedSnapshotCount: currentTraffic?.projection.mismatchedSnapshotCount ?? null,
      },
    };
  } finally {
    store.close();
  }
}

function onlyIdentity(dbPath: string, sql: string, label: string): string {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(sql).all() as Array<{ id: string }>;
    if (rows.length !== 1 || typeof rows[0]?.id !== 'string' || rows[0].id.trim() === '') {
      throw new ResearchError('DB_ERROR', `${label} database must contain exactly one persisted identity; found ${rows.length}.`);
    }
    return rows[0].id;
  } finally {
    db.close();
  }
}

function onlyEnrichmentIdentity(dbPath: string): {
  enrichmentId: string;
  sourceRunId: string;
  state: string;
  modules: string[];
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(
      `SELECT enrichment_id, source_run_id, state, modules
       FROM enrichment_runs
       ORDER BY rowid`,
    ).all() as Array<{
      enrichment_id: string;
      source_run_id: string;
      state: string;
      modules: string;
    }>;
    if (rows.length !== 1) {
      throw new ResearchError('DB_ERROR', `Enrichment database must contain exactly one persisted identity; found ${rows.length}.`);
    }
    const row = rows[0]!;
    let modules: unknown;
    try {
      modules = JSON.parse(row.modules);
    } catch (error) {
      throw new ResearchError('DB_ERROR', `Enrichment ${row.enrichment_id} has invalid modules JSON.`, { cause: error });
    }
    if (!Array.isArray(modules) || modules.some((value) => typeof value !== 'string')) {
      throw new ResearchError('DB_ERROR', `Enrichment ${row.enrichment_id} has invalid modules metadata.`);
    }
    return {
      enrichmentId: row.enrichment_id,
      sourceRunId: row.source_run_id,
      state: row.state,
      modules,
    };
  } finally {
    db.close();
  }
}

function diffEnrichment(left: EnrichmentSnapshot, right: EnrichmentSnapshot): EnrichmentGenerationDiff {
  const leftClusters = new Map(left.clusters.map((cluster) => [cluster.clusterId, cluster]));
  const rightClusters = new Map(right.clusters.map((cluster) => [cluster.clusterId, cluster]));
  const addedClusters = [...rightClusters.keys()]
    .filter((clusterId) => !leftClusters.has(clusterId))
    .sort(compareClusterIds)
    .map((clusterId) => rightClusters.get(clusterId)!);
  const removedClusters = [...leftClusters.keys()]
    .filter((clusterId) => !rightClusters.has(clusterId))
    .sort(compareClusterIds)
    .map((clusterId) => leftClusters.get(clusterId)!);
  const changedClusters = [...leftClusters.keys()]
    .filter((clusterId) => rightClusters.has(clusterId))
    .sort(compareClusterIds)
    .flatMap((clusterId) => {
      const from = leftClusters.get(clusterId)!;
      const to = rightClusters.get(clusterId)!;
      const addedMembers = difference(to.members, from.members);
      const removedMembers = difference(from.members, to.members);
      if (
        addedMembers.length === 0
        && removedMembers.length === 0
        && from.canonicalKeyword === to.canonicalKeyword
      ) return [];
      return [{
        clusterId,
        canonicalKeywordFrom: from.canonicalKeyword,
        canonicalKeywordTo: to.canonicalKeyword,
        addedMembers,
        removedMembers,
      }];
    });

  return {
    from: left.descriptor,
    to: right.descriptor,
    modules: {
      added: difference(right.modules, left.modules),
      removed: difference(left.modules, right.modules),
    },
    clusters: {
      added: addedClusters,
      removed: removedClusters,
      changed: changedClusters,
      matchingBasis: 'persisted_cluster_id',
    },
    representatives: diffStringMap(left.representatives, right.representatives, false),
    entrantDomains: diffStringMap(left.entrantDomains, right.entrantDomains, true).map((change) => ({
      clusterId: change.clusterId,
      added: change.to === null ? [] : difference(change.to, change.from ?? []),
      removed: change.from === null ? [] : difference(change.from, change.to ?? []),
    })),
    historyCoverage: {
      from: left.historyCoverage,
      to: right.historyCoverage,
    },
    trafficEvidence: {
      from: left.trafficEvidence,
      to: right.trafficEvidence,
    },
  };
}

function diffStringMap(
  left: Map<string, string[]> | null,
  right: Map<string, string[]> | null,
  changesOnly: false,
): Array<{ clusterId: string; from: string[] | null; to: string[] | null }>;
function diffStringMap(
  left: Map<string, string[]> | null,
  right: Map<string, string[]> | null,
  changesOnly: true,
): Array<{ clusterId: string; from: string[] | null; to: string[] | null }>;
function diffStringMap(
  left: Map<string, string[]> | null,
  right: Map<string, string[]> | null,
  changesOnly: boolean,
): Array<{ clusterId: string; from: string[] | null; to: string[] | null }> {
  const ids = uniqueSorted([...(left?.keys() ?? []), ...(right?.keys() ?? [])]).sort(compareClusterIds);
  return ids.flatMap((clusterId) => {
    const from = left?.get(clusterId) ?? null;
    const to = right?.get(clusterId) ?? null;
    if (arraysEqual(from, to)) return [];
    if (changesOnly && from === null && to === null) return [];
    return [{ clusterId, from, to }];
  });
}

function summarizeHistory(
  projections: NonNullable<ReturnType<typeof loadCohortHistoryState>>['projections'],
): EnrichmentHistoryCoverage {
  const cohortDomainCount = projections.reduce((sum, row) => sum + row.summary.cohortDomainCount, 0);
  const checked = projections.reduce((sum, row) => sum + row.summary.checkedDomainCount, 0);
  const registrationKnown = projections.reduce((sum, row) => sum + row.summary.registrationKnownDomainCount, 0);
  const firstSeenKnown = projections.reduce((sum, row) => sum + row.summary.firstSeenKnownDomainCount, 0);
  const omittedDomainCount = projections.reduce((sum, row) => sum + row.summary.omittedDomainCount, 0);
  const unobservedDomainCount = projections.reduce((sum, row) => sum + row.summary.unobservedDomainCount, 0);
  return {
    cohortDomainCount,
    checked: fraction(checked, cohortDomainCount),
    registrationKnown: fraction(registrationKnown, cohortDomainCount),
    firstSeenKnown: fraction(firstSeenKnown, cohortDomainCount),
    omittedDomainCount,
    unobservedDomainCount,
  };
}

function fraction(numerator: number, denominator: number): GenerationCoverage {
  if (!Number.isInteger(numerator) || numerator < 0 || !Number.isInteger(denominator) || denominator < 0) {
    throw new ResearchError('DB_ERROR', `Invalid persisted coverage ${numerator}/${denominator}.`);
  }
  if (numerator > denominator) {
    throw new ResearchError('DB_ERROR', `Persisted coverage numerator ${numerator} exceeds denominator ${denominator}.`);
  }
  return { numerator, denominator, ratio: denominator === 0 ? null : numerator / denominator };
}

function difference(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value)).sort();
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function arraysEqual(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareClusterIds(a: string, b: string): number {
  const aMatch = a.match(/^(.*?)(\d+)$/);
  const bMatch = b.match(/^(.*?)(\d+)$/);
  if (aMatch && bMatch && aMatch[1] === bMatch[1]) {
    const diff = Number(aMatch[2]) - Number(bMatch[2]);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}
