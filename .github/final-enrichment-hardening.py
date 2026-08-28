from pathlib import Path

def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected exactly one match, got {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

# 1) Bound Retry-After with the existing per-attempt timeout.
replace_once(
    "src/enrichment/http/fetcher.ts",
    """export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (!Number.isNaN(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }
  const asDate = new Date(header);
  if (!Number.isNaN(asDate.getTime())) {
    return Math.max(0, asDate.getTime() - Date.now());
  }
  return null;
}
""",
    """export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const asNumber = Number(header);
  if (!Number.isNaN(asNumber) && asNumber >= 0) {
    return asNumber * 1000;
  }
  const asDate = new Date(header);
  if (!Number.isNaN(asDate.getTime())) {
    return Math.max(0, asDate.getTime() - Date.now());
  }
  return null;
}

export function resolveRetryDelayMs(
  retryAfter: string | null,
  fallbackMs: number,
  maxDelayMs: number,
): number {
  const requestedMs = parseRetryAfter(retryAfter) ?? fallbackMs;
  return Math.min(requestedMs, Math.max(0, maxDelayMs));
}
""",
)

replace_once(
    "src/enrichment/http/fetcher.ts",
    """            const delayMs = parseRetryAfter(retryAfter) ?? (cfg.baseRetryDelayMs * (retry + 1));
            await new Promise((resolve) => setTimeout(resolve, delayMs));
""",
    """            const delayMs = resolveRetryDelayMs(
              retryAfter,
              cfg.baseRetryDelayMs * (retry + 1),
              cfg.timeoutMs,
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
""",
)

replace_once(
    "src/enrichment/http/fetcher.test.ts",
    """import { boundedFetch, parseRetryAfter, type DnsResolver, type SsrfChecker, type IpPolicy } from './fetcher.js';
""",
    """import { boundedFetch, parseRetryAfter, resolveRetryDelayMs, type DnsResolver, type SsrfChecker, type IpPolicy } from './fetcher.js';
""",
)

replace_once(
    "src/enrichment/http/fetcher.test.ts",
    """test('parseRetryAfter: returns null for invalid', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('invalid'), null);
});

""",
    """test('parseRetryAfter: returns null for invalid', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('invalid'), null);
});

test('resolveRetryDelayMs: caps server and fallback delays at the request timeout', () => {
  assert.equal(resolveRetryDelayMs('86400', 1000, 15000), 15000);
  assert.equal(resolveRetryDelayMs(null, 20000, 15000), 15000);
  assert.equal(resolveRetryDelayMs('2', 1000, 15000), 2000);
  assert.equal(resolveRetryDelayMs('0', 1000, 15000), 0);
});

""",
)

# 2) Make all deep enrichment modules fail fast at the CLI boundary when the shortlist is missing.
replace_once(
    "src/cli/enrich.ts",
    """const DEFAULT_CACHE_DB_PATH = 'data/cache/enrichment_http_cache.sqlite';

interface ParsedArgs {
""",
    """const DEFAULT_CACHE_DB_PATH = 'data/cache/enrichment_http_cache.sqlite';

const SHORTLIST_REQUIRED_MODULES: readonly EnrichmentModuleId[] = [
  'query_suggestions',
  'domain_age',
  'pages',
  'site_structure',
];

interface ParsedArgs {
""",
)

replace_once(
    "src/cli/enrich.ts",
    """    if (args.shortlistFile) {
      args.shortlist = loadShortlistFile(args.shortlistFile);
    }

    const config: ResearchConfig = loadConfig(process.env);
""",
    """    if (args.shortlistFile) {
      args.shortlist = loadShortlistFile(args.shortlistFile);
    }

    if (!args.resumeEnrichmentId) {
      const requiredBy = args.modules.filter((module) => SHORTLIST_REQUIRED_MODULES.includes(module));
      if (requiredBy.length > 0 && args.shortlist.length === 0) {
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `Modules ${requiredBy.join(', ')} require --shortlist or --shortlist-file with 5-200 keywords.`,
        );
      }
    }

    const config: ResearchConfig = loadConfig(process.env);
""",
)

Path("src/cli/enrich.input.test.ts").write_text(
    """import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const deepModules = ['query_suggestions', 'domain_age', 'pages', 'site_structure'] as const;

for (const module of deepModules) {
  test(`enrich CLI: ${module} without shortlist fails as invalid input before source lookup`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(process.cwd(), 'src', 'cli', 'enrich.ts'),
        '--run',
        'missing-source',
        '--modules',
        module,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /require --shortlist or --shortlist-file/);
    assert.doesNotMatch(result.stderr, /Source run not found|Enrichment failed/);
  });
}
""",
    encoding="utf-8",
)

# 3) Honor persisted HTTP retry settings in both HTTP-based enrichment modules.
fetcher_cfg_old = """    respectRetryAfter: httpConfig.respectRetryAfter,
    minDomainDelayMs: httpConfig.minDelayMs,
    maxDomainDelayMs: httpConfig.maxDelayMs,
  };
"""
fetcher_cfg_new = """    respectRetryAfter: httpConfig.respectRetryAfter,
    minDomainDelayMs: httpConfig.minDelayMs,
    maxDomainDelayMs: httpConfig.maxDelayMs,
    maxRetries: httpConfig.maxRetries,
    baseRetryDelayMs: httpConfig.baseRetryDelayMs,
  };
"""
engine_path = Path("src/enrichment/engine.ts")
engine_text = engine_path.read_text(encoding="utf-8")
count = engine_text.count(fetcher_cfg_old)
if count != 2:
    raise RuntimeError(f"src/enrichment/engine.ts: expected 2 fetcher config matches, got {count}")
engine_path.write_text(engine_text.replace(fetcher_cfg_old, fetcher_cfg_new), encoding="utf-8")

# 4) Enrichment terminal artifacts follow the same manifest-last contract as discovery.
replace_once(
    "src/enrichment/engine.ts",
    """import { mkdir } from 'node:fs/promises';
""",
    """import { mkdir, unlink } from 'node:fs/promises';
""",
)

manifest_block_old = """    await writeTextAtomic(
      manifestPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        modules,
        config: persistedConfig,
        shortlist: shortlist ?? [],
        artifacts,
        summary,
        state: 'completed',
        capabilities: {
          implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
          blocked: [
            { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
            { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          ],
        },
      }, null, 2) + '\\n',
      'enrichment manifest',
    );
    await writeTextAtomic(
      statusPath,
      JSON.stringify({
        enrichmentId,
        sourceRunId,
        status: 'completed',
        modules,
        summary,
        artifacts,
        capabilities: {
          implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
          blocked: [
            { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
            { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          ],
        },
      }, null, 2) + '\\n',
      'enrichment status',
    );

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
"""
manifest_block_new = """    const manifestContent = JSON.stringify({
      enrichmentId,
      sourceRunId,
      modules,
      config: persistedConfig,
      shortlist: shortlist ?? [],
      artifacts,
      summary,
      state: 'completed',
      capabilities: {
        implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
        blocked: [
          { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
        ],
      },
    }, null, 2) + '\\n';
    const statusContent = JSON.stringify({
      enrichmentId,
      sourceRunId,
      status: 'completed',
      modules,
      summary,
      artifacts,
      capabilities: {
        implemented: ['clusters', 'query_suggestions', 'domain_age', 'pages', 'site_structure'],
        blocked: [
          { module: 'page_backlinks', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
          { module: 'organic_snapshot', reason: 'BLOCKED_BY_PROVIDER — paid SEO API unavailable' },
        ],
      },
    }, null, 2) + '\\n';

    // `manifest.json` is the final publication marker, matching discovery runs.
    // If that final write fails, remove the already-published status so callers
    // never observe a terminal status without its matching manifest.
    await writeTextAtomic(statusPath, statusContent, 'enrichment status');
    try {
      await writeTextAtomic(manifestPath, manifestContent, 'enrichment manifest');
    } catch (error) {
      await unlink(statusPath).catch(() => undefined);
      throw error;
    }

    enrichmentStore.setEnrichmentState(enrichmentId, 'completed');
"""
replace_once("src/enrichment/engine.ts", manifest_block_old, manifest_block_new)

replace_once(
    "src/enrichment/engine.test.ts",
    """import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
""",
    """import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
""",
)

marker = """test('runEnrichment: clusters keywords from source run', async () => {
"""
test_block = """test('runEnrichment: removes terminal status when final manifest publication fails', async () => {
  const runId = 'manifest-failure-source';
  const sourceStore = createTestSourceStore(runId);
  const enrichmentDir = await mkdtemp(join(tmpdir(), 'enrichment-manifest-failure-'));
  const enrichmentStore = RunStore.open(join(enrichmentDir, 'enrichment.sqlite'));
  const enrichmentId = 'manifest-failure-enrichment';

  await mkdir(join(enrichmentDir, 'manifest.json'));

  try {
    const outcome = await runEnrichment({
      enrichmentId,
      sourceStoreOrPath: sourceStore,
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

    assert.equal(outcome.kind, 'failed');
    assert.equal(enrichmentStore.loadEnrichmentRun(enrichmentId)?.state, 'failed');
    await assert.rejects(readFile(join(enrichmentDir, 'status.json'), 'utf8'));
  } finally {
    sourceStore.close();
    enrichmentStore.close();
    await rm(enrichmentDir, { recursive: true, force: true });
  }
});


"""
replace_once("src/enrichment/engine.test.ts", marker, test_block + marker)
