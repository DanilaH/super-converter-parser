import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExpansionAdmission,
  expansionAddedBudget,
  type ExpansionRelatedOccurrence,
} from './expansionAdmission.js';

function related(
  parentIdx: number,
  parentKeyword: string,
  relatedKeyword: string,
  overlap: number | null = 50,
  volume: number | null = 1000,
): ExpansionRelatedOccurrence {
  return { parentIdx, parentKeyword, relatedKeyword, overlap, volume, status: 'ok' };
}

function build(
  originalKeywords: string[],
  rows: ExpansionRelatedOccurrence[],
  overrides: Partial<{ maxCandidatesPerKeyword: number; minOverlap: number; minVolume: number }> = {},
) {
  return buildExpansionAdmission({
    originalKeywords,
    related: rows,
    maxCandidatesPerKeyword: overrides.maxCandidatesPerKeyword ?? 20,
    minOverlap: overrides.minOverlap ?? 0,
    minVolume: overrides.minVolume ?? 0,
  });
}

test('global budget is bounded and scales proportionally with original keyword count', () => {
  assert.equal(expansionAddedBudget(0), 0);
  assert.equal(expansionAddedBudget(1), 2);
  assert.equal(expansionAddedBudget(10), 13);
  assert.equal(expansionAddedBudget(280), 350);
  assert.equal(expansionAddedBudget(400), 500);
  assert.equal(expansionAddedBudget(1000), 500);
});

test('single-token related heads are rejected even with strong support and volume', () => {
  const result = build(
    ['compare google sheets', 'merge spreadsheet columns', 'sheet diff tool'],
    [
      related(0, 'compare google sheets', 'sheets', 100, 1_000_000),
      related(1, 'merge spreadsheet columns', 'sheets', 100, 1_000_000),
      related(2, 'sheet diff tool', 'sheets', 100, 1_000_000),
      related(0, 'compare google sheets', 'compare sheet columns', 50, 5_000),
      related(1, 'merge spreadsheet columns', 'compare sheet columns', 60, 5_000),
    ],
  );

  const sheets = result.decisions.find((item) => item.normalizedKeyword === 'sheets');
  const specific = result.decisions.find((item) => item.normalizedKeyword === 'compare sheet columns');
  assert.equal(sheets?.selected, false);
  assert.equal(sheets?.reason, 'single_token');
  assert.equal(sheets?.parentSupport, 3);
  assert.deepEqual(sheets?.supportingParents, ['compare google sheets', 'merge spreadsheet columns', 'sheet diff tool']);
  assert.equal(specific?.selected, true);
  assert.equal(specific?.parentSupport, 2);
});

test('single-token technical heads are also rejected while specific utility intents survive', () => {
  const result = build(
    ['cron expression generator'],
    [
      related(0, 'cron expression generator', 'cron', 100, 100_000),
      related(0, 'cron expression generator', 'cron expression', 90, 20_000),
    ],
  );
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'cron')?.reason, 'single_token');
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'cron expression')?.selected, true);
});

test('existing keywords are never re-admitted from related evidence', () => {
  const result = build(
    ['json formatter'],
    [related(0, 'json formatter', 'JSON Formatter', 100, 100_000)],
  );
  assert.equal(result.selectedCount, 0);
  assert.equal(result.decisions[0]?.reason, 'existing_keyword');
});

test('minimum overlap and volume remain admission gates', () => {
  const result = build(
    ['json formatter'],
    [
      related(0, 'json formatter', 'weak overlap tool', 10, 10_000),
      related(0, 'json formatter', 'low volume tool', 80, 10),
      related(0, 'json formatter', 'strong json tool', 80, 10_000),
    ],
    { minOverlap: 50, minVolume: 100 },
  );
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'weak overlap tool')?.reason, 'below_min_signal');
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'low volume tool')?.reason, 'below_min_signal');
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'strong json tool')?.selected, true);
});

test('per-parent cap is deterministic and prefers stronger observed signal', () => {
  const result = build(
    ['json formatter'],
    [
      related(0, 'json formatter', 'low signal candidate', 10, 10_000),
      related(0, 'json formatter', 'high signal candidate', 90, 100),
    ],
    { maxCandidatesPerKeyword: 1 },
  );
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'high signal candidate')?.selected, true);
  assert.equal(result.decisions.find((item) => item.normalizedKeyword === 'low signal candidate')?.reason, 'parent_cap');
});

test('parent support is bucketed so many near-duplicate parents do not create unbounded priority', () => {
  const result = build(
    ['seed a', 'seed b', 'seed c', 'seed d'],
    [
      related(0, 'seed a', 'supported utility', 50, 100),
      related(1, 'seed b', 'supported utility', 50, 100),
      related(2, 'seed c', 'supported utility', 50, 100),
      related(3, 'seed d', 'supported utility', 50, 100),
      related(0, 'seed a', 'single parent utility', 100, 1_000_000),
    ],
  );
  const supported = result.decisions.find((item) => item.normalizedKeyword === 'supported utility');
  assert.equal(supported?.parentSupport, 4);
  assert.equal(supported?.parentSupportTier, 2);
});

test('strict lexical broadening is deprioritized instead of hard-rejected', () => {
  const originals = Array.from({ length: 20 }, (_, index) => `specific source query ${index}`);
  const rows: ExpansionRelatedOccurrence[] = [];
  for (let index = 0; index < 30; index += 1) {
    const parentIndex = index % originals.length;
    rows.push(related(parentIndex, originals[parentIndex]!, `specific utility candidate ${index}`, 50, 1000));
  }
  rows.push(related(0, 'specific source query 0', 'source query', 100, 1_000_000));

  const result = build(originals, rows);
  const broad = result.decisions.find((item) => item.normalizedKeyword === 'source query');
  assert.equal(broad?.broadeningOnly, true);
  assert.equal(broad?.selected, false);
  assert.equal(broad?.reason, 'global_budget');
});

test('directional queries are kept distinct; admission never token-sorts keyword identity', () => {
  const result = build(
    ['image converter'],
    [
      related(0, 'image converter', 'jpg to pdf', 100, 100_000),
      related(0, 'image converter', 'pdf to jpg', 100, 100_000),
    ],
  );
  const selected = result.decisions.filter((item) => item.selected).map((item) => item.normalizedKeyword).sort();
  assert.deepEqual(selected, ['jpg to pdf', 'pdf to jpg']);
});

test('global budget deterministically cuts the lower-priority frontier', () => {
  const originals = Array.from({ length: 20 }, (_, index) => `seed keyword ${index}`);
  const rows = Array.from({ length: 30 }, (_, index) =>
    related(index % originals.length, originals[index % originals.length]!, `candidate utility ${index}`, 100 - index, 1000 - index),
  );
  const first = build(originals, rows);
  const second = build(originals, [...rows].reverse());
  assert.equal(first.budget, 25);
  assert.equal(first.selectedCount, 25);
  assert.deepEqual(
    first.decisions.filter((item) => item.selected).map((item) => item.normalizedKeyword),
    second.decisions.filter((item) => item.selected).map((item) => item.normalizedKeyword),
  );
  assert.equal(first.decisions.filter((item) => item.reason === 'global_budget').length, 5);
});
