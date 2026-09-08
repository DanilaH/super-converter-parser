import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadDotEnv } from '../config/env.js';
import { buildOutputDiagnostics } from '../outputs/outputDiagnostics.js';
import { ResearchError } from '../shared/errors.js';

loadDotEnv();

export function parseOutputsDoctorArgs(argv: string[]): { help: boolean; json: boolean } {
  const parsed = { help: false, json: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--json') parsed.json = true;
    else throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown argument: ${arg}`);
  }
  return parsed;
}

export function renderOutputsDoctor(value: Awaited<ReturnType<typeof buildOutputDiagnostics>>): string {
  const lines = [
    'Utility Research Runner — output diagnostics',
    `  Canonical root: ${value.canonicalRoot}`,
    `  Root exists: ${value.rootExists ? 'yes' : 'no (created on first write)'}`,
    `  Researches namespace exists: ${value.researchesDirectoryExists ? 'yes' : 'no (created on first new research)'}`,
    `  Ad-hoc --output-root: ${value.overrideEscapeHatchEnabled ? 'ENABLED (escape hatch)' : 'disabled'}`,
  ];
  if (value.repoLocalLegacyDirectories.length === 0) {
    lines.push('  Repo-local legacy output directories: none detected');
  } else {
    lines.push('  Repo-local legacy output directories:');
    for (const path of value.repoLocalLegacyDirectories) lines.push(`    WARN ${path}`);
  }
  lines.push('');
  lines.push('New writes must use the canonical root. Existing indexed/legacy outputs remain readable; no automatic migration is performed.');
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  try {
    const args = parseOutputsDoctorArgs(process.argv.slice(2));
    if (args.help) {
      console.log('Usage: npm run outputs:doctor -- [--json]');
      return;
    }
    const value = await buildOutputDiagnostics();
    process.stdout.write(args.json ? `${JSON.stringify(value, null, 2)}\n` : renderOutputsDoctor(value));
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
