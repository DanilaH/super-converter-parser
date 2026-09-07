import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFailedResearchAudit } from '../research/audit.js';
import { ResearchError } from '../shared/errors.js';
import { parseResearchAuditArgs, renderResearchAudit } from './researchAudit.js';

test('research audit CLI parses explicit target/output/json options', () => {
  assert.deepEqual(
    parseResearchAuditArgs([
      '--research',
      'run_fixture',
      '--output-root',
      '/tmp/research',
      '--json',
    ]),
    {
      help: false,
      research: 'run_fixture',
      outputRoot: '/tmp/research',
      json: true,
    },
  );
});

test('research audit CLI requires an explicit research target', () => {
  assert.throws(
    () => parseResearchAuditArgs([]),
    (error: unknown) => error instanceof ResearchError
      && error.code === 'INPUT_SCHEMA_ERROR'
      && /--research/.test(error.message),
  );
});

test('research audit renderer makes hard projection failure explicit', () => {
  const audit = buildFailedResearchAudit({
    targetResearchId: 'run_bad',
    code: 'DB_ERROR',
    message: 'fixture database cannot be opened',
  });
  const text = renderResearchAudit(audit);
  assert.match(text, /Overall: FAIL/);
  assert.match(text, /\[FAIL\] research_projection/);
  assert.match(text, /DB_ERROR/);
});
