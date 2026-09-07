import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateOperatorContinuation } from './contracts.js';

const EXAMPLES = [
  ['continuation.shortlist.json', 'shortlist'],
  ['continuation.finalists.json', 'finalists'],
  ['continuation.finalists-all.json', 'finalists_all'],
  ['continuation.decisions.json', 'decisions'],
] as const;

for (const [filename, expectedAction] of EXAMPLES) {
  test(`canonical ${filename} satisfies OperatorContinuationV1`, async () => {
    const url = new URL(`../../configs/examples/${filename}`, import.meta.url);
    const parsed = JSON.parse(await readFile(url, 'utf8')) as unknown;
    const continuation = validateOperatorContinuation(parsed);

    assert.equal(continuation.version, 1);
    assert.equal(continuation.action.type, expectedAction);
  });
}
