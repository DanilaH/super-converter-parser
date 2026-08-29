import test from 'node:test';
import assert from 'node:assert/strict';
import { TRAFFIC_EVIDENCE_VERSION } from './trafficEvidence.js';
import { resolveTrafficEvidencePolicy } from './trafficEvidenceConfig.js';

test('first traffic policy requires an explicit low-base threshold', () => {
  assert.throws(
    () => resolveTrafficEvidencePolicy({ previous: null }),
    /requires explicit --low-base-organic-traffic-threshold/,
  );
});

test('persisted traffic policy is reused when the threshold is omitted', () => {
  assert.deepEqual(
    resolveTrafficEvidencePolicy({
      previous: {
        version: TRAFFIC_EVIDENCE_VERSION,
        lowBaseOrganicTrafficThreshold: 100,
      },
    }),
    {
      version: TRAFFIC_EVIDENCE_VERSION,
      lowBaseOrganicTrafficThreshold: 100,
    },
  );
});

test('explicit threshold replaces the persisted value without hidden defaults', () => {
  assert.deepEqual(
    resolveTrafficEvidencePolicy({
      previous: {
        version: TRAFFIC_EVIDENCE_VERSION,
        lowBaseOrganicTrafficThreshold: 100,
      },
      lowBaseOrganicTrafficThreshold: 250,
    }),
    {
      version: TRAFFIC_EVIDENCE_VERSION,
      lowBaseOrganicTrafficThreshold: 250,
    },
  );
});

test('traffic policy rejects negative or non-finite thresholds', () => {
  assert.throws(
    () => resolveTrafficEvidencePolicy({ previous: null, lowBaseOrganicTrafficThreshold: -1 }),
    /non-negative finite number/,
  );
  assert.throws(
    () => resolveTrafficEvidencePolicy({ previous: null, lowBaseOrganicTrafficThreshold: Number.NaN }),
    /non-negative finite number/,
  );
});
