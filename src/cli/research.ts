import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { loadDotEnv } from '../config/env.js';
import type { Browser, BrowserContext } from 'playwright-core';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords, normalizeKeyword, type SeedKeyword } from '../input/seeds/normalize.js';
import { loadMicrosoftRows } from '../input/microsoft/load.js';

loadDotEnv();
import { buildMicrosoftKeywords, type MicrosoftKeyword } from '../input/microsoft/normalize.js';
import { collectKeyword, collectRelatedKeyword, type CollectionResult, type RelatedCollectionResult } from '../browser/collect.js';
import type { CancellationSignal } from '../browser/captcha.js';
import { executeRun, validateResume, type EngineHooks } from '../runs/engine.js';
import {
  applyFailedKeywordRetryPreparation,
  prepareFailedKeywordRetry,
  type FailedKeywordRetryPreparation,
} from '../runs/retryFailed.js';
import { buildRunStatus, writeSnapshots } from '../runs/snapshots.js';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';
import {
  loadOpenKeywordRetryIndexes,
  reconcileCompletedKeywordRetries,
} from '../db/retryAttempts.js';
import { createRunId, ensureWritableDirectory, type KeywordRecord } from '../runs/run.js';
import { allocateResearchLocation, archiveResearchDirectory, resolveOutputRoot, resolveRunLocation, writeRunIndex } from '../outputs/researchLayout.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { ResearchError } from '../shared/errors.js';
import { CacheStore } from '../cache/store.js';
import { keywordCacheIdentity } from '../cache/keys.js';
import { mergedCacheRefresh, planRunCache } from '../cache/resolve.js';
import { createAhrefsClient, type AhrefsClient } from '../ahrefs/client.js';

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_PREFLIGHT = 3;
// Documented stable code for a gracefully paused run (conventional Ctrl+C code).
export const EXIT_PAUSED = 130;

type CliOptions = {
  seedsPath: string | null;
  microsoftPath: string | null;
  resumeRunId: string | null;
  retryFailed: boolean;
  forceRefresh: boolean;
  refreshKeywords: string[];
  expand: boolean;
  jsonStatus: boolean;
  requireAhrefs: boolean;
  outputRoot: string | null;
  name: string | null;
};

// Browser-side pieces are injected so the CLI flow can be integration-tested
// without a Chrome instance; the defaults are the production implementations.
export type CliDeps = {
  connect: (cdpUrl: string) => Promise<Browser>;
  preflight: (
    context: BrowserContext,
    config: ResearchConfig,
    signal: CancellationSignal,
  ) => Promise<void>;
  collect: (
    context: BrowserContext,
    config: ResearchConfig,
    record: KeywordRecord,
    debugRoot: string,
    signal: CancellationSignal,
  ) => Promise<CollectionResult>;
  collectRelated?: (
    context: BrowserContext,
    config: ResearchConfig,
    record: KeywordRecord,
    debugRoot: string,
    signal: CancellationSignal,
  ) => Promise<RelatedCollectionResult>;
};

export const DEFAULT_CLI_DEPS: CliDeps = {
  connect: connectResearchChrome,
  preflight: preflightGoogleAndSurfer,
  collect: collectKeyword,
  collectRelated: collectRelatedKeyword,
};

function optionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('-')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    seedsPath: null,
    microsoftPath: null,
    resumeRunId: null,
    retryFailed: false,
    forceRefresh: false,
    refreshKeywords: [],
    expand: false,
    jsonStatus: false,
    requireAhrefs: false,
    outputRoot: null,
    name: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--seeds') {
      options.seedsPath = optionValue(argv, index, '--seeds');
      index += 1;
    } else if (arg === '--microsoft') {
      options.microsoftPath = optionValue(argv, index, '--microsoft');
      index += 1;
    } else if (arg === '--resume') {
      options.resumeRunId = optionValue(argv, index, '--resume');
      index += 1;
    } else if (arg === '--retry-failed') {
      options.retryFailed = true;
    } else if (arg === '--force-refresh') {
      options.forceRefresh = true;
    } else if (arg === '--expand' || arg === '--expand-surfer') {
      options.expand = true;
    } else if (arg === '--json-status') {
      options.jsonStatus = true;
    } else if (arg === '--require-ahrefs') {
      options.requireAhrefs = true;
    } else if (arg === '--output-root') {
      options.outputRoot = optionValue(argv, index, '--output-root');
      index += 1;
    } else if (arg === '--name') {
      options.name = optionValue(argv, index, '--name');
      index += 1;
    } else if (arg === '--refresh-keyword') {
      const value = optionValue(argv, index, '--refresh-keyword');
      options.refreshKeywords.push(value);
      index += 1;
    } else {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log('Utility Research Runner');
  console.log('');
  console.log('Usage:');
  console.log('  npm run research -- --seeds <path>');
  console.log('  npm run research -- --seeds <path> --force-refresh');
  console.log('  npm run research -- --seeds <path> --refresh-keyword "json diff"');
  console.log('  npm run research -- --microsoft <path>');
  console.log('  npm run research -- --resume <run-id>');
  console.log('  npm run research -- --resume <run-id> --retry-failed');
  console.log('');
  console.log('Options:');
  console.log('  --seeds <path>       Path to a CSV file with a required "keyword" column.');
  console.log('  --microsoft <path>   Path to a Microsoft Keyword Planner CSV export (requires a "Keyword" column).');
  console.log('  --resume <run-id>    Continue a paused or interrupted run (--seeds is not required).');
  console.log('  --retry-failed       With --resume, reopen only failed keyword checkpoints and preserve their attempt history.');
  console.log('  --force-refresh      Ignore the persistent cache for every keyword of this run.');
  console.log('  --expand             Enable Keyword Surfer related-keyword expansion (depth 1).');
  console.log('  --expand-surfer      Alias for --expand (clarity flag).');
  console.log('  --require-ahrefs     Require Ahrefs DR: fail if AHREFS_API_KEY is missing/blank.');
  console.log('  --output-root <path> Absolute durable output root (overrides RESEARCH_OUTPUT_ROOT).');
  console.log('  --name <label>       Human-readable research folder label.');
  console.log('  --json-status       Print a single compact JSON status line as the final stdout line.');
  console.log('  --refresh-keyword <q> Re-collect this keyword even if cached (repeatable; it must be one of the run keywords).');
  console.log('');
  console.log('Environment:');
  console.log('  RESEARCH_OUTPUT_ROOT         Durable output root (default <home>/super-converter-parser-output)');
  console.log('  CDP_URL                      Research Chrome debugging endpoint (default http://127.0.0.1:9333)');
  console.log('  SURFER_WAIT_MS               Max wait for Keyword Surfer data in ms (default 60000)');
  console.log('  SURFER_PREFLIGHT_TIMEOUT_MS  Max wait for Surfer injection during preflight in ms (default 60000)');
  console.log('  NAVIGATION_TIMEOUT_MS        Page load timeout in ms (default 60000)');
  console.log('  RESEARCH_MARKET              Surfer market label (default US)');
  console.log('  GOOGLE_HL                    Google interface language (default en)');
  console.log('  GOOGLE_GL                    Google country parameter (default us)');
  console.log('  TOP_N                        Integer organic results per keyword (default 10, range 1..30)');
  console.log('  SURFER_WIDGET_SELECTOR       Override Surfer main widget selector (testing hook)');
  console.log('  SURFER_RELATED_WIDGET_SELECTOR Override Surfer related-keywords widget selector');
  console.log('  EXPANSION_ENABLED            Enable Surfer related-keyword expansion (true/false)');
  console.log('  EXPANSION_DEPTH              Expansion depth (only 1 is currently supported)');
  console.log('  EXPANSION_MAX_CANDIDATES     Max related candidates per keyword (default 20)');
  console.log('  EXPANSION_MIN_OVERLAP        Drop candidates with lower overlap (default 0)');
  console.log('  EXPANSION_MIN_VOLUME         Drop candidates with lower volume (default 0)');
  console.log('  RETRY_MAX_ATTEMPTS           Max collection attempts per keyword (default 3)');
  console.log('  RETRY_BASE_DELAY_MS          Initial retry backoff (default 1000)');
  console.log('  RETRY_MAX_DELAY_MS           Retry backoff cap (default 15000)');
  console.log('  BREAKER_SURFER_WINDOW        Surfer failure window (default 15)');
  console.log('  BREAKER_SURFER_FAILURES      Surfer failures that pause the run (default 12, at most BREAKER_SURFER_WINDOW)');
  console.log('  BREAKER_GOOGLE_CONSECUTIVE   Consecutive Google SERP parse failures that pause (default 10)');
  console.log('  CACHE_DB_PATH                Persistent cache database (default data/cache/cache.sqlite)');
  console.log('  CACHE_TTL_COMPLETED_MS       Cache TTL for completed keywords in ms (default 7d)');
  console.log('  CACHE_TTL_PARTIAL_MS         Cache TTL for partial keywords in ms (default 6h)');
  console.log('  CACHE_TTL_FAILED_MS          Cache TTL for failed keywords in ms (default 1h)');
  console.log('  CACHE_TTL_RELATED_MS         Cache TTL for related keywords in ms (default 7d)');
  console.log('  CACHE_TTL_RELATED_ERROR_MS   Cache TTL for failed related-keyword expansions in ms (default 1h)');
  console.log('  CACHE_TTL_DOMAIN_OK_MS       Cache TTL for successful DR lookups in ms (default 30d)');
  console.log('  CACHE_TTL_DOMAIN_NOT_FOUND_MS Cache TTL for not-found DR lookups in ms (default 30d)');
  console.log('  REQUIRE_AHREFS               Require Ahrefs DR (true/false); fail early without a key');
  console.log('');
  console.log('Exit codes: 0 ok (incl. completed_with_errors), 1 internal, 2 invalid input/config,');
  console.log('3 preflight/environment, 130 gracefully paused (resume with --resume).');
}

