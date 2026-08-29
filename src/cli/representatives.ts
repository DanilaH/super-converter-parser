import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import { RunStore } from '../db/store.js';
import {
  loadRepresentativeQueryHistory,
  loadRepresentativeQueryState,
  saveRepresentativeQuerySnapshot,
} from '../db/representativeSets.js';
import {
  archiveResearchDirectory,
  resolveEnrichmentLocation,
  resolveOutputRoot,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import {
  CLUSTERING_ALGORITHM_VERSION,
  type ClusteringResult,
} from '../enrichment/clustering.js';
import { loadPersistedClusteringRelations } from '../enrichment/clusteringSnapshot.js';
import { CLUSTER_URL_IDENTITY_VERSION } from '../enrichment/urlIdentity.js';
import { buildRepresentativeQuerySets } from '../enrichment/representativeSets.js';
import {
  MAX_REPRESENTATIVE_QUERY_COUNT,
  MIN_REPRESENTATIVE_QUERY_COUNT,
} from '../enrichment/representativeQueries.js';
import {
  parseRepresentativeOverridesJson,
  resolveRepresentativeQueriesConfig,
} from '../enrichment/representativeConfig.js';
import {
  writeRepresentativeQueriesCsv,
  writeRepresentativeQueriesJson,
} from '../enrichment/representativeOutputs.js';
import { publishRepresentativeMetadata } from '../enrichment/representativePublication.js';
import { assertRepresentativeSourceFreshness } from '../enrichment/representativeSourceFreshness.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

const EXIT_OK = 0;
const EXIT_INTERNAL = 1;
const EXIT_INVALID_INPUT = 2;

interface ParsedArgs {
  help: boolean;
  enrichmentId: string;
  targetCount: number | undefined;
  overridesPath: string | undefined;
  selectedClusterIds: string[] | undefined;
  allClusters: boolean;
  outputRoot: string | null;
}

function nextOptionValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value`);
  }
  return value;
}

function parseClusterIds(raw: string): string[] {
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--clusters requires at least one cluster id');
  }
  return values;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let help = false;
  let enrichmentId = '';
  let targetCount: number | undefined;
  let overridesPath: string | undefined;
  let selectedClusterIds: string[] | undefined;
  let allClusters = false;
  let outputRoot: string | null = null;

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--enrichment') {
      enrichmentId = nextOptionValue(args, '--enrichment');
    } else if (arg === '--clusters') {
      if (selectedClusterIds !== undefined) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', '--clusters may be supplied only once');
      }
      selectedClusterIds = parseClusterIds(nextOptionValue(args, '--clusters'));
    } else if (arg === '--all-clusters') {
      allClusters = true;
    } else if (arg === '--representative-count') {
      const raw = nextOptionValue(args, '--representative-count');
      const parsed = Number(raw);
      if (
        !Number.isInteger(parsed)
        || parsed < MIN_REPRESENTATIVE_QUERY_COUNT
        || parsed > MAX_REPRESENTATIVE_QUERY_COUNT
      ) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `--representative-count must be an integer in [${MIN_REPRESENTATIVE_QUERY_COUNT}, ${MAX_REPRESENTATIVE_QUERY_COUNT}], got ${raw}`,
        );
      }
      targetCount = parsed;
    } else if (arg === '--representative-overrides') {
      overridesPath = nextOptionValue(args, '--representative-overrides');
    } else if (arg === '--output-root') {
      outputRoot = nextOptionValue(args, '--output-root');
    } else if (arg?.startsWith('-')) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    } else if (arg) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
    }
  }

  if (!help && enrichmentId === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--enrichment <id> is required');
  }
  if (selectedClusterIds !== undefined && allClusters) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Use either --clusters or --all-clusters, not both');
  }

  return {
    help,
    enrichmentId,
    targetCount,
    overridesPath,
    selectedClusterIds,
    allClusters,
    outputRoot,
  };
}

function printUsage(): void {
  console.log('Utility Research Representative Queries');
  console.log('');
  console.log('Usage:');
  console.log('  npm run representatives -- --enrichment <enrichment-id> --clusters cluster-1,cluster-4');
  console.log('  npm run representatives -- --enrichment <enrichment-id> --all-clusters');
  console.log('');
  console.log('Options:');
  console.log('  --clusters <ids>                  Explicit comma-separated finalist cluster ids.');
  console.log('  --all-clusters                    Explicitly treat every current cluster as a finalist.');
  console.log('                                   A rerun may omit both flags to reuse persisted scope.');
  console.log(`  --representative-count <${MIN_REPRESENTATIVE_QUERY_COUNT}-${MAX_REPRESENTATIVE_QUERY_COUNT}>  Target representatives per cluster (default 5; small clusters keep all members).`);
  console.log('  --representative-overrides <path>  JSON array of { clusterId, keywordIds, reason }.');
  console.log('                                   An explicit [] clears persisted overrides.');
  console.log('  --output-root <path>              Durable research output root.');
  console.log('  --help                            Show this help.');
}

async function loadOverrides(path: string | undefined) {
  if (path === undefined) return undefined;
  const absolute = resolve(path);
  let content: string;
  try {
    content = await readFile(absolute, 'utf8');
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Cannot read representative override file "${path}".`,
      { cause: error },
    );
  }
  try {
    return parseRepresentativeOverridesJson(content, `Representative override file "${path}"`);
  } catch (error) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}

