import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunStore, type StoredKeyword } from '../db/store.js';
import { loadConfig } from '../config/config.js';
import { buildSeedKeywords, type SeedKeyword } from '../input/seeds/normalize.js';
import { createRunId } from './run.js';
import { writeSnapshots } from './snapshots.js';
import { SCORING_VERSION } from '../scoring/scoring.js';
import type { SerpResult } from '../google/serp.js';

const BASE_CONFIG = loadConfig({});
const INPUT = { kind: 'seeds' as const, path: 'input/seeds.csv' };
const KEYWORDS: SeedKeyword[] = buildSeedKeywords([
  { keyword: 'compare lists', rowNumber: 1 },
  { keyword: 'best office chairs', rowNumber: 2 },
  { keyword: 'standing desk', rowNumber: 3 },
]);

function serp(keyword: string, position: number, domain: string, dr: number | null, drStatus: SerpResult['drStatus']): SerpResult {
  return {
    keyword,
    position,
    title: `t${position}`,
    url: `https://${domain}/${position}`,
    hostname: domain,
    registrableDomain: domain,
    dr,
    drStatus,
    resultType: 'organic',
  };
}

test('writeSnapshots emits aggregation artifacts (candidates, related, domains, quality, report, status)', async () => {
  const store = RunStore.openInMemory();
  const runId = createRunId();
  store.createRun({ runId, configSnapshot: BASE_CONFIG, parserVersions: { surfer: '1.0.0', google: '1.2.0' }, input: INPUT, keywords: KEYWORDS });
  const stored = store.loadKeywords(runId) as StoredKeyword[];

  // Keyword 0: completed, high volume, two known-DR domains.
  store.commitKeyword(
    runId,
    { ...stored[0]!, status: 'completed', surfer: { volume: 49500, cpc: 7.9, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' }, google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false }, error: null, collectedAt: '2026-01-01T00:00:00.000Z' },
    [serp('compare lists', 1, 'a.com', 50, 'ok'), serp('compare lists', 2, 'b.com', 20, 'ok')],
  );
  // Keyword 1: completed, one strong-DR domain.
  store.commitKeyword(
    runId,
    { ...stored[1]!, status: 'completed', surfer: { volume: 1000, cpc: 1.0, market: 'US', fetchedAt: '2026-01-01T00:00:00.000Z' }, google: { hl: 'en', gl: 'us', pageUrl: 'u', detectedLocation: null, geoWarning: false }, error: null, collectedAt: '2026-01-01T00:00:00.000Z' },
    [serp('best office chairs', 1, 'c.com', 80, 'ok')],
  );
  // Keyword 2: failed (no SERP) -> still appears with a null score.
  store.commitKeyword(
    runId,
    { ...stored[2]!, status: 'failed', surfer: null, google: null, error: { code: 'SURFER_PARSE_ERROR', message: 'boom' }, collectedAt: '2026-01-01T00:00:00.000Z' },
    [],
  );

  store.recordRelatedKeywords(
    runId,
    0,
    'compare lists',
    { status: 'ok', error: null, rows: [{ keyword: 'list compare', overlap: 10, volume: 5000 }] },
    new Set(['list compare']),
  );
  store.recordDomains(
    runId,
    0,
    stored[0]!.keyword,
    [serp('compare lists', 1, 'a.com', 50, 'ok'), serp('compare lists', 2, 'b.com', 20, 'ok')],
    new Map([['a.com', { source: 'cache', fetchedAt: '2026-01-01T00:00:00.000Z' }], ['b.com', { source: 'cache', fetchedAt: '2026-01-01T00:00:00.000Z' }]]),
  );
  store.recordDomains(
    runId,
    1,
    stored[1]!.keyword,
    [serp('best office chairs', 1, 'c.com', 80, 'ok')],
    new Map([['c.com', { source: 'fresh', fetchedAt: '2026-01-02T00:00:00.000Z' }]]),
  );
  store.setRunState(runId, 'completed');

  const runDirectory = await mkdtemp(join(tmpdir(), 'agg-snap-'));
  await writeSnapshots(store, runId, runDirectory, 'completed');

  const files = await readdir(runDirectory);
  for (const name of ['candidates.csv', 'related-keywords.csv', 'domains.csv', 'run-quality.json', 'report.md', 'status.json']) {
    assert.ok(files.includes(name), `expected artifact ${name}`);
  }

  const candidates = (await readFile(join(runDirectory, 'candidates.csv'), 'utf8')).slice(1).split('\r\n').filter((l) => l.length > 0);
  // header + 3 keywords (failed keyword still listed last with a null score)
  assert.equal(candidates.length, 4);
  assert.ok(candidates[0]!.startsWith('keyword,normalized_keyword,status'));
  // compare lists has volume 49500 and known DR -> highest score -> first data row
  assert.ok(candidates[1]!.startsWith('compare lists,'), `unexpected first candidate: ${candidates[1]}`);
  // failed keyword appears last with empty score/tier
  assert.ok(candidates[3]!.startsWith('standing desk,'), `unexpected failed row: ${candidates[3]}`);

  const related = (await readFile(join(runDirectory, 'related-keywords.csv'), 'utf8')).slice(1).split('\r\n').filter((l) => l.length > 0);
  assert.equal(related.length, 2);
  assert.ok(related[0]!.startsWith('parent,keyword,overlap'));
  assert.ok(related[1]!.includes('list compare'));

  const domains = (await readFile(join(runDirectory, 'domains.csv'), 'utf8')).slice(1).split('\r\n').filter((l) => l.length > 0);
  assert.equal(domains.length, 4); // a.com, b.com, c.com + header
  assert.ok(domains[0]!.startsWith('domain,dr,status,error,source'));

  const status = JSON.parse(await readFile(join(runDirectory, 'status.json'), 'utf8'));
  assert.equal(status.runId, runId);
  assert.equal(status.status, 'completed');
  assert.equal(status.keywords, 3);
  assert.equal(status.scoringVersion, SCORING_VERSION);
  assert.ok(typeof status.artifacts.candidatesCsv === 'string');
  assert.ok(status.artifacts.candidatesCsv.endsWith('candidates.csv'));
  assert.ok(status.artifacts.runQualityJson.endsWith('run-quality.json'));
  assert.equal(status.candidateReport, status.artifacts.candidatesCsv);
  assert.equal(status.counts.domains, 3);
  assert.equal(status.counts.relatedKeywords, 1);

  const quality = JSON.parse(await readFile(join(runDirectory, 'run-quality.json'), 'utf8'));
  assert.equal(quality.version, '1.0.0');
  assert.equal(quality.runId, runId);
  assert.equal(quality.sources.googleSerp.denominator, 3);
  assert.equal(quality.sources.googleSerp.trustworthy, 2);
  assert.equal(quality.sources.related.denominator, 3);
  assert.equal(quality.sources.related.successful, 1);
  assert.equal(quality.geo.grade, 'logical_only');
  assert.equal(quality.bounds.relatedExpansion.explicitOmissionCount, null);

  // first_seen_keyword carries the real keyword text, not its index.
  assert.ok(domains.join('\n').includes('compare lists'));

  const report = await readFile(join(runDirectory, 'report.md'), 'utf8');
  assert.ok(report.includes('Run Report'));
  assert.ok(report.includes('compare lists'));
  assert.ok(report.includes('standing desk'));
  assert.ok(report.includes('Keywords: 3'));

  store.close();
});
