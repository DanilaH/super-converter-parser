from pathlib import Path

def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"unexpected {label} shape: {count} matches")
    return text.replace(old, new)

store = Path('src/db/store.ts')
text = store.read_text(encoding='utf-8')
text = replace_once(
    text,
    "    const columns = this.tableColumns('serp_rows');\n"
    "    const registrableDomainExpr = columns.has('registrable_domain')\n"
    "      ? 'registrable_domain'\n"
    "      : \"'' AS registrable_domain\";\n",
    "    const columns = this.tableColumns('serp_rows');\n"
    "    const hasRegistrableDomainColumn = columns.has('registrable_domain');\n"
    "    const registrableDomainExpr = hasRegistrableDomainColumn\n"
    "      ? 'registrable_domain'\n"
    "      : \"'' AS registrable_domain\";\n",
    'registrable-domain column probe',
)
text = replace_once(
    text,
    "      registrableDomain:\n"
    "        row.registrable_domain || deriveHistoricalRegistrableDomain(row.hostname, row.url),\n",
    "      registrableDomain: hasRegistrableDomainColumn\n"
    "        ? row.registrable_domain\n"
    "        : deriveHistoricalRegistrableDomain(row.hostname, row.url),\n",
    'registrable-domain mapping',
)
store.write_text(text, encoding='utf-8')

engine_test = Path('src/enrichment/engine.test.ts')
text = engine_test.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { test } from 'node:test';\n",
    "import { test } from 'node:test';\nimport Database from 'better-sqlite3';\n",
    'engine test Database import',
)
marker = "\ntest('runEnrichment: clusters keywords from source run', async () => {"
regression = r'''
test('runEnrichment: reads a v1 source path without migrating it', async () => {
  const sourceDir = await mkdtemp(join(tmpdir(), 'enrichment-v1-source-'));
  const sourcePath = join(sourceDir, 'run.sqlite');
  const source = new Database(sourcePath);
  source.pragma('user_version = 1');
  source.exec(`
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      input_kind TEXT NOT NULL,
      input_path TEXT NOT NULL,
      config_snapshot TEXT NOT NULL,
      parser_versions TEXT NOT NULL,
      lookups INTEGER NOT NULL DEFAULT 0,
      pause_reason TEXT
    );
    CREATE TABLE keywords (
      run_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      normalized_keyword TEXT NOT NULL,
      sources TEXT NOT NULL,
      status TEXT NOT NULL,
      surfer TEXT,
      google TEXT,
      error TEXT,
      collected_at TEXT,
      PRIMARY KEY (run_id, idx)
    );
    CREATE TABLE serp_rows (
      run_id TEXT NOT NULL,
      keyword_idx INTEGER NOT NULL,
      position INTEGER NOT NULL,
      keyword TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      hostname TEXT NOT NULL,
      result_type TEXT NOT NULL,
      PRIMARY KEY (run_id, keyword_idx, position)
    );
  `);

  const runId = 'legacy-v1-source';
  const now = '2026-01-01T00:00:00.000Z';
  const configSnapshot = {
    ...BASE_CONFIG,
    cache: { ...BASE_CONFIG.cache, path: ':memory:' },
  };
  source.prepare(
    `INSERT INTO runs (run_id, state, created_at, updated_at, input_kind, input_path, config_snapshot, parser_versions, lookups, pause_reason)
     VALUES (?, 'completed', ?, ?, 'seeds', 'test.csv', ?, ?, 2, NULL)`,
  ).run(
    runId,
    now,
    now,
    JSON.stringify(configSnapshot),
    JSON.stringify({ surfer: '1.0.0', google: '1.0.0' }),
  );
  const insertKeyword = source.prepare(
    `INSERT INTO keywords (run_id, idx, id, keyword, normalized_keyword, sources, status, surfer, google, error, collected_at)
     VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, NULL, ?)`,
  );
  const google = JSON.stringify({ hl: 'en', gl: 'us', pageUrl: 'https://example.com', detectedLocation: null, geoWarning: false });
  insertKeyword.run(runId, 0, 'kw-0001', 'json diff', 'json diff', JSON.stringify([{ type: 'seed', rowNumbers: [1] }]), JSON.stringify({ volume: 800, cpc: 2.5, market: 'US', fetchedAt: now }), google, now);
  insertKeyword.run(runId, 1, 'kw-0002', 'json compare', 'json compare', JSON.stringify([{ type: 'seed', rowNumbers: [2] }]), JSON.stringify({ volume: 600, cpc: 2.0, market: 'US', fetchedAt: now }), google, now);

  const insertSerp = source.prepare(
    `INSERT INTO serp_rows (run_id, keyword_idx, position, keyword, title, url, hostname, result_type)
     VALUES (?, ?, ?, ?, '', ?, ?, 'organic')`,
  );
  for (const [idx, keyword, domains] of [
    [0, 'json diff', ['a.com', 'b.com', 'c.com', 'e.com']],
    [1, 'json compare', ['a.com', 'b.com', 'c.com', 'f.com']],
  ] as const) {
    domains.forEach((domain, position) => {
      insertSerp.run(runId, idx, position + 1, keyword, `https://${domain}/`, domain);
    });
  }
  source.close();

  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-v1-output-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'enrichment.sqlite'));
  const outcome = await runEnrichment({
    enrichmentId: 'legacy-v1-enrichment',
    sourceStoreOrPath: sourcePath,
    sourceRunId: runId,
    enrichmentStore,
    enrichmentDirectory: enrichmentDir,
    modules: ['clusters'],
    config: { clusters: CLUSTERING_CONFIG },
    httpConfig: HTTP_CONFIG,
    pagesConfig: PAGES_CONFIG,
    siteStructureConfig: SITE_STRUCTURE_CONFIG,
    logger: () => {},
  });

  assert.equal(outcome.kind, 'completed');
  assert.equal(outcome.state, 'completed');
  assert.equal(outcome.result?.clusters?.clusters.length, 1);
  enrichmentStore.close();

  const raw = new Database(sourcePath, { readonly: true });
  assert.equal(raw.pragma('user_version', { simple: true }), 1);
  const keywordColumns = raw.prepare('PRAGMA table_info(keywords)').all() as Array<{ name: string }>;
  const serpColumns = raw.prepare('PRAGMA table_info(serp_rows)').all() as Array<{ name: string }>;
  assert.ok(!keywordColumns.some((column) => column.name === 'cache_status'));
  assert.ok(!serpColumns.some((column) => column.name === 'registrable_domain'));
  raw.close();

  await rm(sourceDir, { recursive: true, force: true });
  await rm(enrichmentDir, { recursive: true, force: true });
});

'''
if text.count(marker) != 1:
    raise SystemExit(f"unexpected engine test marker: {text.count(marker)} matches")
text = text.replace(marker, '\n' + regression + marker)
engine_test.write_text(text, encoding='utf-8')
