import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  allocateEnrichmentDirectory,
  allocateResearchLocation,
  writeEnrichmentIndex,
  writeRunIndex,
} from '../outputs/researchLayout.js';
import { publishResearchToLibrary } from './researchLibrary.js';

const RUN_ID = 'run_library_test';
const ENRICHMENT_ID = 'enrichment_library_test';

function createIdentityDatabase(
  path: string,
  table: 'runs' | 'enrichment_runs',
  column: 'run_id' | 'enrichment_id',
  id: string,
): void {
  const db = new Database(path);
  try {
    db.exec(`CREATE TABLE ${table} (${column} TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${table} (${column}) VALUES (?)`).run(id);
  } finally {
    db.close();
  }
}

async function createPublishedResearch(root: string): Promise<{
  researchDirectory: string;
  discoveryDirectory: string;
  enrichmentDirectory: string;
}> {
  const location = await allocateResearchLocation(
    root,
    'Favicon Library Test',
    new Date('2026-08-30T00:00:00Z'),
  );
  createIdentityDatabase(join(location.discoveryDirectory, 'run.sqlite'), 'runs', 'run_id', RUN_ID);
  await writeRunIndex(root, {
    version: 1,
    runId: RUN_ID,
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
  });

  await writeFile(join(location.discoveryDirectory, 'manifest.json'), JSON.stringify({
    runId: RUN_ID,
    createdAt: '2026-08-30T00:00:00.000Z',
    updatedAt: '2026-08-30T00:10:00.000Z',
    state: 'completed',
  }, null, 2) + '\n');
  await writeFile(join(location.discoveryDirectory, 'keywords.json'), JSON.stringify([
    {
      id: 'kw-0001',
      keyword: 'favicon generator',
      normalizedKeyword: 'favicon generator',
      surfer: { volume: 12000, cpc: 7.5 },
      status: 'completed',
    },
    {
      id: 'kw-0002',
      keyword: 'favicon maker',
      normalizedKeyword: 'favicon maker',
      surfer: { volume: 3000, cpc: 4.2 },
      status: 'completed',
    },
  ], null, 2) + '\n');

  const enrichmentDirectory = await allocateEnrichmentDirectory(location.researchDirectory);
  createIdentityDatabase(join(enrichmentDirectory, 'enrichment.sqlite'), 'enrichment_runs', 'enrichment_id', ENRICHMENT_ID);
  await writeEnrichmentIndex(root, {
    version: 1,
    enrichmentId: ENRICHMENT_ID,
    runId: RUN_ID,
    researchDirectory: location.researchDirectory,
    enrichmentDirectory,
  });

  await writeFile(join(enrichmentDirectory, 'keyword-clusters.json'), JSON.stringify({
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    clusters: [
      {
        clusterId: 'cluster-1',
        canonicalKeywordIdx: 0,
        canonicalKeyword: 'favicon generator',
        memberCount: 2,
        members: [
          { keywordIdx: 0, keyword: 'favicon generator', normalizedKeyword: 'favicon generator' },
          { keywordIdx: 1, keyword: 'favicon maker', normalizedKeyword: 'favicon maker' },
        ],
      },
    ],
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'representative-queries.json'), JSON.stringify({
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    sets: [
      {
        clusterId: 'cluster-1',
        representativeKeywordIds: [0, 1],
        representatives: [
          { keywordIdx: 0, keyword: 'favicon generator' },
          { keywordIdx: 1, keyword: 'favicon maker' },
        ],
      },
    ],
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'entrant-cohort.json'), JSON.stringify({
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    cohorts: [
      {
        clusterId: 'cluster-1',
        domains: [
          {
            registrableDomain: 'example.com',
            bestRank: 2,
            medianRank: 3,
            occurrenceCount: 2,
            queryCoverage: { numerator: 2, denominator: 2, ratio: 1 },
            drEvidence: { status: 'known', value: 12, isWeak: true },
          },
        ],
      },
    ],
  }, null, 2) + '\n');
  await writeFile(join(enrichmentDirectory, 'cohort-history.json'), JSON.stringify({
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    projections: [
      {
        clusterId: 'cluster-1',
        domains: [
          {
            registrableDomain: 'example.com',
            coverageStatus: 'checked',
            registration: { date: '2025-01-01T00:00:00Z', isYoung: true },
            firstSeen: { date: null, isRecent: null },
            possibleHistoryConflict: false,
          },
        ],
      },
    ],
  }, null, 2) + '\n');
  await writeFinalist(enrichmentDirectory, 'build');

  await writeFile(join(enrichmentDirectory, 'manifest.json'), JSON.stringify({
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    state: 'completed',
    modules: ['clusters', 'domain_age'],
    artifacts: [
      'manifest.json',
      'keyword-clusters.json',
      'representative-queries.json',
      'entrant-cohort.json',
      'cohort-history.json',
      'finalist-evidence-matrix.json',
    ],
    summary: { clusterCount: 1, domainAgeDomainCount: 1 },
    finalistEvidence: { finalistCount: 1, currentHumanDecisionCount: 1 },
  }, null, 2) + '\n');

  return {
    researchDirectory: location.researchDirectory,
    discoveryDirectory: location.discoveryDirectory,
    enrichmentDirectory,
  };
}

async function writeFinalist(enrichmentDirectory: string, decision: 'build' | 'watch'): Promise<void> {
  await writeFile(join(enrichmentDirectory, 'finalist-evidence-matrix.json'), JSON.stringify({
    version: '1.0.0',
    enrichmentId: ENRICHMENT_ID,
    sourceRunId: RUN_ID,
    matrix: {
      finalists: [
        {
          clusterId: 'cluster-1',
          canonicalKeyword: 'favicon generator',
          representativeKeywordIds: [0, 1],
          humanDecision: {
            buildDecision: decision,
            seoProductRole: decision === 'build' ? 'acquisition_anchor' : 'experimental',
            recordedAt: '2026-08-30T00:20:00.000Z',
            evidenceCurrent: true,
          },
          auditFlags: ['TRAFFIC_EVIDENCE_NOT_COLLECTED'],
          evidence: {},
        },
      ],
    },
  }, null, 2) + '\n');
}

test('research library is idempotent and preserves changed snapshots as immutable versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-library-'));
  const source = await createPublishedResearch(root);

  const first = await publishResearchToLibrary({
    outputRoot: root,
    enrichmentId: ENRICHMENT_ID,
    now: () => new Date('2026-08-30T01:00:00.000Z'),
  });
  assert.equal(first.changed, true);
  assert.equal(first.publicationCount, 1);
  assert.equal(first.supersedesPublicationId, null);

  let db = new Database(first.libraryDbPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM publications').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM publication_keywords').get() as { count: number }).count, 2);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM publication_clusters').get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM publication_entrant_domains').get() as { count: number }).count, 1);
    const cluster = db.prepare(`
      SELECT build_decision, seo_product_role
      FROM publication_clusters
      WHERE publication_id = ? AND cluster_id = 'cluster-1'
    `).get(first.publicationId) as { build_decision: string | null; seo_product_role: string | null };
    assert.equal(cluster.build_decision, 'build');
    assert.equal(cluster.seo_product_role, 'acquisition_anchor');
    const domain = db.prepare(`
      SELECT registration_date, is_young
      FROM publication_entrant_domains
      WHERE publication_id = ? AND registrable_domain = 'example.com'
    `).get(first.publicationId) as { registration_date: string | null; is_young: number | null };
    assert.equal(domain.registration_date, '2025-01-01T00:00:00Z');
    assert.equal(domain.is_young, 1);
  } finally {
    db.close();
  }

  const index = JSON.parse(await readFile(first.libraryJsonPath, 'utf8')) as {
    publicationCount: number;
    publications: Array<{ publicationId: string; counts: { keywords: number }; decisions: Array<{ buildDecision: string | null }> }>;
  };
  assert.equal(index.publicationCount, 1);
  assert.equal(index.publications[0]?.publicationId, first.publicationId);
  assert.equal(index.publications[0]?.counts.keywords, 2);
  assert.equal(index.publications[0]?.decisions[0]?.buildDecision, 'build');

  const masterZip = await readFile(first.libraryArchivePath);
  assert.equal(masterZip.readUInt32LE(0), 0x04034b50);
  assert.ok(masterZip.includes(Buffer.from('library.sqlite')));
  assert.ok(masterZip.includes(Buffer.from('library.json')));
  assert.ok(masterZip.includes(Buffer.from(`researches/${first.publicationId}.zip`)));

  const repeated = await publishResearchToLibrary({
    outputRoot: root,
    enrichmentId: ENRICHMENT_ID,
    now: () => new Date('2026-08-30T01:05:00.000Z'),
  });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.publicationId, first.publicationId);
  assert.equal(repeated.publicationCount, 1);

  await writeFinalist(source.enrichmentDirectory, 'watch');
  const second = await publishResearchToLibrary({
    outputRoot: root,
    enrichmentId: ENRICHMENT_ID,
    now: () => new Date('2026-08-30T02:00:00.000Z'),
  });
  assert.equal(second.changed, true);
  assert.notEqual(second.publicationId, first.publicationId);
  assert.equal(second.supersedesPublicationId, first.publicationId);
  assert.equal(second.publicationCount, 2);

  db = new Database(second.libraryDbPath, { readonly: true, fileMustExist: true });
  try {
    const versions = db.prepare(`
      SELECT publication_id, supersedes_publication_id
      FROM publications
      WHERE enrichment_id = ?
      ORDER BY published_at
    `).all(ENRICHMENT_ID) as Array<{ publication_id: string; supersedes_publication_id: string | null }>;
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.publication_id, first.publicationId);
    assert.equal(versions[1]?.publication_id, second.publicationId);
    assert.equal(versions[1]?.supersedes_publication_id, first.publicationId);

    const latest = db.prepare(`
      SELECT build_decision
      FROM publication_clusters
      WHERE publication_id = ? AND cluster_id = 'cluster-1'
    `).get(second.publicationId) as { build_decision: string | null };
    assert.equal(latest.build_decision, 'watch');
  } finally {
    db.close();
  }
});

test('unadvertised stale finalist artifact is not merged into the library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-library-gating-'));
  const source = await createPublishedResearch(root);
  const manifestPath = join(source.enrichmentDirectory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { artifacts: string[]; [key: string]: unknown };
  manifest.artifacts = manifest.artifacts.filter((name) => name !== 'finalist-evidence-matrix.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const result = await publishResearchToLibrary({
    outputRoot: root,
    enrichmentId: ENRICHMENT_ID,
    now: () => new Date('2026-08-30T03:00:00.000Z'),
  });

  const db = new Database(result.libraryDbPath, { readonly: true, fileMustExist: true });
  try {
    const publication = db.prepare(`
      SELECT finalist_count FROM publications WHERE publication_id = ?
    `).get(result.publicationId) as { finalist_count: number };
    assert.equal(publication.finalist_count, 0);
    const cluster = db.prepare(`
      SELECT finalist_json, build_decision
      FROM publication_clusters
      WHERE publication_id = ? AND cluster_id = 'cluster-1'
    `).get(result.publicationId) as { finalist_json: string | null; build_decision: string | null };
    assert.equal(cluster.finalist_json, null);
    assert.equal(cluster.build_decision, null);
  } finally {
    db.close();
  }
});
