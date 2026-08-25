import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDomainsFairly, type DomainObservation } from './domainSelection.js';

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
