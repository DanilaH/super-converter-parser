import type { RunStore } from '../db/store.js';
import type { DomainAgeRecord } from '../runs/domainAge.js';

const DAY_MS = 86_400_000;
const REGISTRATION_STATUSES = new Set<DomainAgeRecord['registrationStatus']>([
  'ok',
  'not_found',
  'unsupported',
  'error',
  'not_attempted',
]);
const FIRST_SEEN_STATUSES = new Set<DomainAgeRecord['firstSeenStatus']>([
  'ok',
  'not_found',
  'unavailable',
  'not_attempted',
  'error',
]);

export function loadPersistedCohortHistoryRecords(
  store: RunStore,
  enrichmentId: string,
): DomainAgeRecord[] {
  const rows = store.loadEnrichmentItems(enrichmentId)
    .filter((item) => item.module === 'domain_age' && item.payload !== null)
    .filter((item) => item.status === 'completed' || item.status === 'error' || item.status === 'not_attempted');

  const records: DomainAgeRecord[] = [];
  const seen = new Set<string>();
  for (const item of rows) {
    let record: DomainAgeRecord;
    try {
      record = JSON.parse(item.payload as string) as DomainAgeRecord;
    } catch (error) {
      throw new Error(
        `Cannot parse persisted domain-history payload for ${item.itemId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    validateRecord(record, item.itemId);
    if (seen.has(record.domain)) {
      throw new Error(`Duplicate persisted domain-history record for ${record.domain}`);
    }
    seen.add(record.domain);
    records.push(record);
  }
  return records.sort((a, b) => a.domain.localeCompare(b.domain));
}

function validateRecord(record: DomainAgeRecord, itemId: string): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`Persisted domain-history payload for ${itemId} is not an object`);
  }
  if (typeof record.domain !== 'string' || record.domain.trim() === '') {
    throw new Error(`Persisted domain-history payload for ${itemId} has no domain identity`);
  }
  if (record.domain !== itemId) {
    throw new Error(
      `Persisted domain-history payload identity ${record.domain} does not match checkpoint ${itemId}`,
    );
  }
  if (typeof record.omitted !== 'boolean') {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid omission state`);
  }
  if (!REGISTRATION_STATUSES.has(record.registrationStatus)) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid registration status`);
  }
  if (!FIRST_SEEN_STATUSES.has(record.firstSeenStatus)) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid first-seen status`);
  }
  if (!isNullableDate(record.registrationDate)) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid registration date`);
  }
  if (!isNullableDate(record.firstSeenDate)) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid first-seen date`);
  }
  if (typeof record.observedAt !== 'string' || !Number.isFinite(Date.parse(record.observedAt))) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid observedAt`);
  }
  if (
    record.domainAgeDays !== null
    && (!Number.isFinite(record.domainAgeDays) || record.domainAgeDays < 0)
  ) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid domain age`);
  }
  if (record.registrationStatus === 'ok') {
    if (record.registrationDate === null || record.domainAgeDays === null) {
      throw new Error(`Persisted domain-history payload for ${itemId} has registration status ok without complete date/age evidence`);
    }
    const expectedAgeDays = Math.floor(
      (Date.parse(record.observedAt) - Date.parse(record.registrationDate)) / DAY_MS,
    );
    if (expectedAgeDays < 0 || record.domainAgeDays !== expectedAgeDays) {
      throw new Error(`Persisted domain-history payload for ${itemId} has registration date/age mismatch`);
    }
  }
  if (record.firstSeenStatus === 'ok' && record.firstSeenDate === null) {
    throw new Error(`Persisted domain-history payload for ${itemId} has first-seen status ok without a date`);
  }
  if (record.omitted && (typeof record.omitReason !== 'string' || record.omitReason === '')) {
    throw new Error(`Persisted domain-history payload for ${itemId} has invalid omission reason`);
  }
}

function isNullableDate(value: unknown): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
