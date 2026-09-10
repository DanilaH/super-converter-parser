import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('browser shell is one persistent split workspace instead of primary full-screen navigation', async () => {
  const base = new URL('./public/', import.meta.url);
  const [html, source, css, serverSource] = await Promise.all([
    readFile(fileURLToPath(new URL('index.html', base)), 'utf8'),
    readFile(fileURLToPath(new URL('workspace.js', base)), 'utf8'),
    readFile(fileURLToPath(new URL('workspace.css', base)), 'utf8'),
    readFile(fileURLToPath(new URL('./server.ts', import.meta.url)), 'utf8'),
  ]);

  assert.doesNotThrow(() => new Function(source));
  assert.match(html, /class="sidebar workspace-rail"/);
  assert.match(html, /id="workspace-researches"/);
  assert.match(html, /id="workspace-search"/);
  assert.match(html, /id="workspace-new"[^>]*href="#\/new"/);
  assert.match(html, /class="main workspace-main"/);
  assert.match(html, /<link rel="stylesheet" href="\/workspace\.css">/);
  assert.match(html, /<script type="module" src="\/workspace\.js"><\/script>/);
  assert.match(html, /<script type="module" src="\/seed-import\.js"><\/script>/);
  assert.doesNotMatch(html, /<nav class="nav"/);
  assert.ok(html.indexOf('id="app"') < html.indexOf('id="metadata-action-root"'));
  assert.ok(html.indexOf('id="app"') < html.indexOf('id="batch-action-root"'));

  assert.match(source, /window\.location\.hash === '#\/researches'/);
  assert.match(source, /window\.location\.hash = '#\/new'/);
  assert.match(source, /\/api\/researches/);
  assert.match(source, /window\.location\.hash = `#\/research\/\$\{encodeURIComponent\(research\.researchId\)\}`/);
  assert.match(source, /\/api\/jobs/);
  assert.doesNotMatch(source, /innerHTML\s*=/);

  assert.match(css, /grid-template-columns:\s*var\(--workspace-rail\) minmax\(0, 1fr\)/);
  assert.match(css, /\.workspace-researches/);
  assert.match(css, /\.main\.workspace-main/);
  assert.match(css, /\.main\.workspace-main \.back-link\s*\{\s*display:\s*none;/);

  assert.ok(serverSource.includes("['/workspace.js', 'workspace.js', 'text/javascript; charset=utf-8']"));
  assert.ok(serverSource.includes("['/seed-import.js', 'seed-import.js', 'text/javascript; charset=utf-8']"));
  assert.ok(serverSource.includes("['/workspace.css', 'workspace.css', 'text/css; charset=utf-8']"));
});

test('seed importer accepts TXT, canonical keyword CSV, and strict JSON shapes', async () => {
  const source = await readFile(fileURLToPath(new URL('./public/seed-import.js', import.meta.url)), 'utf8');
  assert.doesNotThrow(() => new Function(source));
  const factory = new Function(`${source}\nreturn { parseSeedContent, parseCsvKeywords, parseJsonKeywords };`) as () => {
    parseSeedContent: (name: string, content: string) => { format: string; keywords: string[]; keywordText: string };
    parseCsvKeywords: (content: string) => string[];
    parseJsonKeywords: (content: string) => string[];
  };
  const parser = factory();

  assert.deepEqual(parser.parseSeedContent('seeds.txt', ' mic test \n\n speaker test\r\n').keywords, ['mic test', 'speaker test']);
  assert.deepEqual(parser.parseSeedContent('seeds.csv', 'volume,keyword\n10,"mic, test"\n20,"speaker ""left"""\n').keywords, ['mic, test', 'speaker "left"']);
  assert.deepEqual(parser.parseSeedContent('seeds.json', '["mic test", "speaker test"]\n').keywords, ['mic test', 'speaker test']);
  assert.deepEqual(parser.parseSeedContent('seeds.json', '{"keywords":["mic test","speaker test"]}').keywords, ['mic test', 'speaker test']);
  assert.throws(() => parser.parseSeedContent('seeds.csv', 'term\nmic test\n'), /must have a "keyword" column/);
  assert.throws(() => parser.parseSeedContent('seeds.json', '{"items":["mic test"]}'), /must be an array of strings/);
  assert.throws(() => parser.parseSeedContent('seeds.xlsx', 'anything'), /Unsupported seed file/);

  assert.match(source, /\.research-form textarea/);
  assert.match(source, /\.batch-form textarea\.batch-textarea/);
  assert.match(source, /dataTransfer\?\.files/);
  assert.match(source, /\.txt,\.csv,\.json/);
  assert.match(source, /textarea\.insertAdjacentElement\('beforebegin', zone\)/);
  assert.match(source, /textarea\.dispatchEvent\(new Event\('input'/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});
