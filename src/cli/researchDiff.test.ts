import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchDiffArgs, renderResearchGenerationDiff } from './researchDiff.js';
import type { ResearchGenerationDiff } from '../research/diff.js';

test('research diff args require explicit same-kind generation refs', () => {
  assert.deepEqual(
    parseResearchDiffArgs([
      '--research', 'run-1',
      '--from', 'discovery:1',
      '--to', 'discovery:2',
      '--json',
    ]),
    {
      help: false,
      research: 'run-1',
      from: 'discovery:1',
      to: 'discovery:2',
      outputRoot: null,
      json: true,
    },
  );
  assert.throws(
    () => parseResearchDiffArgs(['--research', 'run-1', '--from', '1', '--to', '2']),
    /Use discovery:<n> or enrichment:<n>/,
  );
  assert.throws(
    () => parseResearchDiffArgs([
      '--research', 'run-1',
      '--from', 'discovery:1',
      '--to', 'enrichment:1',
    ]),
    /same generation kind/,
  );
  assert.throws(
    () => parseResearchDiffArgs([
      '--research', 'run-1',
      '--from', 'discovery:1',
      '--to', 'discovery:2',
      'extra',
    ]),
    /Unexpected positional argument/,
  );
});

test('research diff help does not require comparison arguments', () => {
  assert.deepEqual(parseResearchDiffArgs(['--help']), {
    help: true,
    research: '',
    from: '',
    to: '',
    outputRoot: null,
    json: false,
  });
});

test('text rendering remains factual and exposes persisted-cluster matching basis', () => {
  const diff: ResearchGenerationDiff = {
    version: '1.0.0',
    researchId: 'run-1',
    label: 'fixture',
    researchDirectory: '/tmp/fixture',
    kind: 'enrichment',
    discovery: null,
    enrichment: {
      from: {
        kind: 'enrichment',
        generation: 1,
        directoryName: 'enrichment',
        enrichmentId: 'enr-1',
        sourceRunId: 'run-1',
        state: 'completed',
      },
      to: {
        kind: 'enrichment',
        generation: 2,
        directoryName: 'enrichment-02',
        enrichmentId: 'enr-2',
        sourceRunId: 'run-1',
        state: 'completed',
      },
      modules: { added: ['pages'], removed: [] },
      clusters: {
        added: [],
        removed: [],
        changed: [{
          clusterId: 'cluster-1',
          canonicalKeywordFrom: 'alpha',
          canonicalKeywordTo: 'alpha',
          addedMembers: ['gamma'],
          removedMembers: ['beta'],
        }],
        matchingBasis: 'persisted_cluster_id',
      },
      representatives: [],
      entrantDomains: [],
      historyCoverage: { from: null, to: null },
      trafficEvidence: {
        from: {
          importedSnapshotCount: 0,
          policyAvailable: false,
          currentTargetSnapshotCount: null,
          staleTargetSnapshotCount: null,
          matchedSnapshotCount: null,
          mismatchedSnapshotCount: null,
        },
        to: {
          importedSnapshotCount: 0,
          policyAvailable: false,
          currentTargetSnapshotCount: null,
          staleTargetSnapshotCount: null,
          matchedSnapshotCount: null,
          mismatchedSnapshotCount: null,
        },
      },
    },
  };

  const output = renderResearchGenerationDiff(diff);
  assert.match(output, /matching basis: persisted_cluster_id/);
  assert.match(output, /cluster-1: members \+\[gamma\] -\[beta\]/);
  assert.doesNotMatch(output, /opportunity improved|stronger niche|better opportunity/i);
});
