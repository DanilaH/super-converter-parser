import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchError } from '../shared/errors.js';
import { parseLibraryInspectArgs, renderResearchLibraryLineage } from './libraryInspect.js';
import { parseLibraryListArgs, renderResearchLibraryList } from './libraryList.js';

test('library:list parses read-only output options', () => {
  assert.deepEqual(parseLibraryListArgs(['--output-root', '/tmp/research', '--json']), {
    help: false,
    outputRoot: '/tmp/research',
    json: true,
  });
});

test('library:inspect requires an explicit persisted research path', () => {
  assert.throws(
    () => parseLibraryInspectArgs([]),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /--research-path/.test(error.message),
  );
});

test('library:inspect parses explicit path/output/json options', () => {
  assert.deepEqual(
    parseLibraryInspectArgs([
      '--research-path',
      '2026-09-01-alpha',
      '--output-root',
      '/tmp/research',
      '--json',
    ]),
    {
      help: false,
      outputRoot: '/tmp/research',
      researchPath: '2026-09-01-alpha',
      json: true,
    },
  );
});

test('Library text renderers expose stable path, current publication, and version lineage', () => {
  const publication = {
    publicationId: 'pub_fixture',
    snapshotFingerprint: 'fingerprint',
    sourceRunId: 'run_fixture',
    enrichmentId: 'enrichment_fixture',
    publishedAt: '2026-09-07T00:00:00.000Z',
    supersedesPublicationId: null,
    counts: { keywords: 10, clusters: 2, finalists: 1, entrantDomains: 3 },
  };

  const listText = renderResearchLibraryList({
    version: '1.0.0',
    initialized: true,
    libraryDbPath: '/tmp/library.sqlite',
    publicationCount: 1,
    researchCount: 1,
    researches: [{
      researchPath: '2026-09-01-alpha',
      researchName: 'alpha',
      versionCount: 1,
      currentPublication: publication,
    }],
  });
  assert.match(listText, /2026-09-01-alpha/);
  assert.match(listText, /current=pub_fixture/);

  const inspectText = renderResearchLibraryLineage({
    version: '1.0.0',
    libraryDbPath: '/tmp/library.sqlite',
    researchPath: '2026-09-01-alpha',
    researchName: 'alpha',
    versionCount: 1,
    publications: [{ ...publication, versionNumber: 1, current: true }],
  });
  assert.match(inspectText, /#1 \[current\] pub_fixture/);
  assert.match(inspectText, /fingerprint=fingerprint/);
});
