import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from './store.js';

test('enrichment query suggestions persist and reload', () => {
  const store = RunStore.openInMemory();
  store.createEnrichmentRun({
    enrichmentId: 'enr-q',
    sourceRunId: 'run-1',
    modules: ['query_suggestions'],
    config: '{}',
    sourceRunDirectory: 'runs/run-1',
    enrichmentDirectory: 'enrichments/enr-q',
  });
  store.saveQuerySuggestions('enr-q', [
    {
      normalizedSuggestion: 'json diff tool',
      rawText: 'json diff tool',
      volume: 5000,
      cpc: null,
      ordinal: 0,
      market: 'US',
      hl: 'en',
      gl: 'us',
      parserVersion: '1.0.0',
      collectionStatus: 'ok',
      occurrences: [
        { parentKeyword: 'json diff', normalizedParent: 'jsondiff', source: 'surfer_related', market: 'US', hl: 'en', gl: 'us', parserVersion: '1.0.0', collectionStatus: 'ok' },
      ],
    },
  ]);
  const rows = store.loadQuerySuggestions('enr-q');
  const row = rows[0]!;
  assert.equal(row.normalizedSuggestion, 'json diff tool');
  assert.equal(row.volume, 5000);
  assert.equal(row.occurrences.length, 1);
  assert.equal(row.occurrences[0]?.source, 'surfer_related');

  // re-save replaces wholesale (no duplicate rows)
  store.saveQuerySuggestions('enr-q', []);
  assert.equal(store.loadQuerySuggestions('enr-q').length, 0);
  store.close();
});
