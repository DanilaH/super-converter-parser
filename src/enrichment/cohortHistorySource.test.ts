import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../db/store.js';
import type { DomainAgeRecord } from '../runs/domainAge.js';
import { loadPersistedCohortHistoryRecords } from './cohortHistorySource.js';

function record(domain: string, omitted: boolean = false): DomainAgeRecord {
  return {
    domain,
    registrationDate: null,
    registrationStatus: omitted ? 'not_attempted' : 'not_found',
    registrationRule: '',
    registrationIsRedacted: false,
    registrationFetchedAt: null,
    registrationSource: 'rdap',
    registrationEvents: [],
    firstSeenDate: null,
    firstSeenStatus: omitted ? 'not_attempted' : 'unavailable',
    firstSeenSource: omitted ? null : 'unconfigured',
    firstSeenFetchedAt: null,
    sourceKeywords: [],
    sourceRanks: [],
    domainAgeDays: null,
    observedAt: '2026-08-29T00:00:00.000Z',
    cacheHit: false,
    cacheStatus: 'none',
    omitted,
    omitReason: omitted ? 'domain_cap' : null,
    fetchedAt: '2026-08-29T00:00:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: null,
    registrationRequestCount: 0,
    firstSeenHttpStatus: null,
    firstSeenRequestCount: 0,
    error: null,
  };
}

function saveItem(
  store: RunStore,
  domain: string,
  status: 'completed' | 'error' | 'not_attempted',
  value: DomainAgeRecord,
): void {
  store.upsertEnrichmentItem({
    enrichmentId: 'enr-1',
    itemId: domain,
    module: 'domain_age',
    status,
    source: status === 'not_attempted' ? 'config' : 'rdap',
    cacheStatus: 'none',
    error: status === 'error' ? 'history_error' : null,
    payload: JSON.stringify(value),
  });
}

test('history reader keeps completed, error and explicit omitted checkpoint payloads', () => {
  const store = RunStore.openInMemory();
  try {
    saveItem(store, 'ok.test', 'completed', record('ok.test'));
    saveItem(store, 'error.test', 'error', { ...record('error.test'), registrationStatus: 'error' });
    saveItem(store, 'omitted.test', 'not_attempted', record('omitted.test', true));
    store.upsertEnrichmentItem({
      enrichmentId: 'enr-1',
      itemId: 'running.test',
      module: 'domain_age',
      status: 'running',
      source: 'rdap',
      cacheStatus: 'none',
      error: null,
      payload: JSON.stringify(record('running.test')),
    });

    const records = loadPersistedCohortHistoryRecords(store, 'enr-1');
    assert.deepEqual(records.map((row) => row.domain), ['error.test', 'ok.test', 'omitted.test']);
    assert.equal(records.find((row) => row.domain === 'omitted.test')?.omitReason, 'domain_cap');
  } finally {
    store.close();
  }
});

test('history reader rejects payload/checkpoint identity drift', () => {
  const store = RunStore.openInMemory();
  try {
    saveItem(store, 'checkpoint.test', 'completed', record('other.test'));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(store, 'enr-1'),
      /payload identity other\.test does not match checkpoint checkpoint\.test/,
    );
  } finally {
    store.close();
  }
});
