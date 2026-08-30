import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const enrichCli = join(process.cwd(), 'src', 'cli', 'enrich.ts');
const deepModules = ['query_suggestions', 'domain_age', 'pages', 'site_structure'] as const;

for (const module of deepModules) {
  test(`enrich CLI: ${module} without shortlist fails as invalid input before source lookup`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        enrichCli,
        '--run',
        'missing-source',
        '--modules',
        module,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
      },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /require --shortlist or --shortlist-file/);
    assert.doesNotMatch(result.stderr, /Source run not found|Enrichment failed/);
  });
}

test('enrich CLI: unexpected positional argument fails before source lookup', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      enrichCli,
      '--run',
      'missing-source',
      'unexpected-positional',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unexpected positional argument: unexpected-positional/);
  assert.doesNotMatch(result.stderr, /Source run not found|Enrichment failed/);
});
