import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Browser } from 'playwright-core';
import type { CliDeps } from '../discovery/runDiscovery.js';
import { ResearchError } from '../shared/errors.js';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchFromConfig } from './researchRun.js';

test('config-first run rolls back indexed research when required provenance publication fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-provenance-rollback-'));
  const configDir = join(root, 'config');
  const outputRoot = join(root, 'output');
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, 'seeds.csv'), 'keyword\njson diff\n', 'utf8');
  const configPath = join(configDir, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'rollback', input: { type: 'seeds', path: 'seeds.csv' } },
  }), 'utf8');

  let connectCalls = 0;
  let allocatedResearchDirectory: string | null = null;
  const cliDeps: CliDeps = {
    connect: async () => {
      connectCalls += 1;
      return ({ contexts: () => [{}], close: async () => undefined }) as unknown as Browser;
    },
    preflight: async () => undefined,
    collect: async () => { throw new Error('provider work must not start'); },
  };

  const execution = await runResearchFromConfig(
    configPath,
    outputRoot,
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      cliDeps,
      writeProvenance: async (researchDirectory) => {
        allocatedResearchDirectory = researchDirectory;
        throw new ResearchError('OUTPUT_WRITE_ERROR', 'synthetic provenance failure');
      },
    },
    { CACHE_DB_PATH: join(root, 'cache.sqlite') } as NodeJS.ProcessEnv,
  );

  assert.equal(execution.exitCode, 3);
  assert.equal(execution.result.researchId, null);
  assert.equal(execution.result.discoveryRunId, null);
  assert.equal(connectCalls, 0);
  assert.ok(allocatedResearchDirectory);
  await assert.rejects(access(allocatedResearchDirectory));

  const runIndexDirectory = join(outputRoot, 'index', 'runs');
  const indexedRuns = await readdir(runIndexDirectory).catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  assert.deepEqual(indexedRuns.filter((entry) => entry.endsWith('.json')), []);
});
