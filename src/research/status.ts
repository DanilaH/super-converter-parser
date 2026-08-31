import Database from 'better-sqlite3';
import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { RunStore, type StoredKeyword } from '../db/store.js';
import { loadRepresentativeQueryState } from '../db/representativeSets.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { entrantCohortFingerprint, loadCohortHistoryState } from '../db/cohortHistory.js';
import { loadTrafficEvidencePolicy, loadTrafficImportRecords } from '../db/trafficEvidence.js';
import { loadFinalistDecisions } from '../db/finalistDecisions.js';
import { resolveRunLocation } from '../outputs/researchLayout.js';
import { readResearchContainer } from './batches.js';
import { buildRunQuality, type RunQualityWarning } from '../runs/runQuality.js';
import { isPrimaryRepairEligible } from '../runs/retryFailed.js';
import { ResearchError } from '../shared/errors.js';
import { buildResearchLibrarySnapshot } from '../library/researchLibrary.js';
import { projectCurrentTrafficEvidence } from '../enrichment/trafficEvidenceCurrent.js';
import { projectDeepEvidenceCoverage, type DeepEvidenceCoverage } from './evidenceCoverage.js';

export type KeywordStatusCounts = {
  total: number;
  pending: number;
  running: number;
  completed: number;
  partial: number;
  failed: number;
  repairable: number;
};

export type EnrichmentModuleStatusCounts = Record<string, {
  pending: number;
  running: number;
  completed: number;
  error: number;
  notAttempted: number;
}>;

export type ResearchEnrichmentStatus = {
  enrichmentId: string;
  generation: number;
  directoryName: string;
  sourceRunId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  modules: string[];
  itemCounts: EnrichmentModuleStatusCounts;
  error: string | null;
  isForCurrentDiscovery: boolean;
  isLatestForCurrentDiscovery: boolean;
};

export type FinalizationStatus = {
  state: 'not_started' | 'in_progress' | 'awaiting_decisions' | 'ready_to_publish' | 'published';
  enrichmentId: string | null;
  finalistCount: number;
  currentDecisionCount: number;
  allFinalistsHaveCurrentDecisions: boolean;
  finalistMatrixPublished: boolean;
  artifactWarning: string | null;
};

export type LibraryPublicationStatus = {
  published: boolean;
  publicationId: string | null;
  publishedAt: string | null;
  reason: string | null;
  lookupError: string | null;
};

export type ResearchNextAction = {
  code:
    | 'resume_discovery'
    | 'repair_discovery'
    | 'run_enrichment'
    | 'resume_enrichment'
    | 'run_finalization'
    | 'supply_decisions'
    | 'publish_library'
    | 'none';
  message: string;
  command: string | null;
};

export type ResearchStatus = {
  version: '1.1.0';
  researchId: string;
  label: string;
  researchDirectory: string;
  legacy: boolean;
  discovery: {
    generation: number;
    runId: string;
    state: string;
    createdAt: string;
    updatedAt: string;
    pauseReason: string | null;
    keywordCounts: KeywordStatusCounts;
    qualityWarnings: RunQualityWarning[];
  };
  enrichments: ResearchEnrichmentStatus[];
  currentEnrichmentId: string | null;
  finalization: FinalizationStatus;
  library: LibraryPublicationStatus;
  evidenceCoverage: DeepEvidenceCoverage | null;
  nextAction: ResearchNextAction;
};

type EnrichmentRunRow = {
  enrichment_id: string;
  source_run_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  modules: string;
  error: string | null;
};

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function generationFromDirectoryName(name: string, prefix: 'discovery' | 'enrichment'): number | null {
  if (name === prefix) return 1;
  const match = name.match(new RegExp(`^${prefix}-(\\d+)$`));
  if (!match) return null;
  const generation = Number(match[1]);
  return Number.isInteger(generation) && generation >= 2 ? generation : null;
}

export function summarizeKeywordStatuses(keywords: StoredKeyword[]): KeywordStatusCounts {
  const counts: KeywordStatusCounts = {
    total: keywords.length,
    pending: 0,
    running: 0,
    completed: 0,
    partial: 0,
    failed: 0,
    repairable: 0,
  };
  for (const keyword of keywords) {
    if (keyword.status === 'pending') counts.pending += 1;
    else if (keyword.status === 'running') counts.running += 1;
    else if (keyword.status === 'completed') counts.completed += 1;
    else if (keyword.status === 'partial') counts.partial += 1;
    else if (keyword.status === 'failed') counts.failed += 1;
    if (isPrimaryRepairEligible(keyword)) counts.repairable += 1;
  }
  return counts;
}

