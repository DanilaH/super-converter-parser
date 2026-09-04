export const DOMAIN_SELECTION_POLICY_V1 = 'entrant-v1' as const;

export type DomainObservation = {
  keyword: string;
  domain: string;
  position: number;
  dr?: number | null;
  pageIdentity?: string | null;
};

export type DomainSelectionEvidence = {
  domain: string;
  keywordCount: number;
  occurrenceCount: number;
  distinctPageCount: number;
  bestRank: number;
  drStatus: 'known' | 'missing' | 'conflict';
  dr: number | null;
  isWeak: boolean | null;
};

export type FairDomainSelection = {
  selected: string[];
  omitted: string[];
};

export type EntrantAwareDomainSelection = FairDomainSelection & {
  policyVersion: typeof DOMAIN_SELECTION_POLICY_V1;
  evidence: DomainSelectionEvidence[];
};

/**
 * Historical rank-first selection. Keep this path stable so an unfinished
 * enrichment created before entrant-v1 can resume without changing its target
 * population mid-run.
 */
export function selectDomainsFairly(
  keywordOrder: readonly string[],
  observations: readonly DomainObservation[],
  maxDomains: number,
): FairDomainSelection {
  return selectDomainsByKeywordRounds(keywordOrder, observations, maxDomains, null);
}

/**
 * Entrant-aware V1 keeps the existing keyword-by-keyword fairness boundary but
 * changes candidate order inside each keyword. Known weak domains are preferred,
 * then domains observed across more selected queries and more distinct ranking
 * pages, then better rank. The selector never increases the domain cap and never
 * treats missing/conflicting DR as weak evidence.
 */
export function selectDomainsEntrantAware(
  keywordOrder: readonly string[],
  observations: readonly DomainObservation[],
  maxDomains: number,
  weakDrMax: number,
): EntrantAwareDomainSelection {
  if (!Number.isFinite(weakDrMax) || weakDrMax < 0) {
    throw new RangeError(`weakDrMax must be a non-negative finite number, got ${weakDrMax}`);
  }
  const evidence = buildDomainSelectionEvidence(observations, weakDrMax);
  const evidenceByDomain = new Map(evidence.map((row) => [row.domain, row]));
  const selection = selectDomainsByKeywordRounds(keywordOrder, observations, maxDomains, evidenceByDomain);
  return {
    ...selection,
    policyVersion: DOMAIN_SELECTION_POLICY_V1,
    evidence,
  };
}

export function buildDomainSelectionEvidence(
  observations: readonly DomainObservation[],
  weakDrMax: number,
): DomainSelectionEvidence[] {
  if (!Number.isFinite(weakDrMax) || weakDrMax < 0) {
    throw new RangeError(`weakDrMax must be a non-negative finite number, got ${weakDrMax}`);
  }

  const byDomain = new Map<string, {
    keywords: Set<string>;
    pages: Set<string>;
    drValues: Set<number>;
    occurrenceCount: number;
    bestRank: number;
  }>();

  for (const observation of observations) {
    if (!observation.domain) continue;
    const current = byDomain.get(observation.domain) ?? {
      keywords: new Set<string>(),
      pages: new Set<string>(),
      drValues: new Set<number>(),
      occurrenceCount: 0,
      bestRank: Number.POSITIVE_INFINITY,
    };
    current.keywords.add(observation.keyword);
    if (observation.pageIdentity) current.pages.add(observation.pageIdentity);
    if (observation.dr !== null && observation.dr !== undefined && Number.isFinite(observation.dr)) {
      current.drValues.add(observation.dr);
    }
    current.occurrenceCount += 1;
    current.bestRank = Math.min(current.bestRank, observation.position);
    byDomain.set(observation.domain, current);
  }

  return [...byDomain.entries()]
    .map(([domain, value]): DomainSelectionEvidence => {
      const drValues = [...value.drValues].sort((a, b) => a - b);
      const drStatus: DomainSelectionEvidence['drStatus'] = drValues.length === 0
        ? 'missing'
        : drValues.length === 1
          ? 'known'
          : 'conflict';
      const dr = drStatus === 'known' ? drValues[0]! : null;
      return {
        domain,
        keywordCount: value.keywords.size,
        occurrenceCount: value.occurrenceCount,
        distinctPageCount: value.pages.size,
        bestRank: Number.isFinite(value.bestRank) ? value.bestRank : Number.MAX_SAFE_INTEGER,
        drStatus,
        dr,
        isWeak: drStatus === 'known' && dr !== null ? dr < weakDrMax : null,
      };
    })
    .sort((a, b) => a.domain.localeCompare(b.domain));
}

