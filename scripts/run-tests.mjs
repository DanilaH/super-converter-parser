import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

async function collectTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

const testFiles = (await collectTestFiles('src')).sort();

if (testFiles.length === 0) {
  console.error('No TypeScript test files found under src/.');
  process.exit(1);
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...testFiles], {
  stdio: 'inherit',
  env: {
    ...process.env,
    // Integration tests intentionally use isolated temporary output roots.
    // Production keeps ad-hoc overrides fail-closed unless this escape hatch is
    // explicitly enabled by the caller.
    RESEARCH_ALLOW_OUTPUT_ROOT_OVERRIDE: 'true',
  },
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
