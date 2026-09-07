import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { buildZip } from '../library/zip.js';
import { importGscSearchTraction } from './import.js';
import { searchTractionSnapshotId } from './store.js';

function csv(value: string): Buffer {
  return Buffer.from(value.replace(/^\n/, ''), 'utf8');
}

function fixtureZip(): Buffer {
  return buildZip([
    { name: 'Chart.csv', data: csv(`
Date,Clicks,Impressions,CTR,Position
2026-09-01,0,0,,
2026-09-02,1,10,10%,42.5
`) },
    { name: 'Queries.csv', data: csv(`
Top queries,Clicks,Impressions,CTR,Position
alpha query,1,6,16.67%,40
`) },
    { name: 'Pages.csv', data: csv(`
Top pages,Clicks,Impressions,CTR,Position
https://example.com/tool,1,10,10%,42.5
`) },
    { name: 'Countries.csv', data: csv(`
Country,Clicks,Impressions,CTR,Position
United States,1,10,10%,42.5
`) },
    { name: 'Devices.csv', data: csv(`
Device,Clicks,Impressions,CTR,Position
Desktop,1,10,10%,42.5
`) },
    { name: 'Search appearance.csv', data: csv('Search Appearance,Clicks,Impressions,CTR,Position\n') },
    { name: 'Filters.csv', data: csv('Filter,Value\nSearch type,Web\nDate,Last 3 months\n') },
  ], new Date('2026-09-06T00:00:00Z'));
}

test('GSC import persists one immutable snapshot and deduplicates the same property/source/parser export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsc-import-'));
  const inputPath = join(root, 'export.zip');
  await writeFile(inputPath, fixtureZip());
  const now = () => new Date('2026-09-07T12:00:00.000Z');

  const first = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
    now,
  });
  const second = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
    now,
  });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.snapshotId, second.snapshotId);
  assert.equal(second.snapshotCount, 1);
  assert.deepEqual(second.observedRange, { startDate: '2026-09-01', endDate: '2026-09-02' });
  assert.equal(second.dimensionTotals.query.impressionRatioToChart, 0.6);
  assert.deepEqual(await readFile(first.sourceArchivePath), fixtureZip());

  const db = new Database(first.databasePath, { readonly: true, fileMustExist: true });
  try {
    const snapshots = db.prepare('SELECT COUNT(*) AS count FROM snapshots').get() as { count: number };
    const daily = db.prepare('SELECT COUNT(*) AS count FROM daily_metrics').get() as { count: number };
    const dimensions = db.prepare('SELECT dimension, COUNT(*) AS count FROM dimension_metrics GROUP BY dimension ORDER BY dimension').all() as Array<{ dimension: string; count: number }>;
    const filters = db.prepare('SELECT COUNT(*) AS count FROM snapshot_filters').get() as { count: number };
    assert.equal(snapshots.count, 1);
    assert.equal(daily.count, 2);
    assert.deepEqual(dimensions, [
      { dimension: 'country', count: 1 },
      { dimension: 'device', count: 1 },
      { dimension: 'page', count: 1 },
      { dimension: 'query', count: 1 },
    ]);
    assert.equal(filters.count, 2);
  } finally {
    db.close();
  }
});

test('concurrent duplicate imports converge to one immutable snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsc-import-concurrent-'));
  const inputPath = join(root, 'export.zip');
  await writeFile(inputPath, fixtureZip());
  const request = {
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
    now: () => new Date('2026-09-07T12:00:00.000Z'),
  };

  const [a, b] = await Promise.all([
    importGscSearchTraction(request),
    importGscSearchTraction(request),
  ]);

  assert.equal(a.snapshotId, b.snapshotId);
  assert.deepEqual([a.changed, b.changed].sort(), [false, true]);
  assert.equal(a.snapshotCount, 1);
  assert.equal(b.snapshotCount, 1);
  assert.deepEqual(await readFile(a.sourceArchivePath), fixtureZip());
});

test('duplicate import restores a missing exact source archive without creating a new snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsc-import-repair-'));
  const inputPath = join(root, 'export.zip');
  await writeFile(inputPath, fixtureZip());
  const first = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
  });
  await rm(first.sourceArchivePath, { force: true });

  const second = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
  });

  assert.equal(second.changed, false);
  assert.equal(second.sourceArchiveRestored, true);
  assert.equal(second.snapshotCount, 1);
  assert.deepEqual(await readFile(second.sourceArchivePath), fixtureZip());
});

test('duplicate import replaces a corrupted source archive portably', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsc-import-corrupt-repair-'));
  const inputPath = join(root, 'export.zip');
  await writeFile(inputPath, fixtureZip());
  const first = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
  });
  await writeFile(first.sourceArchivePath, Buffer.from('corrupted source copy'));

  const second = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:example.com',
  });

  assert.equal(second.changed, false);
  assert.equal(second.sourceArchiveRestored, true);
  assert.equal(second.snapshotCount, 1);
  assert.deepEqual(await readFile(second.sourceArchivePath), fixtureZip());
});

test('same ZIP imported for a different explicit property remains a distinct snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gsc-import-property-'));
  const inputPath = join(root, 'export.zip');
  await writeFile(inputPath, fixtureZip());

  const first = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:one.example',
  });
  const second = await importGscSearchTraction({
    outputRoot: root,
    inputPath,
    property: 'sc-domain:two.example',
  });

  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(second.snapshotCount, 2);
});

test('snapshot identity changes when parser semantics version changes', () => {
  const v1 = searchTractionSnapshotId('sc-domain:example.com', 'source-sha', '1.0.0');
  const v11 = searchTractionSnapshotId('sc-domain:example.com', 'source-sha', '1.1.0');
  assert.notEqual(v1, v11);
});
