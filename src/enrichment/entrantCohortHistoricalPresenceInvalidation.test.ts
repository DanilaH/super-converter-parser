import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEntrantCohortMetadata } from './entrantCohortPublication.js';

const SUMMARY = {
  changed: true,
  version: '1.0.0',
  representativeRevision: 2,
  serpTopN: 10,
  finalistClusterCount: 1,
  uniqueDomainCount: 1,
  observedOccurrenceCount: 1,
  excludedOccurrenceCount: 0,
  weakDomainCount: 1,
  knownDrDomainCount: 1,
  repeatedDomainCount: 0,
  survivorshipWarning: 'observed winners only',
  drThresholds: { veryWeakMax: 10, weakMax: 30, strongMin: 60, strongMax: 75 },
};

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('changed entrant publication removes stale sampled historical-presence metadata and artifacts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'entrant-historical-invalidation-'));
  try {
    const historicalArtifacts = ['cohort-historical-presence.csv', 'cohort-historical-presence.json'];
    const artifacts = [
      'keyword-clusters.csv',
      'representative-queries.csv',
      'manifest.json',
      'status.json',
      ...historicalArtifacts,
    ];
    const historicalPresence = {
      entrantFingerprint: 'stale-fingerprint',
      semantics: 'bounded_sampled_web_presence_not_exact_first_seen',
    };
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      modules: ['clusters'],
      artifacts,
      state: 'completed',
      representativeQueries: { revision: 2 },
      historicalPresence,
    }, null, 2)}\n`);
    await writeFile(join(directory, 'status.json'), `${JSON.stringify({
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      status: 'completed',
      modules: ['clusters'],
      artifacts,
      representativeQueries: { revision: 2 },
      historicalPresence,
    }, null, 2)}\n`);
    for (const artifact of historicalArtifacts) {
      await writeFile(join(directory, artifact), 'stale\n');
    }

    await publishEntrantCohortMetadata({
      enrichmentDirectory: directory,
      enrichmentId: 'enr-1',
      sourceRunId: 'source-1',
      summary: SUMMARY,
    });

    for (const filename of ['manifest.json', 'status.json']) {
      const published = JSON.parse(await readFile(join(directory, filename), 'utf8')) as {
        artifacts: string[];
        historicalPresence?: unknown;
      };
      assert.equal('historicalPresence' in published, false);
      for (const artifact of historicalArtifacts) {
        assert.equal(published.artifacts.includes(artifact), false);
      }
    }
    for (const artifact of historicalArtifacts) {
      assert.equal(await exists(join(directory, artifact)), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