function summarizeEnrichmentItems(items: ReturnType<RunStore['loadEnrichmentItems']>): EnrichmentModuleStatusCounts {
  const result: EnrichmentModuleStatusCounts = {};
  for (const item of items) {
    const counts = result[item.module] ?? {
      pending: 0,
      running: 0,
      completed: 0,
      error: 0,
      notAttempted: 0,
    };
    if (item.status === 'pending') counts.pending += 1;
    else if (item.status === 'running') counts.running += 1;
    else if (item.status === 'completed') counts.completed += 1;
    else if (item.status === 'error') counts.error += 1;
    else counts.notAttempted += 1;
    result[item.module] = counts;
  }
  return result;
}

function parseModules(raw: string, enrichmentId: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('modules is not a string array');
    }
    return [...value].sort((a, b) => a.localeCompare(b));
  } catch (error) {
    throw new ResearchError(
      'DB_ERROR',
      `Enrichment ${enrichmentId} has invalid persisted modules metadata.`,
      { cause: error },
    );
  }
}

async function loadEnrichments(researchDirectory: string, currentRunId: string): Promise<ResearchEnrichmentStatus[]> {
  let entries;
  try {
    entries = await readdir(researchDirectory, { withFileTypes: true });
  } catch (error) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to list research directory ${researchDirectory}.`, { cause: error });
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ entry, generation: generationFromDirectoryName(entry.name, 'enrichment') }))
    .filter((item): item is { entry: typeof entries[number]; generation: number } => item.generation !== null)
    .sort((a, b) => a.generation - b.generation);

  const enrichments: ResearchEnrichmentStatus[] = [];
  for (const candidate of candidates) {
    const enrichmentDirectory = join(researchDirectory, candidate.entry.name);
    const dbPath = join(enrichmentDirectory, 'enrichment.sqlite');
    try {
      await access(dbPath);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Cannot inspect enrichment database ${dbPath}.`, { cause: error });
    }

    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare(
        `SELECT enrichment_id, source_run_id, state, created_at, updated_at, modules, error
         FROM enrichment_runs
         ORDER BY rowid ASC`,
      ).all() as EnrichmentRunRow[];
      if (rows.length !== 1) {
        throw new ResearchError(
          'DB_ERROR',
          `Enrichment directory \"${candidate.entry.name}\" must contain exactly one enrichment run record; found ${rows.length}.`,
        );
      }
      const row = rows[0]!;

      const store = RunStore.openReadOnly(dbPath);
      let itemCounts: EnrichmentModuleStatusCounts;
      try {
        itemCounts = summarizeEnrichmentItems(store.loadEnrichmentItems(row.enrichment_id));
      } finally {
        store.close();
      }
      enrichments.push({
        enrichmentId: row.enrichment_id,
        generation: candidate.generation,
        directoryName: candidate.entry.name,
        sourceRunId: row.source_run_id,
        state: row.state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        modules: parseModules(row.modules, row.enrichment_id),
        itemCounts,
        error: row.error,
        isForCurrentDiscovery: row.source_run_id === currentRunId,
        isLatestForCurrentDiscovery: false,
      });
    } catch (error) {
      if (error instanceof ResearchError) throw error;
      throw new ResearchError('DB_ERROR', `Failed to inspect enrichment database ${dbPath}.`, { cause: error });
    } finally {
      db?.close();
    }
  }

  const current = enrichments.filter((item) => item.isForCurrentDiscovery);
  const latest = current.length === 0 ? null : current[current.length - 1] ?? null;
  if (latest) latest.isLatestForCurrentDiscovery = true;
  return enrichments;
}

type ManifestRead = {
  artifacts: Set<string>;
  warning: string | null;
  manifest: Record<string, unknown> | null;
};

async function readManifestArtifacts(enrichmentDirectory: string): Promise<ManifestRead> {
  const path = join(enrichmentDirectory, 'manifest.json');
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { artifacts: new Set(), warning: 'enrichment manifest is not an object', manifest: null };
    }
    const manifest = value as Record<string, unknown>;
    const artifacts = manifest.artifacts;
    if (!Array.isArray(artifacts) || artifacts.some((item) => typeof item !== 'string')) {
      return { artifacts: new Set(), warning: 'enrichment manifest has no valid artifacts list', manifest };
    }
    return { artifacts: new Set(artifacts as string[]), warning: null, manifest };
  } catch (error) {
    if (isEnoent(error)) return { artifacts: new Set(), warning: 'enrichment manifest is missing', manifest: null };
    return {
      artifacts: new Set(),
      warning: error instanceof Error ? error.message : String(error),
      manifest: null,
    };
  }
}

