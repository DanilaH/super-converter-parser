import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from './store.js';
import { buildMicrosoftKeywords, type MicrosoftRow } from '../input/microsoft/normalize.js';
import { storedKeywordToRecord } from './store.js';
import { loadConfig } from '../config/config.js';

const CONFIG = loadConfig({});

const ROWS: MicrosoftRow[] = [
  {
    adGroup: 'Pdf Page',
    keyword: 'add page numbers to pdf',
    volumeBucket: '100 - 1K',
    competition: '0.85',
    cpc: 0.11,
    rowNumber: 1,
  },
  {
    adGroup: 'List',
    keyword: 'compare lists',
    volumeBucket: '1K - 10K',
    competition: null,
    cpc: null,
    rowNumber: 2,
  },
];

test('a Microsoft run stores keyword provenance and source columns', () => {
  const store = RunStore.openInMemory();
  const keywords = buildMicrosoftKeywords(ROWS);

  store.createRun({
    runId: 'run-ms-1',
    configSnapshot: CONFIG,
    parserVersions: { surfer: '1.0.0', google: '1.0.0' },
    input: { kind: 'microsoft', path: 'input/microsoft.csv' },
    keywords,
  });

  const stored = store.loadKeywords('run-ms-1');
  assert.equal(stored.length, 2);

  const addPages = stored.find((item) => item.normalizedKeyword === 'add page numbers to pdf')!;
  assert.equal(addPages.sources.length, 1);
  assert.equal(addPages.sources[0]!.type, 'microsoft');
  assert.equal(addPages.sources[0]!.type === 'microsoft' && addPages.sources[0]!.sourceRow, 1);
  assert.equal(
    addPages.sources[0]!.type === 'microsoft' && addPages.sources[0]!.adGroup,
    'Pdf Page',
  );
  assert.equal(
    addPages.sources[0]!.type === 'microsoft' && addPages.sources[0]!.microsoft?.volumeBucket,
    '100 - 1K',
  );

  const record = storedKeywordToRecord(addPages);
  assert.equal(record.microsoft?.volumeBucket, '100 - 1K');
  assert.equal(record.microsoft?.volumeRaw, 1000);
  assert.equal(record.microsoft?.competition, '0.85');
  assert.equal(record.microsoft?.cpc, 0.11);
  assert.equal(record.microsoft?.volumeBucket, '100 - 1K');

  const compare = stored.find((item) => item.normalizedKeyword === 'compare lists')!;
  const compareRecord = storedKeywordToRecord(compare);
  assert.equal(compareRecord.microsoft?.volumeBucket, '1K - 10K');
  assert.equal(compareRecord.microsoft?.competition, null);
  assert.equal(compareRecord.microsoft?.cpc, null);

  const run = store.loadRun('run-ms-1');
  assert.equal(run?.input.kind, 'microsoft');
  assert.equal(run?.input.path, 'input/microsoft.csv');
});
