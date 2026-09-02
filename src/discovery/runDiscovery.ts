import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { ResearchError } from '../shared/errors.js';
import { acquireDiscoveryExecutionLock } from './executionLock.js';
import {
  DEFAULT_CLI_DEPS,
  EXIT_PREFLIGHT,
  runDiscovery as runDiscoveryCore,
  type CliDeps,
  type DiscoveryRunRequest,
  type DiscoveryRunResult,
} from './runDiscoveryCore.js';

export * from './runDiscoveryCore.js';

export async function runDiscovery(
  request: DiscoveryRunRequest,
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DiscoveryRunResult> {
  let outputRoot: string;
  try {
    outputRoot = resolveOutputRoot(request.outputRoot, env);
  } catch {
    // Preserve the core runner's existing input-error mapping.
    return runDiscoveryCore(request, deps, env);
  }

  let releaseLock: (() => Promise<void>) | null = null;
  try {
    releaseLock = await acquireDiscoveryExecutionLock(outputRoot);
  } catch (error) {
    console.error('');
    console.error('Run failed:');
    if (error instanceof ResearchError) {
      console.error(`  ${error.code}: ${error.message}`);
    } else {
      console.error(`  INTERNAL ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
    const runId = request.input.kind === 'resume' ? request.input.runId : null;
    return {
      exitCode: EXIT_PREFLIGHT,
      researchId: runId,
      runId,
      researchDirectory: null,
      discoveryDirectory: null,
      state: null,
    };
  }

  try {
    return await runDiscoveryCore({ ...request, outputRoot }, deps, env);
  } finally {
    if (releaseLock !== null) {
      await releaseLock().catch((error) => {
        console.error(`Discovery execution lock release warning: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }
}
