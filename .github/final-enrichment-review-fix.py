from pathlib import Path

def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, got {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

replace_once(
    "src/cli/enrich.ts",
    """      shortlist = existingRun.shortlistKeywords;
      if (existingRun.modules.includes('query_suggestions') && (shortlist.length < 5 || shortlist.length > 200)) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Persisted shortlist has ${shortlist.length} keywords; required 5-200. Cannot resume.`,
        );
      }
      modules = existingRun.modules;
""",
    """      shortlist = existingRun.shortlistKeywords;
      const persistedShortlistRequiredBy = existingRun.modules.filter((module) =>
        SHORTLIST_REQUIRED_MODULES.includes(module),
      );
      if (
        persistedShortlistRequiredBy.length > 0 &&
        (shortlist.length < 5 || shortlist.length > 200)
      ) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Persisted shortlist has ${shortlist.length} keywords; modules ${persistedShortlistRequiredBy.join(', ')} require 5-200. Cannot resume.`,
        );
      }
      modules = existingRun.modules;
""",
)

replace_once(
    "src/enrichment/engine.ts",
    """    if (networkModules.length > 0 && !resume) {
""",
    """    if (networkModules.length > 0) {
""",
)

marker = """test('runEnrichment: removes terminal status when final manifest publication fails', async () => {
"""
test_block = """test('runEnrichment: resume refuses pages without a persisted shortlist', async () => {
  const runId = 'resume-shortlist-source';
  const sourceStore = createTestSourceStore(runId);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-resume-shortlist-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'enrichment.sqlite'));
  const enrichmentId = 'resume-shortlist-enrichment';

  enrichmentStore.createEnrichmentRun({
    enrichmentId,
    sourceRunId: runId,
    modules: ['pages'],
    config: JSON.stringify({ pages: PAGES_CONFIG, http: HTTP_CONFIG }),
    sourceRunDirectory: 'source',
    enrichmentDirectory: enrichmentDir,
    shortlistKeywords: [],
  });

  try {
    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStore,
      sourceRunId: runId,
      enrichmentStore,
      enrichmentDirectory: enrichmentDir,
      modules: ['pages'],
      shortlist: [],
      config: { pages: PAGES_CONFIG, http: HTTP_CONFIG },
      httpConfig: HTTP_CONFIG,
      pagesConfig: PAGES_CONFIG,
      siteStructureConfig: SITE_STRUCTURE_CONFIG,
      logger: () => {},
      resume: true,
    });

    assert.equal(outcome.kind, 'failed');
    assert.match(outcome.error ?? '', /require a --shortlist of 5–200 keywords/);
    assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.state, 'failed');
    assert.equal(enrichmentStore.loadPageTargets(enrichmentId).length, 0);
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(enrichmentDir, { recursive: true, force: true });
  }
});


"""
replace_once("src/enrichment/engine.test.ts", marker, test_block + marker)
