import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinalistDecisionsJson } from './finalistDecisionConfig.js';

test('parses explicit human decisions and preserves explicit unknown', () => {
  assert.deepEqual(parseFinalistDecisionsJson(JSON.stringify([
    {
      clusterId: ' cluster-2 ',
      buildDecision: 'unknown',
      seoProductRole: 'experimental',
    },
    {
      clusterId: 'cluster-10',
      buildDecision: 'build',
      seoProductRole: 'acquisition_anchor',
    },
  ])), [
    {
      clusterId: 'cluster-2',
      buildDecision: 'unknown',
      seoProductRole: 'experimental',
    },
    {
      clusterId: 'cluster-10',
      buildDecision: 'build',
      seoProductRole: 'acquisition_anchor',
    },
  ]);
});

test('treats omitted decision fields as unrecorded nulls and accepts [] as clear-all snapshot', () => {
  assert.deepEqual(parseFinalistDecisionsJson('[{"clusterId":"cluster-1"}]'), [
    { clusterId: 'cluster-1', buildDecision: null, seoProductRole: null },
  ]);
  assert.deepEqual(parseFinalistDecisionsJson('[]'), []);
});

test('rejects unknown fields, invalid enums, and duplicate clusters', () => {
  assert.throws(
    () => parseFinalistDecisionsJson('[{"clusterId":"cluster-1","score":9}]'),
    /unknown field/,
  );
  assert.throws(
    () => parseFinalistDecisionsJson('[{"clusterId":"cluster-1","buildDecision":"maybe"}]'),
    /buildDecision/,
  );
  assert.throws(
    () => parseFinalistDecisionsJson('[{"clusterId":"cluster-1"},{"clusterId":"cluster-1"}]'),
    /duplicate cluster/,
  );
});
