import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTrafficSnapshotRows } from './load.js';

const HEADER = [
  'target_cluster_id',
  'scope',
  'entity',
  'observed_at',
  'provider_data_date',
  'market',
  'source',
  'organic_traffic',
  'traffic_value',
  'traffic_value_currency',
  'provenance',
].join(',');

async function withCsv(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'traffic-import-'));
  const path = join(directory, 'traffic.csv');
  try {
    await writeFile(path, content, 'utf8');
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('traffic CSV loader maps canonical provider-neutral columns without SEO interpretation', async () => {
  await withCsv(
    `${HEADER}\ncluster-1,domain,example.test,2026-08-29T12:00:00Z,2026-08-28,US,manual-semrush,"1,234",250.5,usd,export screenshot\n`,
    async (path) => {
      const rows = await loadTrafficSnapshotRows(path);
      assert.deepEqual(rows, [{
        targetClusterId: 'cluster-1',
        scope: 'domain',
        entity: 'example.test',
        observedAt: '2026-08-29T12:00:00Z',
        providerDataDate: '2026-08-28',
        market: 'US',
        source: 'manual-semrush',
        organicTraffic: 1_234,
        trafficValue: 250.5,
        trafficValueCurrency: 'usd',
        provenance: 'export screenshot',
      }]);
    },
  );
});

test('traffic CSV loader preserves blank optional metrics as null for the domain validator', async () => {
  await withCsv(
    `${HEADER}\ncluster-1,url,https://example.test/tool,2026-08-29,2026-08-28,US,manual,,,,provider export row 7\n`,
    async (path) => {
      const [row] = await loadTrafficSnapshotRows(path);
      assert.equal(row?.organicTraffic, null);
      assert.equal(row?.trafficValue, null);
      assert.equal(row?.trafficValueCurrency, null);
    },
  );
});

test('traffic CSV loader accepts case/whitespace-normalized canonical headers', async () => {
  const header = [
    ' TARGET_CLUSTER_ID ',
    'Scope',
    'entity',
    'observed_at',
    'provider_data_date',
    'market',
    'source',
    'organic_traffic',
    'traffic_value',
    'traffic_value_currency',
    'provenance',
  ].join(',');
  await withCsv(
    `${header}\ncluster-1,domain,example.test,2026-08-29,2026-08-28,US,manual,100,,,manual row\n`,
    async (path) => {
      const [row] = await loadTrafficSnapshotRows(path);
      assert.equal(row?.targetClusterId, 'cluster-1');
      assert.equal(row?.organicTraffic, 100);
    },
  );
});

test('traffic CSV loader rejects missing required columns', async () => {
  await withCsv(
    'target_cluster_id,scope,entity\ncluster-1,domain,example.test\n',
    async (path) => {
      await assert.rejects(
        () => loadTrafficSnapshotRows(path),
        /missing required column\(s\): observed_at/,
      );
    },
  );
});

test('traffic CSV loader rejects invalid scope and ambiguous numeric formats', async () => {
  await withCsv(
    `${HEADER}\ncluster-1,page,example.test,2026-08-29,2026-08-28,US,manual,100,,,manual row\n`,
    async (path) => {
      await assert.rejects(() => loadTrafficSnapshotRows(path), /invalid scope "page"/);
    },
  );
  await withCsv(
    `${HEADER}\ncluster-1,domain,example.test,2026-08-29,2026-08-28,US,manual,"12,34",,,manual row\n`,
    async (path) => {
      await assert.rejects(
        () => loadTrafficSnapshotRows(path),
        /organic_traffic.*non-negative number or blank/,
      );
    },
  );
});

test('traffic CSV loader rejects duplicate normalized headers before object projection', async () => {
  await withCsv(
    `${HEADER}, SOURCE \ncluster-1,domain,example.test,2026-08-29,2026-08-28,US,manual,100,,,manual row,duplicate\n`,
    async (path) => {
      await assert.rejects(() => loadTrafficSnapshotRows(path), /duplicate column\(s\): source/);
    },
  );
  await withCsv(
    `${HEADER},source\ncluster-1,domain,example.test,2026-08-29,2026-08-28,US,manual,100,,,manual row,duplicate\n`,
    async (path) => {
      await assert.rejects(() => loadTrafficSnapshotRows(path), /duplicate column\(s\): source/);
    },
  );
});
