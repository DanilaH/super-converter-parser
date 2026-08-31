import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  buildLibraryPublicationSummary,
  buildResearchStatus,
  generationFromDirectoryName,
  storedPublicationSummaryMatches,
} from './status.js';

const CONFIG = loadConfig({});

async function createDiscovery(input: {
  outputRoot: string;
  researchDirectory: string;
  directory: string;
  runId: string;
  statuses: Array<'completed' | 'failed'>;
  state: 'completed' | 'completed_with_errors';
}): Promise<void> {
  await mkdir(input.directory, { recursive: true });
  const seeds = buildSeedKeywords(input.statuses.map((_, index) => ({
    keyword: `status keyword ${index + 1}`,
    rowNumber: index + 1,
  })));
  const store = RunStore.open(join(input.directory, 'run.sqlite'));
  store.createRun({
    runId: input.runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: 'fixture.csv' },
    keywords: seeds,
  });
  const rows = store.loadKeywords(input.runId);
  for (const [index, status] of input.statuses.entries()) {
    const keyword = rows[index]!;
    if (status === 'completed') {
      store.commitKeyword(input.runId, {
        ...keyword,
        status: 'completed',
        surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-08-31T00:00:00.000Z' },
        google: {
          hl: 'en',
          gl: 'us',
          pageUrl: `https://google.com/search?q=${index}`,
          detectedLocation: null,
          geoWarning: false,
          serpStatus: 'empty',
          serpError: null,
        },
        error: null,
        collectedAt: '2026-08-31T00:00:00.000Z',
      }, [], 'miss');
    } else {
      store.commitKeyword(input.runId, {
        ...keyword,
        status: 'failed',
        surfer: null,
        google: {
          hl: 'en',
          gl: 'us',
          pageUrl: `https://google.com/search?q=${index}`,
          detectedLocation: null,
          geoWarning: false,
          serpStatus: 'fetch_error',
          serpError: { code: 'GOOGLE_UNAVAILABLE', message: 'fixture unavailable' },
        },
        error: { code: 'GOOGLE_UNAVAILABLE', message: 'fixture unavailable' },
        collectedAt: '2026-08-31T00:00:00.000Z',
      }, [], 'miss');
    }
  }
  store.setRunState(input.runId, input.state, { updatedAt: '2026-08-31T00:01:00.000Z' });
  store.close();
  await writeRunIndex(input.outputRoot, {
    version: 1,
    runId: input.runId,
    researchDirectory: input.researchDirectory,
    discoveryDirectory: input.directory,
  });
}