// A resume must not mix parser settings with the current run. The widget
// selector is a parser-setting, so changing it mid-run is refused.
export function effectiveConfigForResume(
  current: ResearchConfig,
  persisted: ResearchConfig,
  runId: string,
): ResearchConfig {
  if (current.browser.surferWidgetSelector !== persisted.browser.surferWidgetSelector) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Run "${runId}" persisted SURFER_WIDGET_SELECTOR "${persisted.browser.surferWidgetSelector}" but the current value is "${current.browser.surferWidgetSelector}". Start a new run instead; the widget selector must not change between resume attempts.`,
    );
  }
  if (current.browser.surferRelatedWidgetSelector !== persisted.browser.surferRelatedWidgetSelector) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Run "${runId}" persisted SURFER_RELATED_WIDGET_SELECTOR "${persisted.browser.surferRelatedWidgetSelector}" but the current value is "${current.browser.surferRelatedWidgetSelector}". Start a new run instead; the related widget selector must not change between resume attempts.`,
    );
  }
  // Semantic research settings (including expansion and the related widget
  // selector) come from the persisted snapshot so a resumed run reproduces the
  // original expansion behavior; operational settings (connection, timeouts,
  // retries, breaker) use the current env.
  // Resume always restores the persisted requireAhrefs — the operator must not
  // re-supply --require-ahrefs on resume. The persisted value is authoritative;
  // this prevents silent DR skip (resuming a required run as optional) or mid-run
  // failure (resuming an optional run as required when earlier keywords lack DR).
  // A persisted snapshot that predates this field (undefined) defaults to optional.
  return {
    ...current,
    research: persisted.research,
    expansion: persisted.expansion,
    ahrefs: { ...current.ahrefs, requireAhrefs: persisted.ahrefs.requireAhrefs ?? false },
    browser: { ...current.browser, surferRelatedWidgetSelector: persisted.browser.surferRelatedWidgetSelector },
  };
}

// Refresh flags name real run keywords (normalized exactly like the queue
// itself); an unknown keyword is an input error, not a silent no-op.
function validateRefreshKeywords(rawKeywords: string[], knownKeywords: string[]): string[] {
  const known = new Set(knownKeywords);
  return rawKeywords.map((raw) => {
    const normalized = normalizeKeyword(raw);
    if (!known.has(normalized)) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `--refresh-keyword "${raw}" (normalized to "${normalized}") is not among the run keywords.`,
      );
    }
    return normalized;
  });
}

