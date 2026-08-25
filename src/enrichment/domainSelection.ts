export type DomainObservation = {
  keyword: string;
  domain: string;
  position: number;
};

export type FairDomainSelection = {
  selected: string[];
  omitted: string[];
};

/**
 * Selects unique domains in rank-by-rank, keyword-by-keyword order. A shared
 * domain consumes one slot only, while every keyword gets a turn before a
 * keyword can contribute its next-ranked domain.
 */
export function selectDomainsFairly(
  keywordOrder: readonly string[],
  observations: readonly DomainObservation[],
  maxDomains: number,
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
    rows.sort((a, b) => a.position - b.position || a.order - b.order || a.domain.localeCompare(b.domain));
  }

  const selected: string[] = [];
  const selectedSet = new Set<string>();
  const cursors = new Map(keywordOrder.map((keyword) => [keyword, 0]));

  while (selected.length < maxDomains) {
    let advanced = false;
    for (const keyword of keywordOrder) {
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
