import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { runResearchRunCli } from '../application/researchWorkflow.js';

export * from '../application/researchWorkflow.js';

async function main(): Promise<void> {
  process.exitCode = await runResearchRunCli(process.argv.slice(2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
