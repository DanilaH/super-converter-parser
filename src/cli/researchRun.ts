import process from 'node:process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import {
  DEFAULT_CLI_DEPS,
  EXIT_INTERNAL,
  EXIT_INVALID_INPUT,
  EXIT_OK,
  runDiscovery,
  type CliDeps,
  type DiscoveryRunResult,
  type DiscoverySemanticConfig,
} from '../discovery/runDiscovery.js';
import { writeOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import {
  loadOperatorResearchConfig,
  type LoadedOperatorResearchConfig,
} from '../operatorConfig/resolve.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

type ParsedArgs = {
  help: boolean;
  config: string | null;
  outputRoot: string | null;
  json: boolean;
};

export type ResearchRunMachineResultV1 = {
  version: 1;
  exitCode: number;
  researchId: string | null;
  discoveryRunId: string | null;
  discoveryState: string | null;
  workflowTarget: 'discovery' | 'enrichment' | 'finalization';
  effectiveConfigFingerprint: string;
  stageFingerprints: LoadedOperatorResearchConfig['plan']['stageFingerprints'];
  operatorConfigPath: string | null;
};

export type ResearchRunExecution = {
  exitCode: number;
  result: ResearchRunMachineResultV1;
};

export type ResearchRunDeps = {
  loadOperatorConfig: typeof loadOperatorResearchConfig;
  runDiscovery: typeof runDiscovery;
  cliDeps: CliDeps;
  writeProvenance: typeof writeOperatorConfigProvenance;
};

export const DEFAULT_RESEARCH_RUN_DEPS: ResearchRunDeps = {
  loadOperatorConfig: loadOperatorResearchConfig,
  runDiscovery,
  cliDeps: DEFAULT_CLI_DEPS,
  writeProvenance: writeOperatorConfigProvenance,
};

export function parseResearchRunArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  const parsed: ParsedArgs = { help: false, config: null, outputRoot: null, json: false };
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--config') parsed.config = nextValue(args, '--config');
    else if (arg === '--output-root') parsed.outputRoot = nextValue(args, '--output-root');
    else if (arg === '--json') parsed.json = true;
    else if (arg?.startsWith('-')) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
    else if (arg) throw new ResearchError('INPUT_SCHEMA_ERROR', `Unexpected positional argument: ${arg}`);
  }
  if (!parsed.help && parsed.config === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '--config <research.config.json> is required.');
  }
  return parsed;
}

export async function runResearchFromConfig(
  configPath: string,
  outputRoot: string | null,
  deps: ResearchRunDeps = DEFAULT_RESEARCH_RUN_DEPS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResearchRunExecution> {
  const loaded = await deps.loadOperatorConfig(configPath);
  const semantics = loaded.plan.semantics;
  const input = semantics.research.input;
  const semanticConfig = discoverySemanticConfig(loaded);

  console.log('Config-first research run');
  console.log(`  Config fingerprint: ${loaded.plan.effectiveConfigFingerprint}`);
  console.log(`  Workflow target: ${semantics.workflow.target}`);
  console.log('  Executing stage: discovery');
  console.log('');

  const discovery = await deps.runDiscovery(
    {
      input: input.type === 'microsoft'
        ? { kind: 'microsoft', path: input.resolvedPath }
        : { kind: 'seeds', path: input.resolvedPath },
      outputRoot,
      name: semantics.research.label,
      semanticConfig,
      onFreshResearchInitialized: async ({ researchDirectory }) => {
        await deps.writeProvenance(researchDirectory, loaded);
      },
    },
    deps.cliDeps,
    env,
  );

  const result = machineResult(loaded, discovery);
  if (discovery.runId) {
    console.log('');
    console.log(`  Research ID: ${discovery.runId}`);
    if (discovery.researchDirectory) console.log(`  Operator config: ${join(discovery.researchDirectory, 'operator-config.json')}`);
    if (discovery.exitCode === EXIT_OK && semantics.workflow.target !== 'discovery') {
      console.log(`  Stop point: discovery complete; ${semantics.workflow.target} execution remains gated for a later PR.`);
      console.log(`  Inspect next state with: npm run research:plan -- --research ${discovery.runId}`);
    }
  }
  return { exitCode: discovery.exitCode, result };
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
    const execution = await runResearchFromConfig(parsed.config as string, parsed.outputRoot, deps, env);
    if (parsed.json) console.log(JSON.stringify(execution.result));
    return execution.exitCode;
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      return error.code === 'INPUT_SCHEMA_ERROR' ? EXIT_INVALID_INPUT : EXIT_INTERNAL;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return EXIT_INTERNAL;
  }
}

function discoverySemanticConfig(loaded: LoadedOperatorResearchConfig): DiscoverySemanticConfig {
  const semantics = loaded.plan.semantics;
  return {
    research: {
      market: semantics.research.market,
      googleHl: semantics.research.googleHl,
      googleGl: semantics.research.googleGl,
      topN: semantics.discovery.topN,
    },
    expansion: {
      enabled: semantics.discovery.expand,
      depth: semantics.discovery.expansionPolicy.depth,
      maxCandidatesPerKeyword: semantics.discovery.expansionPolicy.maxCandidatesPerKeyword,
      minOverlap: semantics.discovery.expansionPolicy.minOverlap,
      minVolume: semantics.discovery.expansionPolicy.minVolume,
    },
    requireAhrefs: semantics.discovery.requireAhrefs,
    scoring: { drThresholds: { ...semantics.discovery.scoringPolicy } },
  };
}

function machineResult(
  loaded: LoadedOperatorResearchConfig,
  discovery: DiscoveryRunResult,
): ResearchRunMachineResultV1 {
  return {
    version: 1,
    exitCode: discovery.exitCode,
    researchId: discovery.researchId,
    discoveryRunId: discovery.runId,
    discoveryState: discovery.state,
    workflowTarget: loaded.plan.semantics.workflow.target,
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    stageFingerprints: loaded.plan.stageFingerprints,
    operatorConfigPath: discovery.researchDirectory === null
      ? null
      : join(discovery.researchDirectory, 'operator-config.json'),
  };
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
    '  npm run research:run -- --config <research.config.json> --json',
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
