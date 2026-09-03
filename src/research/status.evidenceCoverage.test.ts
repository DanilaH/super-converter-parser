import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/config.js';
import { saveRepresentativeQuerySnapshot } from '../db/representativeSets.js';
import { RunStore } from '../db/store.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { buildResearchStatus } from './status.js';

const CONFIG = loadConfig({});

test('research status projects persisted representative evidence gaps from the current enrichment', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-evidence-'));
  const location = await allocateResearchLocation(outputRoot, 'status evidence', new Date('2026-08-31T00:00:00Z'));
  const runId = 'run_status_evidence';
  const enrichmentId = 'enrichment_status_evidence';

  const discoveryStore = RunStore.open(join(location.discoveryDirectory, 'run.sqlite'));
  const [seed] = buildSeedKeywords([{ keyword: 'status evidence keyword', rowNumber: 1 }]);
  if (!seed) throw new Error('fixture seed missing');
  discoveryStore.createRun({
    runId,
    configSnapshot: CONFIG,
    parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
    input: { kind: 'seeds', path: 'fixture.csv' },
    keywords: [seed],
  });
  const [keyword] = discoveryStore.loadKeywords(runId);
  if (!keyword) throw new Error('fixture keyword missing');
  discoveryStore.commitKeyword(runId, {
    ...keyword,
    status: 'completed',
    surfer: { volume: 100, cpc: 1, market: 'US', fetchedAt: '2026-08-31T00:00:00.000Z' },
    google: {
      hl: 'en',
      gl: 'us',
      pageUrl: 'https://google.com/search?q=status-evidence',
      detectedLocation: null,
      geoWarning: false,
      serpStatus: 'empty',
      serpError: null,
    },
    error: null,
    collectedAt: '2026-08-31T00:00:00.000Z',
  }, [], 'miss');
  discoveryStore.setRunState(runId, 'completed', { updatedAt: '2026-08-31T00:01:00.000Z' });
  discoveryStore.close();

  await writeRunIndex(outputRoot, {
    version: 1,
    runId,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });
  await writeFile(join(location.researchDirectory, 'research.json'), `${JSON.stringify({
    version: 1,
    researchId: runId,
    label: 'status-evidence',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:01:00.000Z',
    currentRunId: runId,
    batches: [{
      batchId: 'batch-0001',
      createdAt: '2026-08-31T00:00:00.000Z',
      input: { kind: 'seeds', originalPath: 'fixture.csv', storedPath: null },
      sourceRowCount: 1,
      inputUniqueKeywordCount: 1,
      addedKeywordCount: 1,
      duplicateKeywordCount: 0,
      normalizedKeywords: ['status evidence keyword'],
      newNormalizedKeywords: ['status evidence keyword'],
      resultRunId: runId,
    }],
  }, null, 2)}\n`, 'utf8');

  const enrichmentDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  const enrichmentStore = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId: runId,
    modules: ['clusters'],
    config: '{}',
    sourceRunDirectory: location.discoveryDirectory,
    enrichmentDirectory,
  });
  saveRepresentativeQuerySnapshot(
    enrichmentStore,
    enrichmentId,
    {
      targetCount: 5,
      overrides: [],
      setVersion: '1.0.0',
      selectedClusterIds: ['cluster-1'],
    },
    [{
      clusterId: 'cluster-1',
      setVersion: '1.0.0',
      representativeKeywordIds: [0],
      representatives: [{
        keywordIdx: 0,
        keyword: 'status evidence keyword',
        normalizedKeyword: 'status evidence keyword',
        volume: 100,
        selectionReason: 'medoid',
        coverageGain: 1,
      }],
      targetCount: 1,
      clusterUrlCount: 1,
      coveredUrlCount: 1,
      manualOverride: false,
      manualOverrideReason: null,
    }],
  );
  enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
  enrichmentStore.close();

  await writeEnrichmentIndex(outputRoot, {
    version: 1,
    enrichmentId,
    runId,
    researchDirectory: location.researchDirectory,
    enrichmentDirectory,
  });

  const status = await buildResearchStatus({ outputRoot, targetRunId: runId });
  assert.equal(status.version, '1.1.0');
  assert.equal(status.currentEnrichmentId, enrichmentId);
  assert.equal(status.finalization.state, 'in_progress');
  assert.deepEqual(status.evidenceCoverage?.representativeUrlCoverage, {
    numerator: 1,
    denominator: 1,
    ratio: 1,
  });
  assert.equal(status.evidenceCoverage?.entrantDomainRows, 0);
  assert.deepEqual(
    status.evidenceCoverage?.warnings.map((warning) => warning.code),
    ['ENTRANT_COHORT_NOT_COLLECTED'],
  );
});
