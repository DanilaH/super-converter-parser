import { join, resolve } from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import { createAhrefsClient, type AhrefsClient } from '../ahrefs/client.js';
import { collectKeyword, collectRelatedKeyword, type CollectionResult, type RelatedCollectionResult } from '../browser/collect.js';
import type { CancellationSignal } from '../browser/captcha.js';
import { connectResearchChrome, getPrimaryContext } from '../browser/cdp.js';
import { preflightGoogleAndSurfer } from '../browser/preflight.js';
import { keywordCacheIdentity } from '../cache/keys.js';
import { mergedCacheRefresh, planRunCache } from '../cache/resolve.js';
import { CacheStore } from '../cache/store.js';
import { loadConfig, type ResearchConfig } from '../config/config.js';
import { loadMicrosoftRows } from '../input/microsoft/load.js';
import { buildMicrosoftKeywords, type MicrosoftKeyword } from '../input/microsoft/normalize.js';
import { loadSeedRows } from '../input/seeds/load.js';
import { buildSeedKeywords, normalizeKeyword, type SeedKeyword } from '../input/seeds/normalize.js';
import { GOOGLE_PARSER_VERSION } from '../google/serp.js';
import { archiveResearchDirectory, allocateResearchLocation, resolveOutputRoot, resolveRunLocation, writeRunIndex } from '../outputs/researchLayout.js';
import { loadOpenKeywordRetryIndexes, reconcileCompletedKeywordRetries } from '../db/retryAttempts.js';
import { RunStore, isTerminalKeywordStatus } from '../db/store.js';
import { executeRun, validateResume, type EngineHooks } from '../runs/engine.js';
import { applyFailedKeywordRetryPreparation, prepareFailedKeywordRetry, type FailedKeywordRetryPreparation } from '../runs/retryFailed.js';
import { createRunId, ensureWritableDirectory, type KeywordRecord } from '../runs/run.js';
import { buildRunStatus, writeSnapshots } from '../runs/snapshots.js';
import { ResearchError } from '../shared/errors.js';
import { SURFER_PARSER_VERSION } from '../surfer/selectors.js';

export const EXIT_OK = 0;
export const EXIT_INTERNAL = 1;
export const EXIT_INVALID_INPUT = 2;
export const EXIT_PREFLIGHT = 3;
export const EXIT_PAUSED = 130;

export type DiscoverySemanticConfig = {
  research: ResearchConfig['research'];
  expansion: ResearchConfig['expansion'];
  requireAhrefs: boolean;
  scoring: ResearchConfig['scoring'];
};

export type DiscoveryRunRequest = {
  input:
    | { kind: 'seeds'; path: string }
    | { kind: 'microsoft'; path: string }
    | { kind: 'resume'; runId: string };
  retryFailed?: boolean;
  forceRefresh?: boolean;
  refreshKeywords?: string[];
  expand?: boolean;
  jsonStatus?: boolean;
  requireAhrefs?: boolean;
  outputRoot?: string | null;
  name?: string | null;
  semanticConfig?: DiscoverySemanticConfig | null;
  onFreshResearchInitialized?: ((context: {
    runId: string;
    researchDirectory: string;
    discoveryDirectory: string;
  }) => void | Promise<void>) | null;
};

export type DiscoveryRunResult = {
  exitCode: number;
  researchId: string | null;
  runId: string | null;
  researchDirectory: string | null;
  discoveryDirectory: string | null;
  state: string | null;
};

export type CliDeps = {
  connect: (cdpUrl: string) => Promise<Browser>;
  preflight: (context: BrowserContext, config: ResearchConfig, signal: CancellationSignal) => Promise<void>;
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
  return {
    ...current,
    research: persisted.research,
    expansion: persisted.expansion,
    ahrefs: { ...current.ahrefs, requireAhrefs: persisted.ahrefs.requireAhrefs ?? false },
    browser: { ...current.browser, surferRelatedWidgetSelector: persisted.browser.surferRelatedWidgetSelector },
    scoring: persisted.scoring,
  };
}

