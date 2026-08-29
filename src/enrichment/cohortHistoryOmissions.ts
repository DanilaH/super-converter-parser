import type { RunStore } from '../db/store.js';
import { normalizeKeyword } from '../input/seeds/normalize.js';
import { selectDomainsFairly, type DomainObservation } from './domainSelection.js';

export const DOMAIN_AGE_SELECTION_MAX_DOMAINS_V1 = 30;

export function reconstructDomainAgeCapOmissions(input: {
  sourceStore: RunStore;
  sourceRunId: string;
  shortlist: string[];
}): Map<string, 'domain_cap'> {
  const shortlistOrder = uniqueNormalized(input.shortlist);
  if (shortlistOrder.length === 0) return new Map();
  const shortlistSet = new Set(shortlistOrder);
  const keywordByIdx = new Map(
    input.sourceStore.loadKeywords(input.sourceRunId)
      .map((keyword) => [keyword.idx, normalizeKeyword(keyword.normalizedKeyword ?? keyword.keyword)] as const),
  );

  const observations: DomainObservation[] = [];
  for (const row of input.sourceStore.loadSerpRows(input.sourceRunId)) {
    if (row.resultType !== 'organic') continue;
    const keyword = keywordByIdx.get(row.keywordIdx ?? -1);
    if (keyword === undefined || !shortlistSet.has(keyword)) continue;
    if (!row.registrableDomain) continue;
    observations.push({
      keyword,
      domain: row.registrableDomain,
      position: row.position,
    });
  }

  const selection = selectDomainsFairly(
    shortlistOrder,
    observations,
    DOMAIN_AGE_SELECTION_MAX_DOMAINS_V1,
  );
  return new Map(selection.omitted.map((domain) => [domain, 'domain_cap'] as const));
}

function uniqueNormalized(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeKeyword(value);
    if (normalized === '' || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
