import { readFile, writeFile } from 'node:fs/promises';

const libraryPath = 'src/library/researchLibrary.ts';
const statusPath = 'src/research/status.ts';
const testPath = 'src/research/status.test.ts';

async function replaceOnce(path, before, after) {
  const source = await readFile(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}: ${before.slice(0, 120)}`);
  const next = source.replace(before, after);
  if (next === source) throw new Error(`Replacement did not change ${path}`);
  await writeFile(path, next, 'utf8');
}

await replaceOnce(
  libraryPath,
  `type ArtifactDigest = {\n  path: string;\n  sha256: string;\n  sizeBytes: number;\n};`,
  `export type ArtifactDigest = {\n  path: string;\n  sha256: string;\n  sizeBytes: number;\n};`,
);

await replaceOnce(
  libraryPath,
  `  const artifactDigests = await collectSnapshotArtifactDigests({\n    researchDirectory: enrichmentLocation.researchDirectory,\n    discoveryDirectory: sourceLocation.discoveryDirectory,\n    enrichmentDirectory: enrichmentLocation.enrichmentDirectory,\n    enrichmentArtifacts,\n  });\n  const snapshotFingerprint = fingerprintArtifacts(artifactDigests);`,
  `  const { artifactDigests, snapshotFingerprint } = await buildResearchLibrarySnapshot({\n    researchDirectory: enrichmentLocation.researchDirectory,\n    discoveryDirectory: sourceLocation.discoveryDirectory,\n    enrichmentDirectory: enrichmentLocation.enrichmentDirectory,\n    enrichmentManifest,\n  });`,
);

await replaceOnce(
  libraryPath,
  `async function collectSnapshotArtifactDigests(input: {\n  researchDirectory: string;\n  discoveryDirectory: string;\n  enrichmentDirectory: string;\n  enrichmentArtifacts: Set<string>;\n}): Promise<ArtifactDigest[]> {`,
  `export async function buildResearchLibrarySnapshot(input: {\n  researchDirectory: string;\n  discoveryDirectory: string;\n  enrichmentDirectory: string;\n  enrichmentManifest: Record<string, unknown>;\n}): Promise<{ artifactDigests: ArtifactDigest[]; snapshotFingerprint: string }> {\n  const artifactDigests = await collectSnapshotArtifactDigests({\n    researchDirectory: input.researchDirectory,\n    discoveryDirectory: input.discoveryDirectory,\n    enrichmentDirectory: input.enrichmentDirectory,\n    enrichmentArtifacts: artifactNames(input.enrichmentManifest),\n  });\n  return { artifactDigests, snapshotFingerprint: fingerprintArtifacts(artifactDigests) };\n}\n\nasync function collectSnapshotArtifactDigests(input: {\n  researchDirectory: string;\n  discoveryDirectory: string;\n  enrichmentDirectory: string;\n  enrichmentArtifacts: Set<string>;\n}): Promise<ArtifactDigest[]> {`,
);

await replaceOnce(
  statusPath,
  `import { ResearchError } from '../shared/errors.js';`,
  `import { ResearchError } from '../shared/errors.js';\nimport { buildResearchLibrarySnapshot } from '../library/researchLibrary.js';`,
);

await replaceOnce(
  statusPath,
  `export function buildLibraryPublicationSummary(manifest: Record<string, unknown>): unknown {\n  return {\n    modules: Array.isArray(manifest.modules) ? manifest.modules : [],\n    summary: manifest.summary ?? null,\n    representativeQueries: manifest.representativeQueries ?? null,\n    entrantCohort: manifest.entrantCohort ?? null,\n    cohortHistory: manifest.cohortHistory ?? null,\n    trafficEvidence: manifest.trafficEvidence ?? null,\n    finalistEvidence: manifest.finalistEvidence ?? null,\n  };\n}\n\nexport function storedPublicationSummaryMatches(storedSummaryJson: string, currentSummary: unknown): boolean {\n  let stored: unknown;\n  try {\n    stored = JSON.parse(storedSummaryJson) as unknown;\n  } catch {\n    return false;\n  }\n  return JSON.stringify(stored) === JSON.stringify(currentSummary);\n}\n\n`,
  ``,
);

await replaceOnce(
  statusPath,
  `async function inspectLibraryPublication(\n  outputRoot: string,\n  researchDirectory: string,\n  enrichment: ResearchEnrichmentStatus | null,\n  finalization: FinalizationStatus,\n): Promise<LibraryPublicationStatus> {`,
  `async function inspectLibraryPublication(\n  outputRoot: string,\n  researchDirectory: string,\n  discoveryDirectory: string,\n  enrichment: ResearchEnrichmentStatus | null,\n  finalization: FinalizationStatus,\n): Promise<LibraryPublicationStatus> {`,
);

await replaceOnce(
  statusPath,
  `  const dbPath = join(outputRoot, 'research-library', 'library.sqlite');`,
  `  if (finalization.state !== 'ready_to_publish') {\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: publicationReason(enrichment, finalization),\n      lookupError: null,\n    };\n  }\n\n  const dbPath = join(outputRoot, 'research-library', 'library.sqlite');`,
);

await replaceOnce(
  statusPath,
  `  const currentManifest = await readManifestArtifacts(join(researchDirectory, enrichment.directoryName));\n  if (currentManifest.manifest === null) {\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: 'current_manifest_unavailable',\n      lookupError: currentManifest.warning,\n    };\n  }\n  const currentSummary = buildLibraryPublicationSummary(currentManifest.manifest);\n\n  let db: Database.Database | null = null;\n  try {\n    db = new Database(dbPath, { readonly: true, fileMustExist: true });\n    const rows = db.prepare(\n      \`SELECT publication_id, published_at, summary_json\n       FROM publications\n       WHERE enrichment_id = ?\n       ORDER BY published_at DESC, rowid DESC\`,\n    ).all(enrichment.enrichmentId) as Array<{\n      publication_id: string;\n      published_at: string;\n      summary_json: string;\n    }>;`,
  `  const currentManifest = await readManifestArtifacts(join(researchDirectory, enrichment.directoryName));\n  if (currentManifest.manifest === null || currentManifest.warning !== null) {\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: 'current_manifest_unavailable',\n      lookupError: currentManifest.warning,\n    };\n  }\n\n  let currentSnapshotFingerprint: string;\n  try {\n    const snapshot = await buildResearchLibrarySnapshot({\n      researchDirectory,\n      discoveryDirectory,\n      enrichmentDirectory: join(researchDirectory, enrichment.directoryName),\n      enrichmentManifest: currentManifest.manifest,\n    });\n    currentSnapshotFingerprint = snapshot.snapshotFingerprint;\n  } catch (error) {\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: 'current_snapshot_unavailable',\n      lookupError: error instanceof Error ? error.message : String(error),\n    };\n  }\n\n  let db: Database.Database | null = null;\n  try {\n    db = new Database(dbPath, { readonly: true, fileMustExist: true });\n    const rows = db.prepare(\n      \`SELECT publication_id, published_at, snapshot_fingerprint\n       FROM publications\n       WHERE enrichment_id = ?\n       ORDER BY published_at DESC, rowid DESC\`,\n    ).all(enrichment.enrichmentId) as Array<{\n      publication_id: string;\n      published_at: string;\n      snapshot_fingerprint: string;\n    }>;`,
);

await replaceOnce(
  statusPath,
  `    for (const row of rows) {\n      try {\n        JSON.parse(row.summary_json);\n      } catch (error) {\n        return {\n          published: false,\n          publicationId: null,\n          publishedAt: null,\n          reason: 'library_lookup_failed',\n          lookupError: \`Publication \${row.publication_id} has invalid summary_json: \${error instanceof Error ? error.message : String(error)}\`,\n        };\n      }\n      if (storedPublicationSummaryMatches(row.summary_json, currentSummary)) {`,
  `    for (const row of rows) {\n      if (row.snapshot_fingerprint === currentSnapshotFingerprint) {`,
);

await replaceOnce(
  statusPath,
  `    : await inspectLibraryPublication(input.outputRoot, target.researchDirectory, currentEnrichment, finalization);`,
  `    : await inspectLibraryPublication(\n        input.outputRoot,\n        target.researchDirectory,\n        currentLocation.discoveryDirectory,\n        currentEnrichment,\n        finalization,\n      );`,
);

await replaceOnce(
  testPath,
  `  buildLibraryPublicationSummary,\n  buildResearchStatus,\n  generationFromDirectoryName,\n  storedPublicationSummaryMatches,`,
  `  buildResearchStatus,\n  generationFromDirectoryName,`,
);

const testSource = await readFile(testPath, 'utf8');
const start = testSource.indexOf("test('Library publication matching rejects stale same-enrichment metadata'");
const next = testSource.indexOf("test('status fails closed when one immutable enrichment directory contains multiple run identities'", start);
if (start < 0 || next < 0) throw new Error('Expected stale-summary test block not found');
await writeFile(testPath, `${testSource.slice(0, start)}${testSource.slice(next)}`, 'utf8');
