import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entrantCohortFingerprint } from '../db/cohortHistory.js';
import type { EntrantCohortSnapshot } from '../db/entrantCohorts.js';
import type { CohortHistoricalPresenceSnapshot } from '../db/cohortHistoricalPresence.js';
import { DEFAULT_HISTORICAL_PRESENCE_CONFIG } from './types.js';
import { publishCohortHistoricalPresenceMetadata } from './cohortPublication.js';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function entrant(): EntrantCohortSnapshot {
  return {
    enrichmentId: 'enr-1',
    sourceRunId: 'run-1',
    representativeRevision: 1,
    cohortVersion: '1.0.0',
    serpTopN: 10,
    drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
    sourceRunUpdatedAt: '2026-08-31T00:00:00.000Z',
    clusteringUpdatedAt: '2026-08-31T00:01:00.000Z',
    cohorts: [],
  };
}

function sampledSnapshot(parent: EntrantCohortSnapshot): CohortHistoricalPresenceSnapshot {
  return {
    enrichmentId: parent.enrichmentId,
    sourceRunId: parent.sourceRunId,
    entrantRepresentativeRevision: parent.representativeRevision,
    entrantFingerprint: entrantCohortFingerprint(parent),
    collectionVersion: '1.0.0',
    config: { ...DEFAULT_HISTORICAL_PRESENCE_CONFIG, domainCap: 30 },
    collection: {
      version: '1.0.0',
      domainCap: 30,
      domains: [],
      summary: {
        uniqueDomainCount: 0,
        checkedDomainCount: 0,
        omittedDomainCount: 0,
        knownPresenceDomainCount: 0,
        notFoundDomainCount: 0,
        unavailableDomainCount: 0,
        errorDomainCount: 0,
        completeSelectedHistoryDomainCount: 0,
        cacheHitCount: 0,
        networkRequestCount: 0,
        statusCounts: {},
      },
    },
  };
}

test('changed sampled historical presence removes stale finalist publication before republishing sampled metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sampled-finalist-invalidation-'));
  try {
    const parent = entrant();
    const snapshot = sampledSnapshot(parent);
    const base = {
      enrichmentId: 'enr-1',
      sourceRunId: 'run-1',
      artifacts: [
        'entrant-cohort.json',
        'finalist-evidence-matrix.csv',
        'finalist-evidence-matrix.json',
      ],
      representativeQueries: { revision: 1 },
      entrantCohort: { representativeRevision: 1 },
      finalistEvidence: { version: '1.0.0', finalistCount: 1 },
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ ...base, state: 'completed' }, null, 2)}\n`);
    await writeFile(join(directory, 'status.json'), `${JSON.stringify({ ...base, status: 'completed' }, null, 2)}\n`);
    await writeFile(join(directory, 'entrant-cohort.json'), `${JSON.stringify(parent, null, 2)}\n`);
    await writeFile(join(directory, 'finalist-evidence-matrix.csv'), 'stale\n');
    await writeFile(join(directory, 'finalist-evidence-matrix.json'), '{}\n');

    await publishCohortHistoricalPresenceMetadata({
      enrichmentDirectory: directory,
      snapshot,
      snapshotFingerprint: 'sampled-history-current',
      changed: true,
    });

    for (const filename of ['manifest.json', 'status.json']) {
      const published = JSON.parse(await readFile(join(directory, filename), 'utf8')) as {
        artifacts: string[];
        finalistEvidence?: unknown;
        historicalPresence?: { semantics?: string; snapshotFingerprint?: string };
      };
      assert.equal('finalistEvidence' in published, false);
      assert.equal(published.artifacts.includes('finalist-evidence-matrix.csv'), false);
      assert.equal(published.artifacts.includes('finalist-evidence-matrix.json'), false);
      assert.equal(
        published.historicalPresence?.semantics,
        'bounded_sampled_web_presence_not_exact_first_seen',
      );
      assert.equal(published.historicalPresence?.snapshotFingerprint, 'sampled-history-current');
    }
    assert.equal(await exists(join(directory, 'finalist-evidence-matrix.csv')), false);
    assert.equal(await exists(join(directory, 'finalist-evidence-matrix.json')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
