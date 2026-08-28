import process from 'node:process';
import { mkdir, readFile, readdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CLI_DEPS, runCli as runCliRaw, type CliDeps } from './research.js';

type RunIndexRecord = {
  version: 1;
  runId: string;
  researchDirectory: string;
  discoveryDirectory: string;
};

export async function runCliInTestLayout(
  argv: string[],
  deps: CliDeps = DEFAULT_CLI_DEPS,
  env: NodeJS.ProcessEnv = {},
): Promise<number> {
  // Tests that explicitly exercise --output-root must observe production layout
  // directly rather than going through the compatibility view below.
  if (argv.includes('--output-root')) return runCliRaw(argv, deps, env);

  const cwd = process.cwd();
  const outputRoot = join(cwd, '.test-output');
  const code = await runCliRaw([...argv, '--output-root', outputRoot], deps, env);
  await exposeLegacyTestViews(outputRoot, cwd);
  return code;
}

async function exposeLegacyTestViews(outputRoot: string, cwd: string): Promise<void> {
  const indexRoot = join(outputRoot, 'index', 'runs');
  let entries: string[];
  try {
    entries = (await readdir(indexRoot)).filter((entry) => entry.endsWith('.json'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }

  const runsRoot = join(cwd, 'runs');
  const debugRoot = join(cwd, 'debug');
  await mkdir(runsRoot, { recursive: true });
  await mkdir(debugRoot, { recursive: true });

  for (const entry of entries) {
    const record = JSON.parse(await readFile(join(indexRoot, entry), 'utf8')) as RunIndexRecord;
    await ensureDirectoryLink(record.discoveryDirectory, join(runsRoot, record.runId));
    await ensureDirectoryLink(join(record.researchDirectory, 'debug'), join(debugRoot, record.runId));
  }
}

async function ensureDirectoryLink(target: string, linkPath: string): Promise<void> {
  try {
    await symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
}
