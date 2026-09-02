import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunStore } from '../db/store.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { OperatorGuiService } from './service.js';

function statusWithCurrentEnrichment(
  researchDirectory: string,
  enrichmentId: string,
): ResearchStatusWithHistoricalPresence {
  return {
    version: '1.2.0',
    researchId: 'research-1',
    label: 'evidence research',
    researchDirectory,
    legacy: false,
    discovery: {
      generation: 1,
      runId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:01.000Z',
      pauseReason: null,
      keywordCounts: {
        total: 2,
        pending: 0,
        running: 0,
        completed: 2,
        partial: 0,
        failed: 0,
        repairable: 0,
      },
      qualityWarnings: [],
    },
    enrichments: [{
      enrichmentId,
      generation: 1,
      directoryName: 'enrichment',
      sourceRunId: 'research-1',
      state: 'completed',
      createdAt: '2026-09-01T00:00:02.000Z',
      updatedAt: '2026-09-01T00:00:03.000Z',
      modules: ['clusters'],
      itemCounts: {},
      error: null,
      isForCurrentDiscovery: true,
      isLatestForCurrentDiscovery: true,
    }],
    currentEnrichmentId: enrichmentId,
    finalization: {
      state: 'awaiting_decisions',
      enrichmentId,
      finalistCount: 1,
      currentDecisionCount: 0,
      allFinalistsHaveCurrentDecisions: false,
      finalistMatrixPublished: true,
      artifactWarning: null,
    },
    library: {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: 'decisions_incomplete',
      lookupError: null,
    },
    evidenceCoverage: null,
    sampledHistoricalPresence: null,
    nextAction: { code: 'supply_decisions', message: 'Supply decisions.', command: null },
  };
}

test('GUI reads clusters and finalist evidence only from the current enrichment directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'operator-gui-evidence-'));
  const researchDirectory = join(root, 'output', 'research-1');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  await mkdir(enrichmentDirectory, { recursive: true });

  const enrichmentId = 'enrichment-current';
  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));
  try {
    store.createEnrichmentRun({
      enrichmentId,
      sourceRunId: 'research-1',
      modules: ['clusters'],
      config: '{}',
      sourceRunDirectory: join(researchDirectory, 'discovery'),
      enrichmentDirectory,
    });
    store.saveKeywordClusters(enrichmentId, [
      {
        clusterId: 'cluster-10',
        canonicalKeywordIdx: 1,
        canonicalKeyword: 'json validator',
        members: [{ keywordIdx: 1, keyword: 'json validator', normalizedKeyword: 'json validator', volume: 100, serpSize: 10 }],
        representativeDomains: ['example.com'],
        medianVolume: 100,
        averageVolume: 100,
        cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },
        algorithmVersion: 'test',
        config: {
          topN: 10,
          edgeRule: { minSharedDomains: 3, minJaccard: 0.3, minSharedUrls: 2, minUrlJaccard: 0.1 },
          algorithmVersion: 'test',
        },
      },
      {
        clusterId: 'cluster-2',
        canonicalKeywordIdx: 0,
        canonicalKeyword: 'json formatter',
        members: [{ keywordIdx: 0, keyword: 'json formatter', normalizedKeyword: 'json formatter', volume: 200, serpSize: 10 }],
        representativeDomains: ['example.org'],
        medianVolume: 200,
        averageVolume: 200,
        cohesion: { pairCount: 0, urlJaccard: null, domainJaccard: null },
        algorithmVersion: 'test',
        config: {
          topN: 10,
          edgeRule: { minSharedDomains: 3, minJaccard: 0.3, minSharedUrls: 2, minUrlJaccard: 0.1 },
          algorithmVersion: 'test',
        },
      },
    ]);
    store.setEnrichmentState(enrichmentId, 'completed');
  } finally {
    store.close();
  }

  const artifactPath = join(enrichmentDirectory, 'finalist-evidence-matrix.json');
  const artifact = {
    version: '1.1.0',
    enrichmentId,
    sourceRunId: 'research-1',
    representativeRevision: 1,
    entrantFingerprint: 'entrant-fingerprint',
    matrix: {
      finalistCount: 1,
      finalists: [{ clusterId: 'cluster-2', canonicalKeyword: 'json formatter', auditFlags: ['HUMAN_DECISION_UNRECORDED'] }],
    },
  };
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  const service = new OperatorGuiService({
    outputRoot: join(root, 'output'),
    draftRoot: join(root, 'drafts'),
    deps: {
      buildStatus: async () => statusWithCurrentEnrichment(researchDirectory, enrichmentId),
    },
  });
  await mkdir(service.draftRoot, { recursive: true });

  assert.deepEqual(
    (await service.clusters('research-1')).map((cluster) => cluster.clusterId),
    ['cluster-2', 'cluster-10'],
  );
  assert.deepEqual(await service.finalistEvidence('research-1'), artifact);

  await rm(artifactPath);
  assert.equal(await service.finalistEvidence('research-1'), null, 'invalidated/missing current artifact must not be invented');

  await service.close();
});
