import process from 'node:process';
import type { CancellationSignal } from '../enrichment/types.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import type {
  LoadedOperatorResearchConfig,
  ResolvedOperatorContinuation,
} from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import {
  DEFAULT_RESEARCH_RUN_DEPS,
  runResearchFromConfig,
  runResearchFromExisting,
  type ResearchRunDeps,
  type ResearchRunExecution,
} from './researchWorkflow.js';

const IN_MEMORY_CONFIG_SOURCE = '/application/operator-config.json';
const IN_MEMORY_CONTINUATION_SOURCE = '/application/continuation.json';

export type HostCancellationSignal = CancellationSignal & {
  manageProcessSignals?: boolean;
};

export type ResearchControlRuntime = {
  runFromConfig: typeof runResearchFromConfig;
  runFromExisting: typeof runResearchFromExisting;
};

export const DEFAULT_RESEARCH_CONTROL_RUNTIME: ResearchControlRuntime = {
  runFromConfig: runResearchFromConfig,
  runFromExisting: runResearchFromExisting,
};

export type ResearchControlOptions = {
  outputRoot?: string | null;
  env?: NodeJS.ProcessEnv;
  signal?: CancellationSignal;
  deps?: ResearchRunDeps;
  runtime?: ResearchControlRuntime;
  /**
   * CLI adapters own process-level signal handling by default. Long-lived hosts
   * such as the local UI server can opt out without changing research semantics.
   */
  manageProcessSignals?: boolean;
};

/** Execute a new research from an already validated/resolved config object. */
export async function executeNewResearch(
  loadedConfig: LoadedOperatorResearchConfig,
  options: ResearchControlOptions = {},
): Promise<ResearchRunExecution> {
  const env = options.env ?? process.env;
  const signal = hostSignal(options);
  const baseDeps = options.deps ?? DEFAULT_RESEARCH_RUN_DEPS;
  const deps = withDiscoverySignalPolicy(baseDeps, options.manageProcessSignals);
  const runtime = options.runtime ?? DEFAULT_RESEARCH_CONTROL_RUNTIME;
  const injectedDeps: ResearchRunDeps = {
    ...deps,
    loadOperatorConfig: async () => loadedConfig,
  };
  return runtime.runFromConfig(
    IN_MEMORY_CONFIG_SOURCE,
    options.outputRoot ?? null,
    injectedDeps,
    env,
    signal,
  );
}

/** Resume/continue an existing research from an already resolved continuation object. */
export async function executeExistingResearch(
  researchId: string,
  continuation: ResolvedOperatorContinuation | null,
  options: ResearchControlOptions = {},
): Promise<ResearchRunExecution> {
  const env = options.env ?? process.env;
  const signal = hostSignal(options);
  const baseDeps = options.deps ?? DEFAULT_RESEARCH_RUN_DEPS;
  const deps = withDiscoverySignalPolicy(baseDeps, options.manageProcessSignals);
  const runtime = options.runtime ?? DEFAULT_RESEARCH_CONTROL_RUNTIME;
  const injectedDeps: ResearchRunDeps = continuation === null
    ? deps
    : {
        ...deps,
        loadContinuation: async () => continuation,
      };
  return runtime.runFromExisting(
    researchId,
    continuation === null ? null : IN_MEMORY_CONTINUATION_SOURCE,
    options.outputRoot ?? null,
    injectedDeps,
    env,
    signal,
  );
}

/** Build the canonical read-only status projection without going through CLI rendering. */
export async function inspectResearch(
  researchId: string,
  options: Pick<ResearchControlOptions, 'outputRoot' | 'env' | 'deps'> = {},
): Promise<ResearchStatusWithHistoricalPresence> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? DEFAULT_RESEARCH_RUN_DEPS;
  const outputRoot = resolveOutputRoot(options.outputRoot ?? null, env);
  return deps.buildStatus({ outputRoot, targetRunId: researchId });
}

function hostSignal(options: ResearchControlOptions): HostCancellationSignal {
  const source = options.signal ?? { cancelled: false };
  if (options.manageProcessSignals === undefined) return source;
  return {
    get cancelled() {
      return source.cancelled;
    },
    set cancelled(value: boolean) {
      source.cancelled = value;
    },
    manageProcessSignals: options.manageProcessSignals,
  };
}

function withDiscoverySignalPolicy(
  deps: ResearchRunDeps,
  manageProcessSignals: boolean | undefined,
): ResearchRunDeps {
  if (manageProcessSignals === undefined) return deps;
  return {
    ...deps,
    runDiscovery: (request, cliDeps, env) => deps.runDiscovery(
      { ...request, manageProcessSignals },
      cliDeps,
      env,
    ),
  };
}
