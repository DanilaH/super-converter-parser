from pathlib import Path

root = Path(__file__).resolve().parents[1]
status_path = root / 'src/research/status.ts'
text = status_path.read_text(encoding='utf-8')

old_gate = """  if (finalization.state !== 'ready_to_publish') {
    return {
      published: false,
      publicationId: null,
      publishedAt: null,
      reason: publicationReason(enrichment, finalization),
      lookupError: null,
    };
  }

"""
if old_gate not in text:
    raise SystemExit('expected finalization publication gate not found')
text = text.replace(old_gate, '', 1)

old_decl = 'async function inspectLibraryPublication(\n'
if old_decl not in text:
    raise SystemExit('inspectLibraryPublication declaration not found')
text = text.replace(old_decl, 'export async function inspectLibraryPublication(\n', 1)

marker = "function publicationReason(enrichment: ResearchEnrichmentStatus, finalization: FinalizationStatus): string {\n"
helper = """export function resolveFinalizationStateWithLibrary(
  state: FinalizationStatus['state'],
  published: boolean,
): FinalizationStatus['state'] {
  return published && state === 'ready_to_publish' ? 'published' : state;
}

"""
if marker not in text:
    raise SystemExit('publicationReason marker not found')
text = text.replace(marker, helper + marker, 1)

old_promote = "  if (library.published) finalization.state = 'published';\n"
new_promote = "  finalization.state = resolveFinalizationStateWithLibrary(finalization.state, library.published);\n"
if old_promote not in text:
    raise SystemExit('old publication promotion not found')
text = text.replace(old_promote, new_promote, 1)
status_path.write_text(text, encoding='utf-8')

test_path = root / 'src/research/status.test.ts'
tests = test_path.read_text(encoding='utf-8')
tests = tests.replace(
    "import assert from 'node:assert/strict';\n",
    "import assert from 'node:assert/strict';\nimport Database from 'better-sqlite3';\n",
    1,
)
tests = tests.replace(
    "import { buildSeedKeywords } from '../input/seeds/normalize.js';\n",
    "import { buildSeedKeywords } from '../input/seeds/normalize.js';\nimport { buildResearchLibrarySnapshot } from '../library/researchLibrary.js';\n",
    1,
)
tests = tests.replace(
    "  buildResearchStatus,\n  generationFromDirectoryName,\n} from './status.js';\n",
    "  buildResearchStatus,\n  generationFromDirectoryName,\n  inspectLibraryPublication,\n  resolveFinalizationStateWithLibrary,\n  type FinalizationStatus,\n  type ResearchEnrichmentStatus,\n} from './status.js';\n",
    1,
)

regression = r'''

test('explicit incomplete publication remains visible without pretending human decisions are complete', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-incomplete-publication-'));
  const researchDirectory = join(outputRoot, 'research');
  const discoveryDirectory = join(researchDirectory, 'discovery');
  const enrichmentDirectory = join(researchDirectory, 'enrichment');
  const libraryDirectory = join(outputRoot, 'research-library');
  await mkdir(discoveryDirectory, { recursive: true });
  await mkdir(enrichmentDirectory, { recursive: true });
  await mkdir(libraryDirectory, { recursive: true });

  await writeFile(join(discoveryDirectory, 'manifest.json'), '{}\n', 'utf8');
  await writeFile(join(discoveryDirectory, 'keywords.json'), '[]\n', 'utf8');
  const enrichmentManifest = { artifacts: [] as string[] };
  await writeFile(
    join(enrichmentDirectory, 'manifest.json'),
    `${JSON.stringify(enrichmentManifest, null, 2)}\n`,
    'utf8',
  );

  const { snapshotFingerprint } = await buildResearchLibrarySnapshot({
    researchDirectory,
    discoveryDirectory,
    enrichmentDirectory,
    enrichmentManifest,
  });

  const libraryDb = new Database(join(libraryDirectory, 'library.sqlite'));
  libraryDb.exec(`
    CREATE TABLE publications (
      publication_id TEXT PRIMARY KEY,
      enrichment_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      snapshot_fingerprint TEXT NOT NULL
    )
  `);
  libraryDb.prepare(
    'INSERT INTO publications (publication_id, enrichment_id, published_at, snapshot_fingerprint) VALUES (?, ?, ?, ?)',
  ).run('pub_escape', 'enrichment_escape', '2026-08-31T00:00:00.000Z', snapshotFingerprint);
  libraryDb.close();

  const enrichment: ResearchEnrichmentStatus = {
    enrichmentId: 'enrichment_escape',
    generation: 1,
    directoryName: 'enrichment',
    sourceRunId: 'run_escape',
    state: 'completed',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    modules: [],
    itemCounts: {},
    error: null,
    isForCurrentDiscovery: true,
    isLatestForCurrentDiscovery: true,
  };
  const finalization: FinalizationStatus = {
    state: 'awaiting_decisions',
    enrichmentId: enrichment.enrichmentId,
    finalistCount: 2,
    currentDecisionCount: 0,
    allFinalistsHaveCurrentDecisions: false,
    finalistMatrixPublished: true,
    artifactWarning: null,
  };

  const publication = await inspectLibraryPublication(
    outputRoot,
    researchDirectory,
    discoveryDirectory,
    enrichment,
    finalization,
  );
  assert.equal(publication.published, true);
  assert.equal(publication.publicationId, 'pub_escape');
  assert.equal(
    resolveFinalizationStateWithLibrary(finalization.state, publication.published),
    'awaiting_decisions',
  );
  assert.equal(resolveFinalizationStateWithLibrary('ready_to_publish', true), 'published');
});
'''
if "explicit incomplete publication remains visible" in tests:
    raise SystemExit('regression test already exists')
test_path.write_text(tests.rstrip() + regression + '\n', encoding='utf-8')