function exitCodeForError(error: ResearchError): number {
  switch (error.code) {
    case 'INPUT_SCHEMA_ERROR':
    case 'RESUME_NOT_FOUND':
    case 'RESUME_TERMINAL_RUN':
    case 'RESUME_PARSER_MISMATCH':
    case 'RESUME_CONFIG_MISMATCH':
      return EXIT_INVALID_INPUT;
    case 'BROWSER_CONNECTION_ERROR':
    case 'SURFER_NOT_DETECTED':
    case 'GOOGLE_UNAVAILABLE':
    case 'CAPTCHA_REQUIRED':
    case 'OUTPUT_WRITE_ERROR':
    case 'CACHE_DB_ERROR':
    case 'AHREFS_NOT_CONFIGURED':
    case 'AHREFS_REQUIRE_CONFIG':
      return EXIT_PREFLIGHT;
    default:
      return EXIT_INTERNAL;
  }
}

export async function runCli(
  argv: string[],
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`Run failed:\n  ${error.code}: ${error.message}`);
      return exitCodeForError(error);
    }
    throw error;
  }

  if (options.seedsPath && options.resumeRunId) {
    console.error('--seeds and --resume are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.microsoftPath && options.resumeRunId) {
    console.error('--microsoft and --resume are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.seedsPath && options.microsoftPath) {
    console.error('--seeds and --microsoft are mutually exclusive.');
    return EXIT_INVALID_INPUT;
  }
  if (options.retryFailed && !options.resumeRunId) {
    console.error('--retry-failed requires --resume <run-id>.');
    return EXIT_INVALID_INPUT;
  }
  if (!options.seedsPath && !options.microsoftPath && !options.resumeRunId) {
    printUsage();
    return EXIT_INVALID_INPUT;
  }

  let pauseRequested = false;
  let sigintCount = 0;
  // Named so the listener can be removed in finally without touching any
  // SIGINT handlers registered by other code in the same process.
  const onSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      console.log('');
      console.log('Stopping... (Ctrl+C again to force quit)');
      pauseRequested = true;
    } else {
      process.off('SIGINT', onSigint);
      process.kill(process.pid, 'SIGINT');
    }
  };
  process.on('SIGINT', onSigint);

  let browser: Browser | null = null;
  let store: RunStore | null = null;
  let cacheStore: CacheStore | null = null;
  let runId = '';
  let runDirectory = '';
  let researchDirectory = '';
  let archivePath = '';
  let debugRoot = '';
  try {
    const config = loadConfig(env);

    let mode: 'fresh' | 'resume';
    let keywords: SeedKeyword[] | MicrosoftKeyword[] = [];
    let input: { kind: 'seeds' | 'microsoft'; path: string };
    let refreshKeywords: string[] = [];
    let runConfig = config;
    let ahrefsApiKey: string | null = null;

    const outputRoot = resolveOutputRoot(options.outputRoot, env);

    // CLI semantic overrides apply only to a new run. Resume restores the
    // persisted semantic snapshot below and deliberately ignores these flags.
    if (!options.resumeRunId) {
      if (options.expand) {
        runConfig = { ...runConfig, expansion: { ...runConfig.expansion, enabled: true } };
      }
      if (options.requireAhrefs) {
        runConfig = { ...runConfig, ahrefs: { ...runConfig.ahrefs, requireAhrefs: true } };
      }
    }

    const validateAhrefsRequirement = (candidateConfig: ResearchConfig): string | null => {
      const rawKey = (env.AHREFS_API_KEY ?? '').trim();
      const key = rawKey.length > 0 ? rawKey : null;
      if (candidateConfig.ahrefs.requireAhrefs && !key) {
        throw new ResearchError(
          'AHREFS_REQUIRE_CONFIG',
          'Ahrefs DR is required (--require-ahrefs / REQUIRE_AHREFS=true) but AHREFS_API_KEY is not set. Export AHREFS_API_KEY and retry.',
        );
      }
      return key;
    };

    if (options.resumeRunId) {
      runId = options.resumeRunId;
      const location = await resolveRunLocation(outputRoot, runId);
      runDirectory = location.discoveryDirectory;
      researchDirectory = location.researchDirectory;
      archivePath = location.archivePath;
      debugRoot = location.legacy ? resolve(process.cwd(), 'debug', runId) : join(researchDirectory, 'debug');
      mode = 'resume';

      const storePath = join(runDirectory, 'run.sqlite');
      store = RunStore.open(storePath);

      // Recover the narrow crash window where the normal keyword checkpoint was
      // already committed but its retry journal row was not closed yet. This is
      // schema-neutral for runs that have never used --retry-failed.
      const recoveredRetryIdxs = reconcileCompletedKeywordRetries(store, runId);
      let retryPreparation: FailedKeywordRetryPreparation | null = null;
      if (options.retryFailed) {
        retryPreparation = prepareFailedKeywordRetry(store, runId);
      }

      // A new explicit repair may start from completed_with_errors, which normal
      // resume correctly rejects. Use its read-only preparation snapshot only to
      // validate config/input/environment; after preflight the applied repair is
      // paused and goes through the ordinary validateResume contract again.
      const run = retryPreparation?.run ?? validateResume(store, runId);
      runConfig = effectiveConfigForResume(config, run.configSnapshot, runId);
      input = run.input;
      refreshKeywords = validateRefreshKeywords(
        options.refreshKeywords,
        store.loadKeywords(runId).map((item) => item.normalizedKeyword),
      );
      ahrefsApiKey = validateAhrefsRequirement(runConfig);
      cacheStore = CacheStore.open(runConfig.cache.path);

      console.log('Utility Research Runner');
      console.log('');
      console.log(`[resume] ${runId} (state: ${run.state}, parser ${run.parserVersions.surfer}/${run.parserVersions.google})`);
      if (recoveredRetryIdxs.length > 0) {
        console.log(`  ✓ recovered ${recoveredRetryIdxs.length} completed retry journal checkpoint(s)`);
      }
      await ensureWritableDirectory(runDirectory);
      console.log(`  ✓ ${runDirectory} writable`);
      await ensureWritableDirectory(debugRoot);
      console.log(`  ✓ ${debugRoot} writable`);
      console.log(`  ✓ cache ${runConfig.cache.path} opened (schema v${cacheStore.version})`);

      if (retryPreparation) {
        const reopenedRetryIdxs = applyFailedKeywordRetryPreparation(store, retryPreparation);
        if (reopenedRetryIdxs.length > 0) {
          // The applied run is now paused and must satisfy the same parser/state
          // contract as every ordinary resume before browser work begins.
          validateResume(store, runId);
          console.log(`  ↻ reopened ${reopenedRetryIdxs.length} failed keyword checkpoint(s)`);
        } else if (retryPreparation.openKeywordIdxs.length > 0) {
          // Re-entering --retry-failed while a repair is already open is an
          // idempotent continuation, not a new retry generation.
          validateResume(store, runId);
          console.log(`  ↻ continuing ${retryPreparation.openKeywordIdxs.length} open retry attempt(s)`);
        }
      }
      console.log('');
    } else {
      mode = 'fresh';
      input = options.microsoftPath
        ? { kind: 'microsoft', path: options.microsoftPath as string }
        : { kind: 'seeds', path: options.seedsPath as string };

      if (options.microsoftPath) {
        const rows = await loadMicrosoftRows(options.microsoftPath);
        keywords = buildMicrosoftKeywords(rows);
        console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords (Microsoft)`);
      } else {
        const rows = await loadSeedRows(options.seedsPath as string);
        keywords = buildSeedKeywords(rows);
        console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords`);
      }
      if (keywords.length === 0) {
        throw new ResearchError('INPUT_SCHEMA_ERROR', 'Input contains no research keywords.');
      }

      // Input/config/cache validation happens before allocating a durable research
      // directory. Ordinary preflight errors therefore cannot leave an indexed
      // directory containing only run.sqlite with no run row. Browser preflight
      // intentionally remains after createRun so an interrupted/failed browser
      // preflight is resumable.
      refreshKeywords = validateRefreshKeywords(
        options.refreshKeywords,
        keywords.map((item) => item.normalizedKeyword),
      );
      ahrefsApiKey = validateAhrefsRequirement(runConfig);
      cacheStore = CacheStore.open(runConfig.cache.path);

      runId = createRunId();
      const location = await allocateResearchLocation(outputRoot, options.name ?? keywords[0]!.keyword);
      runDirectory = location.discoveryDirectory;
      researchDirectory = location.researchDirectory;
      archivePath = location.archivePath;
      debugRoot = join(researchDirectory, 'debug');

      console.log('Utility Research Runner');
      console.log('');
      console.log('[preflight]');
      await ensureWritableDirectory(runDirectory);
      await ensureWritableDirectory(debugRoot);
      store = RunStore.open(join(runDirectory, 'run.sqlite'));
      await writeRunIndex(
        outputRoot,
        { version: 1, runId, researchDirectory, discoveryDirectory: runDirectory },
        () => {
          store?.close();
          store = null;
        },
      );
      console.log(`  ✓ research directory: ${researchDirectory}`);
      console.log(`  ✓ run.sqlite initialized (schema v${store.version})`);
      console.log(`  ✓ cache ${runConfig.cache.path} opened (schema v${cacheStore.version})`);
      console.log('');
    }

    if (!cacheStore) {
      throw new ResearchError('CACHE_DB_ERROR', 'Cache store was not initialized.');
    }

    // AHREFS_API_KEY gates DR enrichment: without a key the DR phase is skipped
    // (organic SERP and all other stages still run). In optional mode this is
    // reported as skipped/degraded, never as resolved.
    let ahrefs: { apiKey: string; client: AhrefsClient } | null = null;
    if (ahrefsApiKey) {
      ahrefs = {
        apiKey: ahrefsApiKey,
        client: createAhrefsClient(ahrefsApiKey, {
          endpoint: runConfig.ahrefs.endpoint,
          timeoutMs: runConfig.ahrefs.timeoutMs,
          minDelayMs: runConfig.ahrefs.rateLimitMinDelayMs,
          maxDelayMs: runConfig.ahrefs.rateLimitMaxDelayMs,
        }),
      };
      console.log(`  ✓ Ahrefs DR enrichment enabled (${runConfig.ahrefs.endpoint})`);
    } else {
      console.log('  • Ahrefs DR enrichment skipped (AHREFS_API_KEY not set)');
    }
    console.log('');

    // A fresh run's keywords exist only in the seeds (executeRun inserts them
    // into the store); a resume's pending keywords live in the run store.
    const pendingNormalized =
      mode === 'fresh'
        ? keywords.map((item) => item.normalizedKeyword)
        : store
            .loadKeywords(runId)
            .filter((item) => !isTerminalKeywordStatus(item.status))
            .map((item) => item.normalizedKeyword);
    const identity = keywordCacheIdentity(runConfig);

    // Refresh semantics persisted by an earlier (interrupted) invocation still
    // apply, so a forced-refresh run resumed without flags stays forced and
    // never silently serves pending keywords from the cache.
    const persisted =
      mode === 'resume'
        ? (store.loadRun(runId) ?? { forceRefresh: false, refreshKeywords: [] })
        : { forceRefresh: false, refreshKeywords: [] };
    const effective = mergedCacheRefresh(
      { forceRefresh: options.forceRefresh, refreshKeywords: new Set(refreshKeywords) },
      persisted,
    );
    const refreshSet = new Set(effective.refreshKeywords);

    // An open repair attempt is its own durable reason to bypass a stale failed
    // keyword cache entry. Keep this transient: do not persist it into the run's
    // ordinary refresh_keywords, or a one-time repair would become permanent.
    const retryOpenIdxs = mode === 'resume' ? loadOpenKeywordRetryIndexes(store, runId) : [];
    const retryOpenIdxSet = new Set(retryOpenIdxs);
    const retryRefreshKeywords = mode === 'resume'
      ? store
          .loadKeywords(runId)
          .filter((item) => retryOpenIdxSet.has(item.idx))
          .map((item) => item.normalizedKeyword)
      : [];

    // Related-keyword observation is an independent fact. If an open primary
    // repair already has a successful/truthful-empty related checkpoint in this
    // run, do not let the forced primary browser visit overwrite that evidence
    // (or its cache entry) with a later related error/empty observation.
    const preservedRelatedRepairIdxs = new Set(
      mode === 'resume'
        ? store
            .loadRelatedKeywords(runId)
            .filter(
              (row) =>
                retryOpenIdxSet.has(row.parentIdx) &&
                (row.status === 'ok' || row.status === 'empty'),
            )
            .map((row) => row.parentIdx)
        : [],
    );
    const preservedRelatedRepairKeywordIds = new Set(
      mode === 'resume'
        ? store
            .loadKeywords(runId)
            .filter((item) => preservedRelatedRepairIdxs.has(item.idx))
            .map((item) => item.id)
        : [],
    );

    const planningRefreshSet = new Set([...refreshSet, ...retryRefreshKeywords]);
    if (retryOpenIdxs.length > 0) {
      console.log(`  ↻ ${retryOpenIdxs.length} retry attempt(s) in progress; stale keyword cache bypassed`);
    }

    // Expansion has an independent cache decision. A keyword-cache hit still
    // needs Chrome when its root keyword has no fresh successful/empty related
    // lookup. Related children are intentionally excluded (depth is fixed at 1).
    const expandableKeywords = new Set(
      mode === 'fresh'
        ? pendingNormalized
        : store
            .loadKeywords(runId)
            .filter(
              (item) =>
                !isTerminalKeywordStatus(item.status) &&
                !item.sources.some((source) => source.type === 'surfer_related'),
            )
            .map((item) => item.normalizedKeyword),
    );

    const plan = planRunCache(
      pendingNormalized,
      { identity, forceRefresh: effective.forceRefresh, refreshKeywords: planningRefreshSet },
      cacheStore,
      Date.now(),
      {
        expandableKeywords,
      },
      {
        enabled: runConfig.expansion.enabled && runConfig.expansion.depth >= 1,
      },
    );
    const needsBrowser = plan.needsBrowser;

    // Single cancellation signal threaded through the collector and CAPTCHA
    // helper. The CAPTCHA helper polls this instead of owning a SIGINT listener,
    // so the CLI keeps sole control of first-Ctrl+C (pause) / second-Ctrl+C
    // (force-quit).
    const signal: CancellationSignal = { isCancelled: () => pauseRequested };

    // Fresh runs are initialized in the store up front so a cancellation during
    // preflight still leaves a fully resumable run: its keywords are staged and
    // the run record exists. executeRun detects the pre-created run and continues
    // instead of recreating it, so --resume re-runs preflight and proceeds.
    if (mode === 'fresh') {
      store.createRun({
        runId,
        configSnapshot: runConfig,
        parserVersions: { surfer: SURFER_PARSER_VERSION, google: GOOGLE_PARSER_VERSION },
        input,
        keywords,
        forceRefresh: effective.forceRefresh,
        refreshKeywords: [...refreshSet],
      });
      store.setRunState(runId, 'created');
    }

    let context: BrowserContext | null = null;
    if (needsBrowser) {
      browser = await deps.connect(runConfig.browser.cdpUrl);
      console.log(`  ✓ Research Chrome connected (${runConfig.browser.cdpUrl})`);
      context = getPrimaryContext(browser);
      await deps.preflight(context, runConfig, signal);
      console.log('  ✓ Google reachable');
      console.log(`  ✓ Keyword Surfer injection detected; configured market: ${runConfig.research.market}`);
    } else if (pendingNormalized.length === 0) {
      console.log('  ✓ no keywords remain; finalizing without browser work');
    } else {
      console.log('  ✓ all pending keywords served from cache; no browser work needed');
    }

    const hooks: EngineHooks = {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      random: Math.random,
      logger: (line) => console.log(line),
      pauseRequested: () => pauseRequested,
    };

    const relatedCollector = deps.collectRelated;
    const outcome = await executeRun({
      store,
      runId,
      mode,
      keywords,
      config: runConfig,
      input,
      runDirectory,
      debugRoot,
      // collect only runs when there are pending keywords, which implies the
      // browser was connected and context assigned. Primary repair deliberately
      // suppresses a newly observed related outcome when the same parent already
      // has successful independent related evidence in the durable run.
      collect: async (record, debugRootForKeyword) => {
        const result = await deps.collect(
          context as BrowserContext,
          runConfig,
          record,
          debugRootForKeyword,
          signal,
        );
        if (!preservedRelatedRepairKeywordIds.has(record.id)) return result;
        return {
          ...result,
          related: { status: 'not_attempted', error: null, rows: [] },
        };
      },
      ...(relatedCollector
        ? {
            collectRelated: (record: KeywordRecord, debugRootForKeyword: string) =>
              relatedCollector(
                context as BrowserContext,
                runConfig,
                record,
                debugRootForKeyword,
                signal,
              ),
          }
        : {}),
      hooks,
      signal,
      // Reconcile retry journal/domain state inside the engine's existing
      // publication boundary. The engine publishes terminal artifacts before it
      // flips the run to a terminal state; doing reconciliation here preserves
      // that atomic-publication invariant and avoids an unsafe post-terminal
      // rewrite from the CLI.
      publishSnapshots: async (
        snapshotStore,
        snapshotRunId,
        snapshotDirectory,
        snapshotState,
        snapshotAhrefs,
        snapshotScoring,
      ) => {
        reconcileCompletedKeywordRetries(snapshotStore, snapshotRunId);
        await writeSnapshots(
          snapshotStore,
          snapshotRunId,
          snapshotDirectory,
          snapshotState,
          snapshotAhrefs,
          snapshotScoring,
        );
      },
      cache: {
        store: cacheStore,
        forceRefresh: effective.forceRefresh,
        // Persisted refresh semantics stay unchanged; the retry bypass is
        // already frozen into plan.resolutions for this invocation.
        refreshKeywords: refreshSet,
        resolutions: plan.resolutions,
        relatedResolutions: plan.relatedResolutions,
      },
      ...(ahrefs ? { ahrefs } : {}),
      requireAhrefs: runConfig.ahrefs.requireAhrefs,
    });

    if (outcome.kind === 'paused') {
      console.log('');
      console.log(`Run paused: ${outcome.reason}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      if (options.jsonStatus && store) {
        console.log(JSON.stringify(buildRunStatus(store, runId, runDirectory, 'paused', outcome.ahrefs ?? undefined, outcome.scoringCompleteness ?? undefined)));
      }
      return EXIT_PAUSED;
    }
    console.log('');
    console.log(`Run completed: ${outcome.state}`);
    if (outcome.ahrefs) {
      console.log(`  Ahrefs: ${outcome.ahrefs.discovered} discovered, ${outcome.ahrefs.attempted} attempted, ${outcome.ahrefs.numericCoverage} numeric DR (${outcome.ahrefs.state})`);
    }
    if (outcome.scoringCompleteness) {
      console.log(`  Scoring completeness: ${outcome.scoringCompleteness.status}`);
    }
    console.log(`  Artifacts: ${runDirectory}`);
    console.log(`  CSV: ${join(runDirectory, 'keywords.csv')}`);
    console.log(`  CSV: ${join(runDirectory, 'serp.csv')}`);
    const finalJsonStatus = options.jsonStatus && store
      ? JSON.stringify(buildRunStatus(store, runId, runDirectory, outcome.state, outcome.ahrefs, outcome.scoringCompleteness))
      : null;
    store.close();
    store = null;
    try {
      archivePath = await archiveResearchDirectory(researchDirectory);
      console.log(`  Archive: ${archivePath}`);
    } catch (archiveError) {
      const message = archiveError instanceof Error ? archiveError.message : String(archiveError);
      console.error(`  Archive warning: ${message}`);
    }
    if (finalJsonStatus) console.log(finalJsonStatus);
    return EXIT_OK;
  } catch (error) {
    console.error('');
    console.error('Run failed:');
    if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
      // A cancellation that escaped the engine's collect wrapper (e.g. during
      // preflight) is a graceful pause, not an internal failure. Leave the run
      // in a resumable state so --resume can continue from where it stopped.
      // Log the pause reason (do not swallow silently) before returning.
      console.log('');
      console.log(`Run paused (escaped ${error.code}): ${error.message}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      if (store && runId) {
        try {
          store.setRunState(runId, 'paused');
          // Publish consistent artifacts (status.json, manifest, CSVs) so the
          // paused run is inspectable and resumable rather than an empty stub.
          await writeSnapshots(store, runId, runDirectory, 'paused');
        } catch {
          /* best-effort; the run may not exist yet if cancelled before init */
        }
      }
      return EXIT_PAUSED;
    }
    if (error instanceof ResearchError) {
      console.error(`  ${error.code}: ${error.message}`);
      return exitCodeForError(error);
    }
    // A genuine internal failure: lead with a clear, actionable message rather
    // than a raw stack trace (TASK-008 / issue #16: the primary operator
    // message must never be a stack dump). The stack follows only for debugging.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  INTERNAL ERROR: ${message}`);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return EXIT_INTERNAL;
  } finally {
    store?.close();
    cacheStore?.close();
    // close() on a connectOverCDP browser only closes the CDP connection (the
    // operator's Chrome process survives); leaving it open would keep the
    // event loop alive and hang the CLI after it has returned its exit code.
    await browser?.close().catch(() => undefined);
    browser = null;
    process.off('SIGINT', onSigint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = EXIT_INTERNAL;
    },
  );
}