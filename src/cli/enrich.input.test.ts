import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const deepModules = ['query_suggestions', 'domain_age', 'pages', 'site_structure'] as const;

for (const module of deepModules) {
  test(`enrich CLI: ${module} without shortlist fails as invalid input before source lookup`, () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(process.cwd(), 'src', 'cli', 'enrich.ts'),
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
