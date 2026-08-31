import { readFile, writeFile } from 'node:fs/promises';

const statusPath = 'src/research/status.ts';
const cliPath = 'src/cli/researchStatus.ts';
const testPath = 'src/research/status.test.ts';

async function replaceOnce(path, before, after) {
  const source = await readFile(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Expected block not found in ${path}: ${before.slice(0, 100)}`);
  const next = source.replace(before, after);
  if (next === source) throw new Error(`Replacement did not change ${path}`);
  await writeFile(path, next, 'utf8');
}

await replaceOnce(
  statusPath,
  `      const row = db.prepare(\n        \`SELECT enrichment_id, source_run_id, state, created_at, updated_at, modules, error\n         FROM enrichment_runs\n         ORDER BY rowid DESC\n         LIMIT 1\`,\n      ).get() as EnrichmentRunRow | undefined;\n      if (!row) continue;\n`,
  `      const rows = db.prepare(\n        \`SELECT enrichment_id, source_run_id, state, created_at, updated_at, modules, error\n         FROM enrichment_runs\n         ORDER BY rowid ASC\`,\n      ).all() as EnrichmentRunRow[];\n      if (rows.length !== 1) {\n        throw new ResearchError(\n          'DB_ERROR',\n          \`Enrichment directory \\"\${candidate.entry.name}\\" must contain exactly one enrichment run record; found \${rows.length}.\`,\n        );\n      }\n      const row = rows[0]!;\n`,
);

await replaceOnce(
  statusPath,
  `async function readManifestArtifacts(enrichmentDirectory: string): Promise<{ artifacts: Set<string>; warning: string | null }> {\n  const path = join(enrichmentDirectory, 'manifest.json');\n  try {\n    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;\n    if (typeof value !== 'object' || value === null || Array.isArray(value)) {\n      return { artifacts: new Set(), warning: 'enrichment manifest is not an object' };\n    }\n    const artifacts = (value as Record<string, unknown>).artifacts;\n    if (!Array.isArray(artifacts) || artifacts.some((item) => typeof item !== 'string')) {\n      return { artifacts: new Set(), warning: 'enrichment manifest has no valid artifacts list' };\n    }\n    return { artifacts: new Set(artifacts as string[]), warning: null };\n  } catch (error) {\n    if (isEnoent(error)) return { artifacts: new Set(), warning: 'enrichment manifest is missing' };\n    return { artifacts: new Set(), warning: error instanceof Error ? error.message : String(error) };\n  }\n}\n`,
  `type ManifestRead = {\n  artifacts: Set<string>;\n  warning: string | null;\n  manifest: Record<string, unknown> | null;\n};\n\nasync function readManifestArtifacts(enrichmentDirectory: string): Promise<ManifestRead> {\n  const path = join(enrichmentDirectory, 'manifest.json');\n  try {\n    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;\n    if (typeof value !== 'object' || value === null || Array.isArray(value)) {\n      return { artifacts: new Set(), warning: 'enrichment manifest is not an object', manifest: null };\n    }\n    const manifest = value as Record<string, unknown>;\n    const artifacts = manifest.artifacts;\n    if (!Array.isArray(artifacts) || artifacts.some((item) => typeof item !== 'string')) {\n      return { artifacts: new Set(), warning: 'enrichment manifest has no valid artifacts list', manifest };\n    }\n    return { artifacts: new Set(artifacts as string[]), warning: null, manifest };\n  } catch (error) {\n    if (isEnoent(error)) return { artifacts: new Set(), warning: 'enrichment manifest is missing', manifest: null };\n    return {\n      artifacts: new Set(),\n      warning: error instanceof Error ? error.message : String(error),\n      manifest: null,\n    };\n  }\n}\n\nexport function buildLibraryPublicationSummary(manifest: Record<string, unknown>): unknown {\n  return {\n    modules: Array.isArray(manifest.modules) ? manifest.modules : [],\n    summary: manifest.summary ?? null,\n    representativeQueries: manifest.representativeQueries ?? null,\n    entrantCohort: manifest.entrantCohort ?? null,\n    cohortHistory: manifest.cohortHistory ?? null,\n    trafficEvidence: manifest.trafficEvidence ?? null,\n    finalistEvidence: manifest.finalistEvidence ?? null,\n  };\n}\n\nexport function storedPublicationSummaryMatches(storedSummaryJson: string, currentSummary: unknown): boolean {\n  let stored: unknown;\n  try {\n    stored = JSON.parse(storedSummaryJson) as unknown;\n  } catch {\n    return false;\n  }\n  return JSON.stringify(stored) === JSON.stringify(currentSummary);\n}\n`,
);

await replaceOnce(
  statusPath,
  `async function inspectLibraryPublication(\n  outputRoot: string,\n  enrichment: ResearchEnrichmentStatus | null,\n  finalization: FinalizationStatus,\n): Promise<LibraryPublicationStatus> {`,
  `async function inspectLibraryPublication(\n  outputRoot: string,\n  researchDirectory: string,\n  enrichment: ResearchEnrichmentStatus | null,\n  finalization: FinalizationStatus,\n): Promise<LibraryPublicationStatus> {`,
);

await replaceOnce(
  statusPath,
  `  let db: Database.Database | null = null;\n  try {\n    db = new Database(dbPath, { readonly: true, fileMustExist: true });\n    const row = db.prepare(\n      \`SELECT publication_id, published_at\n       FROM publications\n       WHERE enrichment_id = ?\n       ORDER BY published_at DESC, rowid DESC\n       LIMIT 1\`,\n    ).get(enrichment.enrichmentId) as { publication_id: string; published_at: string } | undefined;\n    if (!row) {\n      return {\n        published: false,\n        publicationId: null,\n        publishedAt: null,\n        reason: publicationReason(enrichment, finalization),\n        lookupError: null,\n      };\n    }\n    return {\n      published: true,\n      publicationId: row.publication_id,\n      publishedAt: row.published_at,\n      reason: null,\n      lookupError: null,\n    };\n`,
  `  const currentManifest = await readManifestArtifacts(join(researchDirectory, enrichment.directoryName));\n  if (currentManifest.manifest === null) {\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: 'current_manifest_unavailable',\n      lookupError: currentManifest.warning,\n    };\n  }\n  const currentSummary = buildLibraryPublicationSummary(currentManifest.manifest);\n\n  let db: Database.Database | null = null;\n  try {\n    db = new Database(dbPath, { readonly: true, fileMustExist: true });\n    const rows = db.prepare(\n      \`SELECT publication_id, published_at, summary_json\n       FROM publications\n       WHERE enrichment_id = ?\n       ORDER BY published_at DESC, rowid DESC\`,\n    ).all(enrichment.enrichmentId) as Array<{\n      publication_id: string;\n      published_at: string;\n      summary_json: string;\n    }>;\n    if (rows.length === 0) {\n      return {\n        published: false,\n        publicationId: null,\n        publishedAt: null,\n        reason: publicationReason(enrichment, finalization),\n        lookupError: null,\n      };\n    }\n    for (const row of rows) {\n      try {\n        JSON.parse(row.summary_json);\n      } catch (error) {\n        return {\n          published: false,\n          publicationId: null,\n          publishedAt: null,\n          reason: 'library_lookup_failed',\n          lookupError: \`Publication \${row.publication_id} has invalid summary_json: \${error instanceof Error ? error.message : String(error)}\`,\n        };\n      }\n      if (storedPublicationSummaryMatches(row.summary_json, currentSummary)) {\n        return {\n          published: true,\n          publicationId: row.publication_id,\n          publishedAt: row.published_at,\n          reason: null,\n          lookupError: null,\n        };\n      }\n    }\n    return {\n      published: false,\n      publicationId: null,\n      publishedAt: null,\n      reason: 'current_snapshot_not_published',\n      lookupError: null,\n    };\n`,
);

await replaceOnce(
  statusPath,
  `      code: 'run_finalization',\n      message: \`Finalization for \${input.enrichment.enrichmentId} is \${input.finalization.state}.\`,\n      command: \`npm run finalize:full -- --enrichment \${input.enrichment.enrichmentId} ...\`,`,
  `      code: 'run_finalization',\n      message: \`Finalization for \${input.enrichment.enrichmentId} is \${input.finalization.state}; run finalize:full with the required explicit finalist scope/history policy for this research.\`,\n      command: null,`,
);

await replaceOnce(
  statusPath,
  `      code: 'supply_decisions',\n      message: \`\${input.finalization.currentDecisionCount}/\${input.finalization.finalistCount} finalist(s) have current human decisions.\`,\n      command: \`npm run finalize:full -- --enrichment \${input.enrichment.enrichmentId} --decisions <path> ...\`,`,
  `      code: 'supply_decisions',\n      message: \`\${input.finalization.currentDecisionCount}/\${input.finalization.finalistCount} finalist(s) have current human decisions; re-run finalize:full with an explicit --decisions file.\`,\n      command: null,`,
);

await replaceOnce(
  statusPath,
  `    : await inspectLibraryPublication(input.outputRoot, currentEnrichment, finalization);`,
  `    : await inspectLibraryPublication(input.outputRoot, target.researchDirectory, currentEnrichment, finalization);`,
);

await replaceOnce(
  cliPath,
  `    lines.push(\`  Publication: \${status.library.publicationId ?? 'unknown'}\${status.library.publishedAt ? \` @ \${status.library.publishedAt}\` : ''}\`);\n  } else {\n    lines.push(\`  Publication: none\${status.library.reason ? \` (\${status.library.reason})\` : ''}\`);`,
  `    lines.push(\`  Current publication: \${status.library.publicationId ?? 'unknown'}\${status.library.publishedAt ? \` @ \${status.library.publishedAt}\` : ''}\`);\n  } else {\n    lines.push(\`  Current publication: none\${status.library.reason ? \` (\${status.library.reason})\` : ''}\`);`,
);

await replaceOnce(
  testPath,
  `  buildResearchStatus,\n  generationFromDirectoryName,\n} from './status.js';`,
  `  buildLibraryPublicationSummary,\n  buildResearchStatus,\n  generationFromDirectoryName,\n  storedPublicationSummaryMatches,\n} from './status.js';`,
);

const tests = `\n\ntest('Library publication matching rejects stale same-enrichment metadata', () => {\n  const oldManifest = {\n    modules: ['clusters'],\n    summary: { clusterCount: 2 },\n    representativeQueries: { revision: 1 },\n    entrantCohort: { representativeRevision: 1 },\n    cohortHistory: null,\n    trafficEvidence: null,\n    finalistEvidence: { currentHumanDecisionCount: 1 },\n  };\n  const currentManifest = {\n    ...oldManifest,\n    finalistEvidence: { currentHumanDecisionCount: 2 },\n  };\n  const stored = JSON.stringify(buildLibraryPublicationSummary(oldManifest));\n  assert.equal(storedPublicationSummaryMatches(stored, buildLibraryPublicationSummary(oldManifest)), true);\n  assert.equal(storedPublicationSummaryMatches(stored, buildLibraryPublicationSummary(currentManifest)), false);\n  assert.equal(storedPublicationSummaryMatches('{broken', buildLibraryPublicationSummary(oldManifest)), false);\n});\n\ntest('status fails closed when one immutable enrichment directory contains multiple run identities', async () => {\n  const outputRoot = await mkdtemp(join(tmpdir(), 'research-status-corrupt-enrichment-'));\n  const location = await allocateResearchLocation(outputRoot, 'status corrupt enrichment', new Date('2026-08-30T00:00:00Z'));\n  const runId = 'run_status_corrupt_enrichment';\n  await createDiscovery({\n    outputRoot,\n    researchDirectory: location.researchDirectory,\n    directory: location.discoveryDirectory,\n    runId,\n    statuses: ['completed'],\n    state: 'completed',\n  });\n  await writeContainer(location.researchDirectory, runId, runId);\n\n  const enrichmentDirectory = await allocateEnrichmentDirectory(location.researchDirectory);\n  const store = RunStore.open(join(enrichmentDirectory, 'enrichment.sqlite'));\n  store.createEnrichmentRun({\n    enrichmentId: 'enrichment_corrupt_a',\n    sourceRunId: runId,\n    modules: ['clusters'],\n    config: '{}',\n    sourceRunDirectory: location.discoveryDirectory,\n    enrichmentDirectory,\n  });\n  store.createEnrichmentRun({\n    enrichmentId: 'enrichment_corrupt_b',\n    sourceRunId: runId,\n    modules: ['clusters'],\n    config: '{}',\n    sourceRunDirectory: location.discoveryDirectory,\n    enrichmentDirectory,\n  });\n  store.close();\n\n  await assert.rejects(\n    buildResearchStatus({ outputRoot, targetRunId: runId }),\n    /must contain exactly one enrichment run record; found 2/,\n  );\n});\n`;
const currentTests = await readFile(testPath, 'utf8');
if (!currentTests.includes("Library publication matching rejects stale same-enrichment metadata")) {
  await writeFile(testPath, `${currentTests.trimEnd()}${tests}`, 'utf8');
}