function resolveSelectedClusters(input: {
  currentClusterIds: string[];
  previousClusterIds: string[] | undefined;
  requestedClusterIds: string[] | undefined;
  allClusters: boolean;
}): string[] {
  const current = new Set(input.currentClusterIds);
  const selected = input.allClusters
    ? input.currentClusterIds
    : input.requestedClusterIds ?? input.previousClusterIds;
  if (!selected || selected.length === 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'First representative-query run requires explicit finalist scope via --clusters <ids> or --all-clusters.',
    );
  }
  const unknown = selected.filter((clusterId) => !current.has(clusterId));
  if (unknown.length > 0) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Representative finalist scope references unknown current cluster(s): ${unknown.join(', ')}`,
    );
  }
  return selected;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const outputRoot = resolveOutputRoot(args.outputRoot);
  const enrichmentLocation = await resolveEnrichmentLocation(outputRoot, args.enrichmentId);
  const enrichmentStore = RunStore.open(join(enrichmentLocation.enrichmentDirectory, 'enrichment.sqlite'));
  let sourceStore: RunStore | undefined;

  try {
    const run = enrichmentStore.loadEnrichmentRun(args.enrichmentId);
    if (!run) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment not found: ${args.enrichmentId}`);
    }
    if (run.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Representative queries require a completed enrichment; ${args.enrichmentId} is ${run.state}.`,
      );
    }
    if (!run.modules.includes('clusters')) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} did not run the clusters module.`,
      );
    }

    const clusteringConfig = run.config.clusters;
    if (
      !clusteringConfig
      || clusteringConfig.algorithmVersion !== CLUSTERING_ALGORITHM_VERSION
      || clusteringConfig.urlIdentityVersion !== CLUSTER_URL_IDENTITY_VERSION
      || clusteringConfig.groupingRule !== 'complete_link'
    ) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Representative queries require completed clustering ${CLUSTERING_ALGORITHM_VERSION} with URL identity ${CLUSTER_URL_IDENTITY_VERSION} and complete-link grouping. Historical clustering remains readable but is not retrofitted.`,
      );
    }

    const clusteringItem = enrichmentStore.loadEnrichmentItems(args.enrichmentId).find(
      (item) => item.itemId === 'clusters' && item.module === 'clusters',
    );
    if (!clusteringItem || clusteringItem.status !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} has no completed clusters checkpoint.`,
      );
    }

    const clusters = enrichmentStore.loadKeywordClusters(args.enrichmentId);
    if (clusters.length === 0) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Enrichment ${args.enrichmentId} contains no clusters.`);
    }
    if (clusters.some((cluster) => cluster.canonicalKeywordIdx === null || cluster.members.some((member) => member.keywordIdx === null))) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Enrichment ${args.enrichmentId} contains historical text-owned cluster rows and cannot produce representative query identities safely.`,
      );
    }
    const { pairs } = loadPersistedClusteringRelations(enrichmentStore, args.enrichmentId);

    const previousState = loadRepresentativeQueryState(enrichmentStore, args.enrichmentId);
    const selectedClusterIds = resolveSelectedClusters({
      currentClusterIds: clusters.map((cluster) => cluster.clusterId),
      previousClusterIds: previousState?.config.selectedClusterIds,
      requestedClusterIds: args.selectedClusterIds,
      allClusters: args.allClusters,
    });
    const selectedIdSet = new Set(selectedClusterIds);
    const selectedClusters = clusters.filter((cluster) => selectedIdSet.has(cluster.clusterId));
    const selectedKeywordIds = new Set(
      selectedClusters.flatMap((cluster) => cluster.members.map((member) => member.keywordIdx as number)),
    );
    const selectedPairs = pairs.filter(
      (pair) => pair.keywordAIdx !== null
        && pair.keywordBIdx !== null
        && selectedKeywordIds.has(pair.keywordAIdx)
        && selectedKeywordIds.has(pair.keywordBIdx),
    );
    const clustering: Pick<ClusteringResult, 'clusters' | 'pairs'> = {
      clusters: selectedClusters,
      pairs: selectedPairs,
    };

    const overrides = await loadOverrides(args.overridesPath);
    const representativeConfig = resolveRepresentativeQueriesConfig({
      existing: previousState?.config,
      targetCount: args.targetCount,
      overrides,
      selectedClusterIds,
    });

    const sourceLocation = await resolveRunLocation(outputRoot, run.sourceRunId);
    sourceStore = RunStore.openReadOnly(join(sourceLocation.discoveryDirectory, 'run.sqlite'));
    const sourceRun = sourceStore.loadRun(run.sourceRunId);
    if (!sourceRun) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Source run not found: ${run.sourceRunId}`);
    }
    if (sourceRun.state !== 'completed') {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Source run ${run.sourceRunId} is ${sourceRun.state}; representative queries require the completed source snapshot used by clustering.`,
      );
    }
    try {
      assertRepresentativeSourceFreshness({
        sourceRunId: run.sourceRunId,
        sourceUpdatedAt: sourceRun.updatedAt,
        clusteringUpdatedAt: clusteringItem.updatedAt,
      });
    } catch (error) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }

    const sets = buildRepresentativeQuerySets({
      clusters: clustering.clusters,
      pairs: clustering.pairs,
      serpRows: sourceStore.loadSerpRows(run.sourceRunId),
      topN: clusteringConfig.topN,
      config: representativeConfig,
    });

    const saveResult = saveRepresentativeQuerySnapshot(
      enrichmentStore,
      args.enrichmentId,
      representativeConfig,
      sets,
    );
    const history = loadRepresentativeQueryHistory(enrichmentStore, args.enrichmentId);
    const previousRevision = history.find((entry) => entry.revision === saveResult.revision - 1);

    const csvPath = join(enrichmentLocation.enrichmentDirectory, 'representative-queries.csv');
    const jsonPath = join(enrichmentLocation.enrichmentDirectory, 'representative-queries.json');
    await writeRepresentativeQueriesCsv(csvPath, {
      sets,
      revision: saveResult.revision,
      previousSets: previousRevision?.sets,
    });
    await writeRepresentativeQueriesJson(jsonPath, {
      enrichmentId: args.enrichmentId,
      sourceRunId: run.sourceRunId,
      config: representativeConfig,
      sets,
      revision: saveResult.revision,
      changed: saveResult.changed,
      previousSets: previousRevision?.sets,
    });

    const queryCount = sets.reduce((sum, set) => sum + set.representativeKeywordIds.length, 0);
    const manualOverrideCount = sets.filter((set) => set.manualOverride).length;
    await publishRepresentativeMetadata({
      enrichmentDirectory: enrichmentLocation.enrichmentDirectory,
      enrichmentId: args.enrichmentId,
      sourceRunId: run.sourceRunId,
      config: representativeConfig,
      summary: {
        revision: saveResult.revision,
        changed: saveResult.changed,
        setVersion: representativeConfig.setVersion,
        targetCount: representativeConfig.targetCount,
        setCount: sets.length,
        queryCount,
        manualOverrideCount,
      },
    });
    await archiveResearchDirectory(enrichmentLocation.researchDirectory);

    console.log(
      `Representative queries: ${sets.length} finalist cluster set(s), ${queryCount} query selection(s), revision ${saveResult.revision}${saveResult.changed ? ' (new)' : ' (unchanged)'}, ${manualOverrideCount} manual override(s).`,
    );
    console.log(`Finalist clusters: ${representativeConfig.selectedClusterIds.join(', ')}`);
    console.log(`Artifacts: ${csvPath}, ${jsonPath}`);
  } finally {
    sourceStore?.close();
    enrichmentStore.close();
  }
}

main()
  .then(() => {
    process.exitCode = EXIT_OK;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = error instanceof ResearchError && error.code === 'INPUT_SCHEMA_ERROR'
      ? EXIT_INVALID_INPUT
      : EXIT_INTERNAL;
  });
