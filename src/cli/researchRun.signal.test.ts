import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_RESEARCH_RUN_DEPS, runResearchRunCli } from './researchRun.js';

test('research:run does not install a competing SIGINT listener during discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-run-signal-'));
  const configPath = join(root, 'research.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    research: { label: 'signal-owner', input: { type: 'seeds', path: 'seeds.csv' } },
    workflow: { target: 'discovery' },
  }), 'utf8');

  const baseline = process.listenerCount('SIGINT');
  let observedDuringDiscovery = -1;
  const exitCode = await runResearchRunCli(
    ['--config', configPath],
    {
      ...DEFAULT_RESEARCH_RUN_DEPS,
      runDiscovery: async () => {
        observedDuringDiscovery = process.listenerCount('SIGINT');
        return {
          exitCode: 0,
          researchId: 'research-1',
          runId: 'research-1',
          researchDirectory: root,
          discoveryDirectory: join(root, 'discovery'),
          state: 'completed',
        };
      },
    },
    {} as NodeJS.ProcessEnv,
  );

  assert.equal(exitCode, 0);
  assert.equal(observedDuringDiscovery, baseline);
  assert.equal(process.listenerCount('SIGINT'), baseline);
});
