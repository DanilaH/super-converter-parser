import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSiteStructureCsv, writeSiteStructureJson } from './outputs.js';
import type { SiteStructureRecord } from './site_structure/types.js';

function record(domain: string): SiteStructureRecord {
  return {
    domain,
    homepageStatus: 'ok',
    homepageHttpStatus: 200,
    robotsStatus: 'not_found',
    robotsHttpStatus: 404,
    robotsUrl: `https://${domain}/robots.txt`,
    sitemapUrlsFromRobots: [],
    sitemapFallbackUrl: `https://${domain}/sitemap.xml`,
    sitemapType: 'none',
    declaredSitemapCount: 0,
    discoveredUrlCount: 0,
    sampledUrls: [],
    sampledUtilityUrls: [],
    errors: [],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    cacheStatus: 'miss',
    sourceKeywords: ['json diff'],
    sourceBestPosition: 1,
  };
}

test('site-structure CSV/JSON expose domains omitted by the fair domain cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'site-structure-output-'));
  const csvPath = join(dir, 'site-structure.csv');
  const jsonPath = join(dir, 'site-structure.json');
  const records = [record('inspected.example')];
  const omitted = [{ domain: 'omitted.example', reason: 'domain_cap' }];

  await writeSiteStructureCsv(csvPath, records, omitted);
  await writeSiteStructureJson(jsonPath, {
    enrichmentId: 'enr-1',
    sourceRunId: 'run-1',
    records,
    omitted,
  });

  const csv = await readFile(csvPath, 'utf8');
  assert.match(csv, /domain,homepage_status,robots_status,sitemap_type/);
  assert.match(csv, /omitted,omit_reason/);
  assert.match(csv, /inspected\.example/);
  assert.match(csv, /omitted\.example,skipped,,,?none/);
  assert.match(csv, /true,domain_cap/);

  const json = JSON.parse(await readFile(jsonPath, 'utf8')) as {
    domainCount: number;
    omittedCount: number;
    discoveredDomainCount: number;
    omitted: Array<{ domain: string; reason: string }>;
  };
  assert.equal(json.domainCount, 1);
  assert.equal(json.omittedCount, 1);
  assert.equal(json.discoveredDomainCount, 2);
  assert.deepEqual(json.omitted, omitted);
});