export async function runDiscovery(
  request: DiscoveryRunRequest,
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryRunResult> {
  const retryFailed = request.retryFailed ?? false;
  const forceRefresh = request.forceRefresh ?? false;
  const rawRefreshKeywords = request.refreshKeywords ?? [];
  const jsonStatus = request.jsonStatus ?? false;
  const isResume = request.input.kind === 'resume';
  if (retryFailed && !isResume) {
    console.error('--retry-failed requires a resume request.');
    return emptyResult(EXIT_INVALID_INPUT);
  }
  if (isResume && request.semanticConfig) {
    console.error('A resume request cannot replace persisted discovery semantics.');
    return emptyResult(EXIT_INVALID_INPUT);
  }

  let pauseRequested = false;
  let sigintCount = 0;
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
  let terminalState: string | null = null;

  const currentResult = (exitCode: number): DiscoveryRunResult => ({
    exitCode,
    researchId: runId || null,
    runId: runId || null,
    researchDirectory: researchDirectory || null,
    discoveryDirectory: runDirectory || null,
    state: terminalState,
  });

  try {
    const config = loadConfig(env);
    let mode: 'fresh' | 'resume';
    let keywords: SeedKeyword[] | MicrosoftKeyword[] = [];
    let input: { kind: 'seeds' | 'microsoft'; path: string };
    let refreshKeywords: string[] = [];
    let runConfig = config;
    let ahrefsApiKey: string | null = null;
    const outputRoot = resolveOutputRoot(request.outputRoot, env);

    if (!isResume) {
      if (request.semanticConfig) {
        runConfig = {
          ...runConfig,
          research: request.semanticConfig.research,
          expansion: request.semanticConfig.expansion,
          ahrefs: { ...runConfig.ahrefs, requireAhrefs: request.semanticConfig.requireAhrefs },
          scoring: request.semanticConfig.scoring,
        };
      } else {
        if (request.expand) runConfig = { ...runConfig, expansion: { ...runConfig.expansion, enabled: true } };
        if (request.requireAhrefs) runConfig = { ...runConfig, ahrefs: { ...runConfig.ahrefs, requireAhrefs: true } };
      }
    }

    const validateAhrefsRequirement = (candidateConfig: ResearchConfig): string | null => {
      const rawKey = (env.AHREFS_API_KEY ?? '').trim();
      const key = rawKey.length > 0 ? rawKey : null;
      if (candidateConfig.ahrefs.requireAhrefs && !key) {
        throw new ResearchError(
          'AHREFS_REQUIRE_CONFIG',
          'Ahrefs DR is required but AHREFS_API_KEY is not set. Export AHREFS_API_KEY and retry.',
        );
      }
      return key;
    };

    if (isResume) {
      runId = request.input.runId;
      const location = await resolveRunLocation(outputRoot, runId);
      runDirectory = location.discoveryDirectory;
      researchDirectory = location.researchDirectory;
      archivePath = location.archivePath;
      debugRoot = location.legacy ? resolve(process.cwd(), 'debug', runId) : join(researchDirectory, 'debug');
      mode = 'resume';
      store = RunStore.open(join(runDirectory, 'run.sqlite'));

      const recoveredRetryIdxs = reconcileCompletedKeywordRetries(store, runId);
      let retryPreparation: FailedKeywordRetryPreparation | null = null;
      if (retryFailed) retryPreparation = prepareFailedKeywordRetry(store, runId);
      const run = retryPreparation?.run ?? validateResume(store, runId);
      runConfig = effectiveConfigForResume(config, run.configSnapshot, runId);
      input = run.input;
      refreshKeywords = validateRefreshKeywords(rawRefreshKeywords, store.loadKeywords(runId).map((item) => item.normalizedKeyword));
      ahrefsApiKey = validateAhrefsRequirement(runConfig);
      cacheStore = CacheStore.open(runConfig.cache.path);

      console.log('Utility Research Runner');
      console.log('');
      console.log(`[resume] ${runId} (state: ${run.state}, parser ${run.parserVersions.surfer}/${run.parserVersions.google})`);
      if (recoveredRetryIdxs.length > 0) console.log(`  ✓ recovered ${recoveredRetryIdxs.length} completed retry journal checkpoint(s)`);
      await ensureWritableDirectory(runDirectory);
      console.log(`  ✓ ${runDirectory} writable`);
      await ensureWritableDirectory(debugRoot);
      console.log(`  ✓ ${debugRoot} writable`);
      console.log(`  ✓ cache ${runConfig.cache.path} opened (schema v${cacheStore.version})`);

      if (retryPreparation) {
        const reopenedRetryIdxs = applyFailedKeywordRetryPreparation(store, retryPreparation);
        if (reopenedRetryIdxs.length > 0) {
          validateResume(store, runId);
          console.log(`  ↻ reopened ${reopenedRetryIdxs.length} repairable keyword checkpoint(s)`);
        } else if (retryPreparation.openKeywordIdxs.length > 0) {
          validateResume(store, runId);
          console.log(`  ↻ continuing ${retryPreparation.openKeywordIdxs.length} open retry attempt(s)`);
        }
      }
      console.log('');
    } else {
      mode = 'fresh';
      input = { kind: request.input.kind, path: request.input.path };
      if (request.input.kind === 'microsoft') {
        const rows = await loadMicrosoftRows(request.input.path);
        keywords = buildMicrosoftKeywords(rows);
        console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords (Microsoft)`);
      } else {
        const rows = await loadSeedRows(request.input.path);
        keywords = buildSeedKeywords(rows);
        console.log(`  Input: ${rows.length} rows, ${keywords.length} unique keywords`);
      }
      if (keywords.length === 0) throw new ResearchError('INPUT_SCHEMA_ERROR', 'Input contains no research keywords.');
      refreshKeywords = validateRefreshKeywords(rawRefreshKeywords, keywords.map((item) => item.normalizedKeyword));
      ahrefsApiKey = validateAhrefsRequirement(runConfig);
      cacheStore = CacheStore.open(runConfig.cache.path);

      runId = createRunId();
      const location = await allocateResearchLocation(outputRoot, request.name ?? keywords[0]!.keyword);
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

    if (!cacheStore) throw new ResearchError('CACHE_DB_ERROR', 'Cache store was not initialized.');

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

    const pendingNormalized = mode === 'fresh'
      ? keywords.map((item) => item.normalizedKeyword)
      : store.loadKeywords(runId).filter((item) => !isTerminalKeywordStatus(item.status)).map((item) => item.normalizedKeyword);
    const identity = keywordCacheIdentity(runConfig);
    const persisted = mode === 'resume'
      ? (store.loadRun(runId) ?? { forceRefresh: false, refreshKeywords: [] })
      : { forceRefresh: false, refreshKeywords: [] };
    const effective = mergedCacheRefresh(
      { forceRefresh, refreshKeywords: new Set(refreshKeywords) },
      persisted,
    );
    const refreshSet = new Set(effective.refreshKeywords);
    const retryOpenIdxs = mode === 'resume' ? loadOpenKeywordRetryIndexes(store, runId) : [];
    const retryOpenIdxSet = new Set(retryOpenIdxs);
    const retryRefreshKeywords = mode === 'resume'
      ? store.loadKeywords(runId).filter((item) => retryOpenIdxSet.has(item.idx)).map((item) => item.normalizedKeyword)
      : [];

    const preservedRelatedRepairIdxs = new Set(
      mode === 'resume'
        ? store.loadRelatedKeywords(runId)
            .filter((row) => retryOpenIdxSet.has(row.parentIdx) && (row.status === 'ok' || row.status === 'empty'))
            .map((row) => row.parentIdx)
        : [],
    );
    const preservedRelatedRepairKeywordIds = new Set(
      mode === 'resume'
        ? store.loadKeywords(runId).filter((item) => preservedRelatedRepairIdxs.has(item.idx)).map((item) => item.id)
        : [],
    );

    const planningRefreshSet = new Set([...refreshSet, ...retryRefreshKeywords]);
    if (retryOpenIdxs.length > 0) console.log(`  ↻ ${retryOpenIdxs.length} retry attempt(s) in progress; stale keyword cache bypassed`);

    const expandableKeywords = new Set(
      mode === 'fresh'
        ? pendingNormalized
        : store.loadKeywords(runId)
            .filter((item) => !isTerminalKeywordStatus(item.status) && !item.sources.some((source) => source.type === 'surfer_related'))
            .map((item) => item.normalizedKeyword),
    );

    const plan = planRunCache(
      pendingNormalized,
      { identity, forceRefresh: effective.forceRefresh, refreshKeywords: planningRefreshSet },
      cacheStore,
      Date.now(),
      { expandableKeywords },
      { enabled: runConfig.expansion.enabled && runConfig.expansion.depth >= 1 },
    );
    const needsBrowser = plan.needsBrowser;
    const signal: CancellationSignal = { isCancelled: () => pauseRequested };

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
      if (request.onFreshResearchInitialized) {
        await request.onFreshResearchInitialized({ runId, researchDirectory, discoveryDirectory: runDirectory });
      }
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
      sleep: (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
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
      collect: async (record, debugRootForKeyword) => {
        const result = await deps.collect(context as BrowserContext, runConfig, record, debugRootForKeyword, signal);
        if (!preservedRelatedRepairKeywordIds.has(record.id)) return result;
        return { ...result, related: { status: 'not_attempted', error: null, rows: [] } };
      },
      ...(relatedCollector
        ? {
            collectRelated: (record: KeywordRecord, debugRootForKeyword: string) =>
              relatedCollector(context as BrowserContext, runConfig, record, debugRootForKeyword, signal),
          }
        : {}),
      hooks,
      signal,
      publishSnapshots: async (
        snapshotStore,
        snapshotRunId,
        snapshotDirectory,
        snapshotState,
        snapshotAhrefs,
        snapshotScoring,
      ) => {
        reconcileCompletedKeywordRetries(snapshotStore, snapshotRunId);
        await writeSnapshots(snapshotStore, snapshotRunId, snapshotDirectory, snapshotState, snapshotAhrefs, snapshotScoring);
      },
      cache: {
        store: cacheStore,
        forceRefresh: effective.forceRefresh,
        refreshKeywords: refreshSet,
        resolutions: plan.resolutions,
        relatedResolutions: plan.relatedResolutions,
      },
      ...(ahrefs ? { ahrefs } : {}),
      requireAhrefs: runConfig.ahrefs.requireAhrefs,
    });

    if (outcome.kind === 'paused') {
      terminalState = 'paused';
      console.log('');
      console.log(`Run paused: ${outcome.reason}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      if (jsonStatus && store) console.log(JSON.stringify(buildRunStatus(store, runId, runDirectory, 'paused', outcome.ahrefs ?? undefined, outcome.scoringCompleteness ?? undefined)));
      return currentResult(EXIT_PAUSED);
    }

    terminalState = outcome.state;
    console.log('');
    console.log(`Run completed: ${outcome.state}`);
    if (outcome.ahrefs) console.log(`  Ahrefs: ${outcome.ahrefs.discovered} discovered, ${outcome.ahrefs.attempted} attempted, ${outcome.ahrefs.numericCoverage} numeric DR (${outcome.ahrefs.state})`);
    if (outcome.scoringCompleteness) console.log(`  Scoring completeness: ${outcome.scoringCompleteness.status}`);
    console.log(`  Artifacts: ${runDirectory}`);
    console.log(`  CSV: ${join(runDirectory, 'keywords.csv')}`);
    console.log(`  CSV: ${join(runDirectory, 'serp.csv')}`);
    const finalJsonStatus = jsonStatus && store
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
    return currentResult(EXIT_OK);
  } catch (error) {
    console.error('');
    console.error('Run failed:');
    if (error instanceof ResearchError && error.code === 'RUN_PAUSED') {
      terminalState = 'paused';
      console.log('');
      console.log(`Run paused (escaped ${error.code}): ${error.message}`);
      console.log('Resume with:');
      console.log(`  npm run research -- --resume ${runId}`);
      if (store && runId) {
        try {
          store.setRunState(runId, 'paused');
          await writeSnapshots(store, runId, runDirectory, 'paused');
        } catch {
          // Best effort: the run may not exist yet if cancelled before initialization.
        }
      }
      return currentResult(EXIT_PAUSED);
    }
    if (error instanceof ResearchError) {
      console.error(`  ${error.code}: ${error.message}`);
      return currentResult(exitCodeForError(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  INTERNAL ERROR: ${message}`);
    if (error instanceof Error && error.stack) console.error(error.stack);
    return currentResult(EXIT_INTERNAL);
  } finally {
    store?.close();
    cacheStore?.close();
    await browser?.close().catch(() => undefined);
    browser = null;
    process.off('SIGINT', onSigint);
  }
}

function emptyResult(exitCode: number): DiscoveryRunResult {
  return { exitCode, researchId: null, runId: null, researchDirectory: null, discoveryDirectory: null, state: null };
}

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
