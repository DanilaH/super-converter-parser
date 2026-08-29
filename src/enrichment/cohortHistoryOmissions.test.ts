import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config/config.js';
import { RunStore } from '../db/store.js';
import { buildSeedKeywords } from '../input/seeds/normalize.js';
import { reconstructDomainAgeCapOmissions } from './cohortHistoryOmissions.js';

function serpRows(keyword: string, domains: string[]) {
  return domains.map((domain, index) => ({
    keyword,
    position: index + 1,
    title: `${domain} result`,
    url: `https://${domain}/tool`,
    hostname: domain,
    registrableDomain: domain,
    dr: null,
    drStatus: null,
    drError: null,
    resultType: 'organic' as const,
  }));
}

test('domain-age cap omissions are reconstructed from persisted shortlist/source SERPs', () => {
  const store = RunStore.openInMemory();
  try {
    const keywords = buildSeedKeywords([
      { keyword: 'alpha test', rowNumber: 1 },
      { keyword: 'beta test', rowNumber: 2 },
      { keyword: 'gamma test', rowNumber: 3 },
      { keyword: 'delta test', rowNumber: 4 },
      { keyword: 'epsilon test', rowNumber: 5 },
    ]);
    store.createRun({
      runId: 'source-1',
      configSnapshot: loadConfig({}),
      parserVersions: { surfer: '1.0.0', google: '1.0.0' },
      input: { kind: 'seeds', path: 'input/test.csv' },
      keywords,
    });

    for (let keywordIdx = 0; keywordIdx < keywords.length; keywordIdx += 1) {
      const count = keywordIdx === 0 ? 7 : 6;
      const domains = Array.from({ length: count }, (_, index) =>
        `k${keywordIdx}-${index + 1}.test`);
      store.replaceSerpRows(
        'source-1',
        keywordIdx,
        serpRows(keywords[keywordIdx]!.keyword, domains),
      );
    }

    const omitted = reconstructDomainAgeCapOmissions({
      sourceStore: store,
      sourceRunId: 'source-1',
      shortlist: [' Alpha   Test ', 'beta test', 'gamma test', 'delta test', 'epsilon test'],
    });

    assert.equal(omitted.size, 1);
    assert.deepEqual([...omitted.values()], ['domain_cap']);
    assert.equal([...omitted.keys()][0]?.endsWith('.test'), true);
  } finally {
    store.close();
  }
});

test('no shortlist means no reconstructed omission claim', () => {
  const store = RunStore.openInMemory();
  try {
    assert.equal(reconstructDomainAgeCapOmissions({
      sourceStore: store,
      sourceRunId: 'missing-source',
      shortlist: [],
    }).size, 0);
  } finally {
    store.close();
  }
});
