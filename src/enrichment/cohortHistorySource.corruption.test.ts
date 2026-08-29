import test from 'node:test';
import assert from 'node:assert/strict';
import { RunStore } from '../db/store.js';
import { loadPersistedCohortHistoryRecords } from './cohortHistorySource.js';

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    domain: 'broken.test',
    registrationDate: null,
    registrationStatus: 'not_found',
    registrationRule: '',
    registrationIsRedacted: false,
    registrationFetchedAt: null,
    registrationSource: 'rdap',
    registrationEvents: [],
    firstSeenDate: null,
    firstSeenStatus: 'unavailable',
    firstSeenSource: 'unconfigured',
    firstSeenFetchedAt: null,
    sourceKeywords: [],
    sourceRanks: [],
    domainAgeDays: null,
    observedAt: '2026-08-29T00:00:00.000Z',
    cacheHit: false,
    cacheStatus: 'none',
    omitted: false,
    omitReason: null,
    fetchedAt: '2026-08-29T00:00:00.000Z',
    registrationError: null,
    firstSeenError: null,
    firstSeenSourceReason: null,
    registrationHttpStatus: null,
    registrationRequestCount: 0,
    firstSeenHttpStatus: null,
    firstSeenRequestCount: 0,
    error: null,
    ...overrides,
  });
}

function save(store: RunStore, value: string): void {
  store.upsertEnrichmentItem({
    enrichmentId: 'enr-1',
    itemId: 'broken.test',
    module: 'domain_age',
    status: 'completed',
    source: 'rdap',
    cacheStatus: 'none',
    payload: value,
  });
}

test('history reader rejects unknown registration status', () => {
  const store = RunStore.openInMemory();
  try {
    save(store, payload({ registrationStatus: 'mystery' }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(store, 'enr-1'),
      /invalid registration status/,
    );
  } finally {
    store.close();
  }
});

test('history reader rejects malformed provider dates and observedAt', () => {
  const store = RunStore.openInMemory();
  try {
    save(store, payload({ firstSeenDate: 'not-a-date' }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(store, 'enr-1'),
      /invalid first-seen date/,
    );
  } finally {
    store.close();
  }

  const second = RunStore.openInMemory();
  try {
    save(second, payload({ observedAt: 'not-a-date' }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(second, 'enr-1'),
      /invalid observedAt/,
    );
  } finally {
    second.close();
  }
});

test('history reader rejects ok provider states without complete date evidence', () => {
  const registration = RunStore.openInMemory();
  try {
    save(registration, payload({ registrationStatus: 'ok', domainAgeDays: 89 }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(registration, 'enr-1'),
      /registration status ok without complete date\/age evidence/,
    );
  } finally {
    registration.close();
  }

  const firstSeen = RunStore.openInMemory();
  try {
    save(firstSeen, payload({ firstSeenStatus: 'ok' }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(firstSeen, 'enr-1'),
      /first-seen status ok without a date/,
    );
  } finally {
    firstSeen.close();
  }
});

test('history reader rejects registration age that disagrees with persisted dates', () => {
  const store = RunStore.openInMemory();
  try {
    save(store, payload({
      registrationStatus: 'ok',
      registrationDate: '2026-08-19T00:00:00.000Z',
      domainAgeDays: 9,
    }));
    assert.throws(
      () => loadPersistedCohortHistoryRecords(store, 'enr-1'),
      /registration date\/age mismatch/,
    );
  } finally {
    store.close();
  }
});
