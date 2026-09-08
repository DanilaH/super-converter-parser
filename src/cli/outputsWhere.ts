import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import { buildOutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

export function parseOutputsWhereArgs(argv: string[]): { help: boolean; json: boolean } {
  const parsed = { help: false, json: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json') parsed.json = true;
    else throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
  }
  return parsed;
}

export function renderOutputsWhere(value: Awaited<ReturnType<typeof buildOutputDiagnostics>>): string {
  return [
    'Utility Research Runner — canonical outputs',
    `  Root: ${value.canonicalRoot}`,
    `  Configured by: ${value.configuredBy}`,
    `  Researches: ${value.layout.researches}`,
    `  Index: ${value.layout.index}`,
    `  Research Library: ${value.layout.researchLibrary}`,
    `  First-party search: ${value.layout.firstPartySearch}`,
    `  Ad-hoc --output-root: ${value.overrideEscapeHatchEnabled ? 'ENABLED (escape hatch)' : 'disabled'}`,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  try {
    const args = parseOutputsWhereArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: npm run outputs:where -- [--json]');
      return;
    }
    const value = await buildOutputDiagnostics();
    process.stdout.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : renderOutputsWhere(value));
  } catch (error) {
    if (error instanceof ResearchError) {
      console.error(`${error.code}: ${error.message}`);
      process.exitCode = error.code === 'INPUT_SCHEMA_ERROR' ? 2 : 1;
      return;
    }
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