async function writeContainer(
  researchDirectory: string,
  researchId: string,
  currentRunId: string,
): Promise<void> {
  await writeFile(join(researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId,
    label: 'status-fixture',
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    currentRunId,
    batches: [],
  }, null, 2)}\n`, 'utf8');
}

test('generation parser uses immutable directory suffixes and rejects unrelated names', () => {
  assert.equal(generationFromDirectoryName('discovery', 'discovery'), 1);
  assert.equal(generationFromDirectoryName('discovery-02', 'discovery'), 2);
  assert.equal(generationFromDirectoryName('enrichment-17', 'enrichment'), 17);
  assert.equal(generationFromDirectoryName('enrichment-old', 'enrichment'), null);
  assert.equal(generationFromDirectoryName('discovery-01', 'discovery'), null);
});

test('status resolves an historical target id to the research current discovery and exact repair rules', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-current-'));
  const location = await allocateResearchLocation(outputRoot, 'status fixture', new Date('2026-08-30T00:00:00Z'));
  const oldRunId = 'run_status_old';
  const currentRunId = 'run_status_current';
  await createDiscovery({
    outputRoot,
    researchDirectory: location.researchDirectory,
    directory: location.discoveryDirectory,
    runId: oldRunId,
    statuses: ['completed'],
    state: 'completed',
  });
  const currentDirectory = join(location.researchDirectory, 'discovery-02');
  await createDiscovery({
    outputRoot,
    researchDirectory: location.researchDirectory,
    directory: currentDirectory,
    runId: currentRunId,
    statuses: ['completed', 'failed'],
    state: 'completed_with_errors',
  });
  await writeContainer(location.researchDirectory, oldRunId, currentRunId);

  const status = await buildResearchStatus({ outputRoot, targetRunId: oldRunId });
  assert.equal(status.researchId, oldRunId);
  assert.equal(status.discovery.runId, currentRunId);
  assert.equal(status.discovery.generation, 2);
  assert.equal(status.discovery.keywordCounts.total, 2);
  assert.equal(status.discovery.keywordCounts.completed, 1);
  assert.equal(status.discovery.keywordCounts.failed, 1);
  assert.equal(status.discovery.keywordCounts.repairable, 1);
  assert.equal(status.nextAction.code, 'repair_discovery');
  assert.match(status.nextAction.command ?? '', /--retry-failed/);
});

test('status selects the highest persisted enrichment generation for the current discovery without mtime inference', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-enrich-'));
  const location = await allocateResearchLocation(outputRoot, 'status enrichment', new Date('2026-08-30T00:00:00Z'));
  const currentRunId = 'run_status_enriched';
  await createDiscovery({
    outputRoot,
    researchDirectory: location.researchDirectory,
    directory: location.discoveryDirectory,
    runId: currentRunId,
    statuses: ['completed', 'completed'],
    state: 'completed',
  });
  await writeContainer(location.researchDirectory, currentRunId, currentRunId);

  const firstDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  const firstStore = RunStore.open(join(firstDirectory, 'enrichment.sqlite'));
  firstStore.createEnrichmentRun({
    enrichmentId: 'enrichment_status_1',
    sourceRunId: currentRunId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory: firstDirectory,
  });
  firstStore.upsertEnrichmentItem({
    enrichmentId: 'enrichment_status_1',
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
  });
  firstStore.setEnrichmentState('enrichment_status_1', 'completed');
  firstStore.close();
  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId: 'enrichment_status_1',
    runId: currentRunId,
    researchDirectory: location.researchDirectory,
    enrichmentDirectory: firstDirectory,
  });

  const secondDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  const secondStore = RunStore.open(join(secondDirectory, 'enrichment.sqlite'));
  secondStore.createEnrichmentRun({
    enrichmentId: 'enrichment_status_2',
    sourceRunId: currentRunId,
    modules: ['clusters', 'query_suggestions'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory: secondDirectory,
  });
  secondStore.upsertEnrichmentItem({
    enrichmentId: 'enrichment_status_2',
    itemId: 'clusters',
    module: 'clusters',
    status: 'completed',
    source: 'serp_overlap',
  });
  secondStore.upsertEnrichmentItem({
    enrichmentId: 'enrichment_status_2',
    itemId: 'suggestions',
    module: 'query_suggestions',
    status: 'pending',
    source: 'google',
  });
  secondStore.setEnrichmentState('enrichment_status_2', 'paused');
  secondStore.close();
  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId: 'enrichment_status_2',
    runId: currentRunId,
    researchDirectory: location.researchDirectory,
    enrichmentDirectory: secondDirectory,
  });

  const status = await buildResearchStatus({ outputRoot, targetRunId: currentRunId });
  assert.equal(status.enrichments.length, 2);
  assert.equal(status.enrichments[0]?.generation, 1);
  assert.equal(status.enrichments[0]?.isLatestForCurrentDiscovery, false);
  assert.equal(status.enrichments[1]?.generation, 2);
  assert.equal(status.enrichments[1]?.isLatestForCurrentDiscovery, true);
  assert.equal(status.currentEnrichmentId, 'enrichment_status_2');
  assert.equal(status.enrichments[1]?.itemCounts.query_suggestions?.pending, 1);
  assert.equal(status.nextAction.code, 'resume_enrichment');
  assert.match(status.nextAction.command ?? '', /enrichment_status_2/);
});

test('Library publication matching rejects stale same-enrichment metadata', () => {
  const oldManifest = {
    modules: ['clusters'],
    summary: { clusterCount: 2 },
    representativeQueries: { revision: 1 },
    entrantCohort: { representativeRevision: 1 },
    cohortHistory: null,
    trafficEvidence: null,
    finalistEvidence: { currentHumanDecisionCount: 1 },
  };
  const currentManifest = {
    ...oldManifest,
    finalistEvidence: { currentHumanDecisionCount: 2 },
  };
  const stored = JSON.stringify(buildLibraryPublicationSummary(oldManifest));
  assert.equal(storedPublicationSummaryMatches(stored, buildLibraryPublicationSummary(oldManifest)), true);
  assert.equal(storedPublicationSummaryMatches(stored, buildLibraryPublicationSummary(currentManifest)), false);
  assert.equal(storedPublicationSummaryMatches('{broken', buildLibraryPublicationSummary(oldManifest)), false);
});

test('status fails closed when one immutable enrichment directory contains multiple run identities', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-corrupt-enrichment-'));
  const location = await allocateResearchLocation(outputRoot, 'status corrupt enrichment', new Date('2026-08-30T00:00:00Z'));
  const runId = 'run_status_corrupt_enrichment';
  await createDiscovery({
    outputRoot,
    researchDirectory: location.researchDirectory,
    directory: location.discoveryDirectory,
    runId,
    statuses: ['completed'],
    state: 'completed',
  });
  await writeContainer(location.researchDirectory, runId, runId);

  const enrichmentDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  store.createEnrichmentRun({
    enrichmentId: 'enrichment_corrupt_a',
    sourceRunId: runId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory,
  });
  store.createEnrichmentRun({
    enrichmentId: 'enrichment_corrupt_b',
    sourceRunId: runId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory,
  });
  store.close();

  await assert.rejects(
    buildResearchStatus({ outputRoot, targetRunId: runId }),
    /must contain exactly one enrichment run record; found 2/,
  );
});
