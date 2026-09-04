import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDomainSelectionEvidence,
  selectDomainsEntrantAware,
  selectDomainsFairly,
  type DomainObservation,
} from './domainSelection.js';

test('domain cap gives each keyword a turn before taking deeper results', () => {
  const keywords = ['first', 'second', 'third'];
  const observations: DomainObservation[] = keywords.flatMap((keyword) =>
    Array.from({ length: 5 }, (_, index) => ({
      keyword,
      domain: `${keyword}-${index + 1}.test`,
      position: index + 1,
    })),
  );

  const result = selectDomainsFairly(keywords, observations, 6);
  assert.deepEqual(result.selected, [
    'first-1.test', 'second-1.test', 'third-1.test',
    'first-2.test', 'second-2.test', 'third-2.test',
  ]);
});

test('shared domains consume one slot without starving later keywords', () => {
  const result = selectDomainsFairly(
    ['first', 'second', 'third'],
    [
      { keyword: 'first', domain: 'shared.test', position: 1 },
      { keyword: 'first', domain: 'first.test', position: 2 },
      { keyword: 'second', domain: 'shared.test', position: 1 },
      { keyword: 'second', domain: 'second.test', position: 2 },
      { keyword: 'third', domain: 'third.test', position: 1 },
    ],
    3,
  );

  assert.deepEqual(result.selected, ['shared.test', 'second.test', 'third.test']);
  assert.deepEqual(result.omitted, ['first.test']);
});

test('no cap loss when the limit exceeds the unique domain count', () => {
  const observations = [
    { keyword: 'a', domain: 'a.test', position: 1 },
    { keyword: 'b', domain: 'b.test', position: 1 },
  ];
  assert.deepEqual(selectDomainsFairly(['a', 'b'], observations, 30), {
    selected: ['a.test', 'b.test'],
    omitted: [],
  });
});

test('entrant-aware selection keeps keyword fairness while preferring weak recurring domains', () => {
  const result = selectDomainsEntrantAware(
    ['first', 'second', 'third'],
    [
      { keyword: 'first', domain: 'authority.test', position: 1, dr: 80, pageIdentity: '/a' },
      { keyword: 'first', domain: 'entrant.test', position: 4, dr: 4, pageIdentity: '/first' },
      { keyword: 'second', domain: 'authority.test', position: 1, dr: 80, pageIdentity: '/b' },
      { keyword: 'second', domain: 'entrant.test', position: 5, dr: 4, pageIdentity: '/second' },
      { keyword: 'third', domain: 'third-authority.test', position: 1, dr: 70, pageIdentity: '/third' },
      { keyword: 'third', domain: 'third-weak.test', position: 6, dr: 20, pageIdentity: '/third-weak' },
    ],
    3,
    30,
  );

  assert.deepEqual(result.selected, ['entrant.test', 'third-weak.test', 'authority.test']);
  assert.equal(result.policyVersion, 'entrant-v1');
  assert.equal(result.evidence.find((row) => row.domain === 'entrant.test')?.keywordCount, 2);
  assert.equal(result.evidence.find((row) => row.domain === 'entrant.test')?.distinctPageCount, 2);
});

test('missing or conflicting DR is not silently classified as weak', () => {
  const evidence = buildDomainSelectionEvidence(
    [
      { keyword: 'a', domain: 'missing.test', position: 1, dr: null },
      { keyword: 'a', domain: 'conflict.test', position: 2, dr: 5 },
      { keyword: 'b', domain: 'conflict.test', position: 3, dr: 15 },
      { keyword: 'a', domain: 'weak.test', position: 4, dr: 10 },
    ],
    30,
  );

  assert.deepEqual(
    evidence.map((row) => [row.domain, row.drStatus, row.dr, row.isWeak]),
    [
      ['conflict.test', 'conflict', null, null],
      ['missing.test', 'missing', null, null],
      ['weak.test', 'known', 10, true],
    ],
  );
});