function selectDomainsByKeywordRounds(
  keywordOrder: readonly string[],
  observations: readonly DomainObservation[],
  maxDomains: number,
  evidenceByDomain: ReadonlyMap<string, DomainSelectionEvidence> | null,
): FairDomainSelection {
  if (!Number.isInteger(maxDomains) || maxDomains < 0) {
    throw new RangeError(`maxDomains must be a non-negative integer, got ${maxDomains}`);
  }

  const keywordDomains = new Map<string, Array<{ domain: string; position: number; order: number }>>();
  const allDomains: string[] = [];
  const allSeen = new Set<string>();

  observations.forEach((observation, order) => {
    if (!observation.domain) return;
    if (!allSeen.has(observation.domain)) {
      allSeen.add(observation.domain);
      allDomains.push(observation.domain);
    }
    const rows = keywordDomains.get(observation.keyword) ?? [];
    const existing = rows.find((row) => row.domain === observation.domain);
    if (existing) {
      existing.position = Math.min(existing.position, observation.position);
    } else {
      rows.push({ domain: observation.domain, position: observation.position, order });
      keywordDomains.set(observation.keyword, rows);
    }
  });

  for (const rows of keywordDomains.values()) {
    rows.sort((a, b) => compareKeywordCandidates(a, b, evidenceByDomain));
  }

  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const fairKeywordOrder = spreadAcrossKeywordOrder(keywordOrder, maxDomains);
  const cursors = new Map(fairKeywordOrder.map((keyword) => [keyword, 0]));

  while (selected.length < maxDomains) {
    let advanced = false;
    for (const keyword of fairKeywordOrder) {
      const rows = keywordDomains.get(keyword) ?? [];
      let cursor = cursors.get(keyword) ?? 0;
      while (cursor < rows.length && selectedSet.has(rows[cursor]!.domain)) cursor += 1;
      cursors.set(keyword, cursor + 1);
      const candidate = rows[cursor];
      if (!candidate) continue;
      selectedSet.add(candidate.domain);
      selected.push(candidate.domain);
      advanced = true;
      if (selected.length >= maxDomains) break;
    }
    if (!advanced) break;
  }

  return {
    selected,
    omitted: allDomains.filter((domain) => !selectedSet.has(domain)),
  };
}

function compareKeywordCandidates(
  a: { domain: string; position: number; order: number },
  b: { domain: string; position: number; order: number },
  evidenceByDomain: ReadonlyMap<string, DomainSelectionEvidence> | null,
): number {
  if (evidenceByDomain !== null) {
    const aEvidence = evidenceByDomain.get(a.domain);
    const bEvidence = evidenceByDomain.get(b.domain);
    if (aEvidence && bEvidence) {
      const weak = Number(bEvidence.isWeak === true) - Number(aEvidence.isWeak === true);
      if (weak !== 0) return weak;
      if (bEvidence.keywordCount !== aEvidence.keywordCount) {
        return bEvidence.keywordCount - aEvidence.keywordCount;
      }
      if (bEvidence.distinctPageCount !== aEvidence.distinctPageCount) {
        return bEvidence.distinctPageCount - aEvidence.distinctPageCount;
      }
    }
  }

  const rank = a.position - b.position;
  if (rank !== 0) return rank;

  if (evidenceByDomain !== null) {
    const aEvidence = evidenceByDomain.get(a.domain);
    const bEvidence = evidenceByDomain.get(b.domain);
    if (aEvidence && bEvidence) {
      const aDr = aEvidence.drStatus === 'known' && aEvidence.dr !== null ? aEvidence.dr : Number.POSITIVE_INFINITY;
      const bDr = bEvidence.drStatus === 'known' && bEvidence.dr !== null ? bEvidence.dr : Number.POSITIVE_INFINITY;
      if (aDr !== bDr) return aDr - bDr;
      if (bEvidence.occurrenceCount !== aEvidence.occurrenceCount) {
        return bEvidence.occurrenceCount - aEvidence.occurrenceCount;
      }
    }
  }

  return a.order - b.order || a.domain.localeCompare(b.domain);
}

function spreadAcrossKeywordOrder(keywordOrder: readonly string[], maxDomains: number): string[] {
  if (maxDomains === 0 || keywordOrder.length <= maxDomains) return [...keywordOrder];

  const sampledIndices = new Set<number>();
  for (let slot = 0; slot < maxDomains; slot += 1) {
    sampledIndices.add(Math.floor((slot * keywordOrder.length) / maxDomains));
  }

  return [
    ...[...sampledIndices].map((index) => keywordOrder[index]!),
    ...keywordOrder.filter((_, index) => !sampledIndices.has(index)),
  ];
}
