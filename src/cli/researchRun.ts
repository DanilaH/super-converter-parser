import process from 'node:process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import {
  archiveResearchDirectory,
  resolveOutputRoot,
  resolveRunLocation,
} from '../outputs/researchLayout.js';
import {
  loadOperatorResearchConfig,
  type LoadedOperatorResearchConfig,
  type ResolvedResearchSemantics,
} from '../operatorConfig/resolve.js';
import { writeOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import { ResearchError } from '../shared/errors.js';
import {
  DEFAULT_CLI_DEPS,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  EXIT_PREFLIGHT,
  runCli as runDiscoveryCli,
  type CliDeps,
} from './research.js';

loadDotEnv();

type ParsedArgs = {
  help: boolean;
  config: string | null;
  outputRoot: string | null;
};

export type ResearchRunDeps = {
  loadOperatorConfig: typeof loadOperatorResearchConfig;
  runDiscovery: typeof runDiscoveryCli;
  cliDeps: CliDeps;
  writeProvenance: typeof writeOperatorConfigProvenance;
  resolveRun: typeof resolveRunLocation;
  archiveResearch: typeof archiveResearchDirectory;
};

export const DEFAULT_RESEARCH_RUN_DEPS: ResearchRunDeps = {
  loadOperatorConfig: loadOperatorResearchConfig,
  runDiscovery: runDiscoveryCli,
  cliDeps: DEFAULT_CLI_DEPS,
  writeProvenance: writeOperatorConfigProvenance,
  resolveRun: resolveRunLocation,
  archiveResearch: archiveResearchDirectory,
};

export function parseResearchRunArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, config: null, outputRoot: null };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--config') parsed.config = nextValue(args, '--config');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help && parsed.config === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--config <research.config.json> is required.');
  }
  return parsed;
}

export function buildDiscoveryExecutionEnv(
  env: NodeJS.ProcessEnv,
  semantics: ResolvedResearchSemantics,
): NodeJS.ProcessEnv {
  return {
    ...env,
    RESEARCH_MARKET: semantics.research.market,
    GOOGLE_HL: semantics.research.googleHl,
    GOOGLE_GL: semantics.research.googleGl,
    TOP_N: String(semantics.discovery.topN),
    EXPANSION_ENABLED: String(semantics.discovery.expand),
    EXPANSION_DEPTH: String(semantics.discovery.expansionPolicy.depth),
    EXPANSION_MAX_CANDIDATES: String(semantics.discovery.expansionPolicy.maxCandidatesPerKeyword),
    EXPANSION_MIN_OVERLAP: String(semantics.discovery.expansionPolicy.minOverlap),
    EXPANSION_MIN_VOLUME: String(semantics.discovery.expansionPolicy.minVolume),
    REQUIRE_AHREFS: String(semantics.discovery.requireAhrefs),
  };
}

export async function runResearchRunCli(
  argv: string[],
  deps: ResearchRunDeps = DEFAULT_RESEARCH_RUN_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  try {
    const parsed = parseResearchRunArgs(argv);
    if (parsed.help) {
      process.stdout.write(usage());
      return EXIT_OK;
    }

    const loaded = await deps.loadOperatorConfig(parsed.config as string);
    const outputRoot = resolveOutputRoot(parsed.outputRoot, env);
    const beforeRuns = await listIndexedRunIds(outputRoot);
    const executionEnv = buildDiscoveryExecutionEnv(env, loaded.plan.semantics);
    const input = loaded.plan.semantics.research.input;
    const discoveryArgs = [
      input.type === 'microsoft' ? '--microsoft' : '--seeds',
      input.resolvedPath,
      '--name',
      loaded.plan.semantics.research.label,
      '--output-root',
      outputRoot,
    ];

    console.log('Config-first research run');
    console.log(`  Config fingerprint: ${loaded.plan.effectiveConfigFingerprint}`);
    console.log(`  Workflow target: ${loaded.plan.semantics.workflow.target}`);
    console.log('  Executing stage: discovery');
    console.log('');

    const discoveryCode = await deps.runDiscovery(discoveryArgs, deps.cliDeps, executionEnv);
    const afterRuns = await listIndexedRunIds(outputRoot);
    const createdRunIds = [...afterRuns].filter((runId) => !beforeRuns.has(runId)).sort();

    if (createdRunIds.length === 0) {
      if (discoveryCode === EXIT_OK) {
        throw new ResearchError(
          'OUTPUT_WRITE_ERROR',
          'Discovery reported success but no new indexed run was created; operator config provenance cannot be parented safely.',
        );
      }
      return discoveryCode;
    }
    if (createdRunIds.length !== 1) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Observed ${createdRunIds.length} new indexed runs while executing one config. Refusing to guess which run owns operator config provenance. Do not start concurrent fresh research in the same output root.`,
      );
    }

    const runId = createdRunIds[0] as string;
    const location = await deps.resolveRun(outputRoot, runId);
    await deps.writeProvenance(location.researchDirectory, loaded);
    console.log('');
    console.log(`  Research ID: ${runId}`);
    console.log(`  Operator config: ${join(location.researchDirectory, 'operator-config.json')}`);

    if (discoveryCode === EXIT_OK) {
      try {
        await deps.archiveResearch(location.researchDirectory);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`  Archive warning after operator-config publication: ${message}`);
      }
      if (loaded.plan.semantics.workflow.target !== 'discovery') {
        console.log(`  Stop point: discovery complete; ${loaded.plan.semantics.workflow.target} execution remains gated for a later stage.`);
        console.log(`  Inspect next state with: npm run research:plan -- --research ${runId}`);
      }
    }
    return discoveryCode;
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      return error.code === 'INPUT_SCHEMA_ERROR'
        ? EXIT_INVALID_INPUT
        : error.code === 'OUTPUT_WRITE_ERROR'
          ? EXIT_PREFLIGHT
          : EXIT_INTERNAL;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return EXIT_INTERNAL;
  }
}

async function listIndexedRunIds(outputRoot: string): Promise<Set<string>> {
  const directory = join(outputRoot, 'index', 'runs');
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return new Set();
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to inspect run index ${directory}.`, { cause: error });
  }
  return new Set(entries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length)));
}

function nextValue(args: string[], option: string): string {
  const value = args.shift();
  if (!value || value.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `${option} requires a value.`);
  return value;
}

function usage(): string {
  return [
    'Utility Research Runner — config-first discovery execution',
    '',
    'Usage:',
    '  npm run research:run -- --config <research.config.json>',
    '  npm run research:run -- --config <research.config.json> --output-root <absolute-path>',
    '',
    'This PR executes discovery only. Enrichment/finalization intent is preserved in immutable operator-config provenance and remains gated after discovery.',
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  process.exitCode = await runResearchRunCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