async function inspectFinalization(
  researchDirectory: string,
  enrichment: ResearchEnrichmentStatus | null,
): Promise<FinalizationStatus> {
  if (!enrichment) {
    return {
      state: 'not_started',
      enrichmentId: null,
      finalistCount: 0,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: false,
      artifactWarning: null,
    };
  }

  const enrichmentDirectory = join(researchDirectory, enrichment.directoryName);
  const store = RunStore.openReadOnly(join(enrichmentDirectory, 'enrichment.sqlite'));
  try {
    const representatives = loadRepresentativeQueryState(store, enrichment.enrichmentId);
    const entrant = loadEntrantCohortState(store, enrichment.enrichmentId);
    const decisions = loadFinalistDecisions(store, enrichment.enrichmentId);
    const manifest = await readManifestArtifacts(enrichmentDirectory);
    const matrixPublished = manifest.artifacts.has('finalist-evidence-matrix.json');
    const finalistIds = representatives?.sets.map((set) => set.clusterId) ?? [];

    let currentDecisionCount = 0;
    if (representatives && entrant) {
      const fingerprint = entrantCohortFingerprint(entrant);
      const currentDecisionIds = new Set(
        decisions
          .filter(
            (decision) => decision.representativeRevision === representatives.revision
              && decision.entrantFingerprint === fingerprint,
          )
          .map((decision) => decision.clusterId),
      );
      currentDecisionCount = finalistIds.filter((clusterId) => currentDecisionIds.has(clusterId)).length;
    }

    const allDecisions = finalistIds.length > 0 && currentDecisionCount === finalistIds.length;
    let state: FinalizationStatus['state'];
    if (!representatives) state = 'not_started';
    else if (!entrant || !matrixPublished) state = 'in_progress';
    else if (!allDecisions) state = 'awaiting_decisions';
    else state = 'ready_to_publish';

    return {
      state,
      enrichmentId: enrichment.enrichmentId,
      finalistCount: finalistIds.length,
      currentDecisionCount,
      allFinalistsHaveCurrentDecisions: allDecisions,
      finalistMatrixPublished: matrixPublished,
      artifactWarning: manifest.warning,
    };
  } finally {
    store.close();
  }
}

async function inspectEvidenceCoverage(
  researchDirectory: string,
  enrichment: ResearchEnrichmentStatus | null,
  finalization: FinalizationStatus,
): Promise<DeepEvidenceCoverage | null> {
  if (!enrichment) return null;
  const store = RunStore.openReadOnly(join(researchDirectory, enrichment.directoryName, 'enrichment.sqlite'));
  try {
    const representatives = loadRepresentativeQueryState(store, enrichment.enrichmentId);
    const entrant = loadEntrantCohortState(store, enrichment.enrichmentId);
    const history = loadCohortHistoryState(store, enrichment.enrichmentId);
    const trafficPolicy = loadTrafficEvidencePolicy(store, enrichment.enrichmentId);
    const trafficRecords = loadTrafficImportRecords(store, enrichment.enrichmentId);
    const currentTraffic = entrant !== null && trafficPolicy !== null
      ? projectCurrentTrafficEvidence({
          importedSnapshots: trafficRecords.map((record) => record.snapshot),
          cohorts: entrant.cohorts,
          policy: trafficPolicy,
        })
      : null;

    return projectDeepEvidenceCoverage({
      representatives: representatives?.sets ?? null,
      cohorts: entrant?.cohorts ?? null,
      history: history?.projections ?? null,
      traffic: {
        importedSnapshotCount: trafficRecords.length,
        policyAvailable: trafficPolicy !== null,
        current: currentTraffic,
      },
      finalistMatrixPublished: finalization.finalistMatrixPublished,
    });
  } finally {
    store.close();
  }
}

