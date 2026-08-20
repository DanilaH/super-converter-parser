import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMicrosoftRows } from './load.js';

function writeCsv(directory: string, name: string, content: string): Promise<string> {
  return writeFile(join(directory, name), content, 'utf8').then(() => join(directory, name));
}

test('loadMicrosoftRows parses the real Microsoft Keyword Planner header layout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ms-load-'));
  const path = await writeCsv(
    directory,
    'export.csv',
    [
      'Ad group,Keyword,Average monthly searches,Competition,Suggested Bid,Ad impr. share',
      'Pdf Page,add page numbers to pdf,"100 - 1K","0.85","0.11",-',
      'Pdf Page,extract pages from pdf,"100 - 1K","0.95","0.67",-',
      'List,compare lists,"1K - 10K",-,-,-',
      'List,merge lists,"0 - 10",-,-,-',
    ].join('\n'),
  );

  const rows = await loadMicrosoftRows(path);
  assert.equal(rows.length, 4);

  const addPages = rows[0]!;
  assert.equal(addPages.adGroup, 'Pdf Page');
  assert.equal(addPages.keyword, 'add page numbers to pdf');
  assert.equal(addPages.volumeBucket, '100 - 1K');
  assert.equal(addPages.competition, '0.85');
  assert.equal(addPages.cpc, 0.11);

  const compare = rows[2]!;
  assert.equal(compare.volumeBucket, '1K - 10K');
  assert.equal(compare.competition, null);
  assert.equal(compare.cpc, null);
});

test('loadMicrosoftRows accepts header aliases (e.g. "Avg Monthly Searches")', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ms-alias-'));
  const path = await writeCsv(
    directory,
    'alias.csv',
    [
      'Campaign,Keyword,Avg Monthly Searches,Competition,CPC',
      'Grp,base64 decode,"1K - 10K",-,"0.13"',
    ].join('\n'),
  );

  const rows = await loadMicrosoftRows(path);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.adGroup, 'Grp');
  assert.equal(rows[0]!.volumeBucket, '1K - 10K');
  assert.equal(rows[0]!.competition, null);
  assert.equal(rows[0]!.cpc, 0.13);
});

test('loadMicrosoftRows rejects a file without a Keyword column', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ms-err-'));
  const path = await writeCsv(directory, 'bad.csv', 'Ad group,Volume\nGrp,100\n');

  await assert.rejects(
    () => loadMicrosoftRows(path),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('must have a "Keyword" column'),
  );
});

test('loadMicrosoftRows rejects an empty Keyword cell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ms-empty-'));
  const path = await writeCsv(
    directory,
    'empty.csv',
    'Keyword,Average monthly searches\n,"100 - 1K"\n',
  );

  await assert.rejects(
    () => loadMicrosoftRows(path),
    (error: unknown) => error instanceof Error && error.message.includes('empty "Keyword" value'),
  );
});

test('loadMicrosoftRows rejects a non-CSV / unreadable file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ms-missing-'));
  await assert.rejects(
    () => loadMicrosoftRows(join(directory, 'does-not-exist.csv')),
    (error: unknown) => error instanceof Error && error.message.includes('Cannot read Microsoft file'),
  );
});

test('acceptance: the real input/microsoft.csv feeds the parser with provenance columns', async () => {
  // The committed export exercises the same header layout Microsoft emits.
  const content = await readFile('input/microsoft.csv', 'utf8');
  const directory = await mkdtemp(join(tmpdir(), 'ms-real-'));
  const path = await writeCsv(directory, 'real.csv', content);

  const rows = await loadMicrosoftRows(path);
  assert.ok(rows.length > 50, `expected many keywords, got ${rows.length}`);

  const addPages = rows.find((row) => row.keyword === 'add page numbers to pdf');
  assert.ok(addPages, 'expected "add page numbers to pdf" in the export');
  assert.equal(addPages!.adGroup, 'Pdf Page');
  assert.equal(addPages!.volumeBucket, '100 - 1K');
  assert.equal(addPages!.competition, '0.85');
  assert.equal(addPages!.cpc, 0.11);

  const compare = rows.find((row) => row.keyword === 'compare lists');
  assert.ok(compare, 'expected "compare lists" in the export');
  assert.equal(compare!.volumeBucket, '1K - 10K');
  assert.equal(compare!.competition, null);
  assert.equal(compare!.cpc, null);
});