export async function inspectLibraryPublication(
  outputRoot: string,
  researchDirectory: string,
  discoveryDirectory: string,
  enrichment: ResearchEnrichmentStatus | null,
  finalization: FinalizationStatus,
): Promise<LibraryPublicationStatus> {
  if (!enrichment) {
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'no_current_enrichment',
      lookupError: null,
    };
  }

  const dbPath = join(outputRoot, 'research-library', 'library.sqlite');
  try {
    await access(dbPath);
  } catch (error) {
    if (!isEnoent(error)) {
      return {
        published: false,
        publicationId: null,
        publishedAt: null,
        reason: 'library_unavailable',
        lookupError: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: publicationReason(enrichment, finalization),
      lookupError: null,
    };
  }

  const currentManifest = await readManifestArtifacts(join(researchDirectory, enrichment.directoryName));
  if (currentManifest.manifest === null || currentManifest.warning !== null) {
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'current_manifest_unavailable',
      lookupError: currentManifest.warning,
    };
  }

  let currentSnapshotFingerprint: string;
  try {
    const snapshot = await buildResearchLibrarySnapshot({
      researchDirectory,
      discoveryDirectory,
      enrichmentDirectory: join(researchDirectory, enrichment.directoryName),
      enrichmentManifest: currentManifest.manifest,
    });
    currentSnapshotFingerprint = snapshot.snapshotFingerprint;
  } catch (error) {
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'current_snapshot_unavailable',
      lookupError: error instanceof Error ? error.message : String(error),
    };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare(
      `SELECT publication_id, published_at, snapshot_fingerprint
       FROM publications
       WHERE enrichment_id = ?
       ORDER BY published_at DESC, rowid DESC`,
    ).all(enrichment.enrichmentId) as Array<{
      publication_id: string;
      published_at: string;
      snapshot_fingerprint: string;
    }>;
    if (rows.length === 0) {
      return {
        published: false,
        publicationId: null,
        publishedAt: null,
        reason: publicationReason(enrichment, finalization),
        lookupError: null,
      };
    }
    for (const row of rows) {
      if (row.snapshot_fingerprint === currentSnapshotFingerprint) {
        return {
          published: true,
          publicationId: row.publication_id,
          publishedAt: row.published_at,
          reason: null,
          lookupError: null,
        };
      }
    }
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'current_snapshot_not_published',
      lookupError: null,
    };
  } catch (error) {
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'library_lookup_failed',
      lookupError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    db?.close();
  }
}

export function resolveFinalizationStateWithLibrary(
  state: FinalizationStatus['state'],
  published: boolean,
): FinalizationStatus['state'] {
  return published && state === 'ready_to_publish' ? 'published' : state;
}

function publicationReason(enrichment: ResearchEnrichmentStatus, finalization: FinalizationStatus): string {
  if (enrichment.state !== 'completed') return 'enrichment_not_completed';
  if (finalization.state === 'not_started') return 'finalization_not_started';
  if (!finalization.finalistMatrixPublished) return 'finalist_matrix_missing';
  if (!finalization.allFinalistsHaveCurrentDecisions) return 'decisions_incomplete';
  return 'not_published';
}

function nextActionFor(input: {
  discoveryRunId: string;
  discoveryState: string;
  keywordCounts: KeywordStatusCounts;
  enrichment: ResearchEnrichmentStatus | null;
  finalization: FinalizationStatus;
  library: LibraryPublicationStatus;
}): ResearchNextAction {
  const terminalDiscovery = input.discoveryState === 'completed' || input.discoveryState === 'completed_with_errors';
  if (!terminalDiscovery || input.keywordCounts.pending > 0 || input.keywordCounts.running > 0) {
    return {
      code: 'resume_discovery',
      message: `Discovery ${input.discoveryRunId} is not terminal; finish or resume it before downstream work.`,
      command: `npm run research -- --resume ${input.discoveryRunId}`,
    };
  }
  if (input.keywordCounts.repairable > 0) {
    return {
      code: 'repair_discovery',
      message: `${input.keywordCounts.repairable} discovery checkpoint(s) are repairable under the existing primary-evidence rules.`,
      command: `npm run research -- --resume ${input.discoveryRunId} --retry-failed`,
    };
  }
  if (!input.enrichment) {
    return {
      code: 'run_enrichment',
      message: 'No enrichment exists for the current discovery generation.',
      command: `npm run enrich:full -- --run ${input.discoveryRunId}`,
    };
  }
  if (input.enrichment.state !== 'completed') {
    return {
      code: 'resume_enrichment',
      message: `Current enrichment ${input.enrichment.enrichmentId} is ${input.enrichment.state}.`,
      command: `npm run enrich -- --resume ${input.enrichment.enrichmentId}`,
    };
  }
  if (input.finalization.state === 'not_started' || input.finalization.state === 'in_progress') {
    return {
      code: 'run_finalization',
      message: `Finalization for ${input.enrichment.enrichmentId} is ${input.finalization.state}; run finalize:full with the required explicit finalist scope/history policy for this research.`,
      command: null,
    };
  }
  if (input.finalization.state === 'awaiting_decisions') {
    return {
      code: 'supply_decisions',
      message: `${input.finalization.currentDecisionCount}/${input.finalization.finalistCount} finalist(s) have current human decisions; re-run finalize:full with an explicit --decisions file.`,
      command: null,
    };
  }
  if (!input.library.published) {
    return {
      code: 'publish_library',
      message: `Finalization evidence is current for ${input.enrichment.enrichmentId}, but no matching Library publication was found.`,
      command: `npm run library:publish -- --enrichment ${input.enrichment.enrichmentId}`,
    };
  }
  return {
    code: 'none',
    message: 'Current discovery, enrichment, finalization, and Library publication are complete.',
    command: null,
  };
}

export async function buildResearchStatus(input: {
  outputRoot: string;
  targetRunId: string;
}): Promise<ResearchStatus> {
  const target = await resolveRunLocation(input.outputRoot, input.targetRunId);
  const container = target.legacy ? null : await readResearchContainer(target.researchDirectory);
  const currentRunId = container?.currentRunId ?? input.targetRunId;
  const currentLocation = currentRunId === input.targetRunId
    ? target
    : await resolveRunLocation(input.outputRoot, currentRunId);

  if (!target.legacy && currentLocation.researchDirectory !== target.researchDirectory) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Research ${container?.researchId ?? input.targetRunId} points to a current run outside its research directory.`,
    );
  }

  const discoveryStore = RunStore.openReadOnly(join(currentLocation.discoveryDirectory, 'run.sqlite'));
  let run;
  let keywords;
  let qualityWarnings: RunQualityWarning[];
  try {
    run = discoveryStore.loadRun(currentRunId);
    if (!run) throw new ResearchError('RESUME_NOT_FOUND', `Current research run not found: ${currentRunId}`);
    keywords = discoveryStore.loadKeywords(currentRunId);
    const quality = buildRunQuality({
      run,
      state: run.state,
      keywords,
      serpRows: discoveryStore.loadSerpRows(currentRunId),
      relatedKeywords: discoveryStore.loadRelatedKeywords(currentRunId),
      domains: discoveryStore.loadDomains(currentRunId),
    });
    qualityWarnings = quality.warnings;
  } finally {
    discoveryStore.close();
  }

  const keywordCounts = summarizeKeywordStatuses(keywords);
  const enrichments = target.legacy ? [] : await loadEnrichments(target.researchDirectory, currentRunId);
  const currentEnrichment = enrichments.find((item) => item.isLatestForCurrentDiscovery) ?? null;
  const finalization = target.legacy
    ? {
        state: 'not_started' as const,
        enrichmentId: null,
        finalistCount: 0,
        currentDecisionCount: 0,
        allFinalistsHaveCurrentDecisions: false,
        finalistMatrixPublished: false,
        artifactWarning: null,
      }
    : await inspectFinalization(target.researchDirectory, currentEnrichment);
  const evidenceCoverage = target.legacy
    ? null
    : await inspectEvidenceCoverage(target.researchDirectory, currentEnrichment, finalization);
  const library = target.legacy
    ? {
        published: false,
        publicationId: null,
        publishedAt: null,
        reason: 'legacy_layout',
        lookupError: null,
      }
    : await inspectLibraryPublication(
        input.outputRoot,
        target.researchDirectory,
        currentLocation.discoveryDirectory,
        currentEnrichment,
        finalization,
      );

  finalization.state = resolveFinalizationStateWithLibrary(finalization.state, library.published);

  const discoveryGeneration = generationFromDirectoryName(basename(currentLocation.discoveryDirectory), 'discovery') ?? 1;
  const status: ResearchStatus = {
    version: '1.1.0',
    researchId: container?.researchId ?? currentRunId,
    label: container?.label ?? basename(target.researchDirectory),
    researchDirectory: target.researchDirectory,
    legacy: target.legacy,
    discovery: {
      generation: discoveryGeneration,
      runId: currentRunId,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      pauseReason: run.pauseReason,
      keywordCounts,
      qualityWarnings,
    },
    enrichments,
    currentEnrichmentId: currentEnrichment?.enrichmentId ?? null,
    finalization,
    library,
    evidenceCoverage,
    nextAction: nextActionFor({
      discoveryRunId: currentRunId,
      discoveryState: run.state,
      keywordCounts,
      enrichment: currentEnrichment,
      finalization,
      library,
    }),
  };
  return status;
}
