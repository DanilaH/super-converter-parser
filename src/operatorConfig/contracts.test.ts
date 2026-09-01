import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { operatorContinuationJsonSchema, operatorResearchConfigJsonSchema, validateOperatorContinuation, validateOperatorResearchConfig } from './contracts.js';
import { ResearchError } from '../shared/errors.js';

function baseConfig(): unknown {
  return { version: 1, research: { label: 'json-tools', input: { type: 'seeds', path: 'input/seeds.csv' } } };
}
function expectSchemaError(fn: () => unknown, messageFragment: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof ResearchError);
    assert.equal(error.code, 'INPUT_SCHEMA_ERROR');
    assert.ok(error.message.includes(messageFragment));
    return true;
  });
}

test('operator config accepts a minimal discovery config', () => {
  const config = validateOperatorResearchConfig(baseConfig());
  assert.equal(config.version, 1);
  assert.equal(config.research.input.type, 'seeds');
});

test('operator config rejects unsupported versions and unknown fields', () => {
  const badVersion = baseConfig() as Record<string, unknown>; badVersion.version = 2;
  expectSchemaError(() => validateOperatorResearchConfig(badVersion), '$.version');
  const unknown = baseConfig() as Record<string, unknown>; unknown.surprise = true;
  expectSchemaError(() => validateOperatorResearchConfig(unknown), '$.surprise');
});

test('operator config rejects invalid enum and numeric ranges', () => {
  expectSchemaError(() => validateOperatorResearchConfig({ ...(baseConfig() as Record<string, unknown>), workflow: { target: 'everything' } }), '$.workflow.target');
  expectSchemaError(() => validateOperatorResearchConfig({ ...(baseConfig() as Record<string, unknown>), workflow: { target: 'enrichment' }, enrichment: { modules: ['clusters'], clustering: { topN: 3, minSharedDomains: 4 } } }), 'minSharedDomains cannot exceed topN');
});

test('operator config requires stage sections for requested workflow target', () => {
  expectSchemaError(() => validateOperatorResearchConfig({ ...(baseConfig() as Record<string, unknown>), workflow: { target: 'enrichment' } }), '$.enrichment is required');
  expectSchemaError(() => validateOperatorResearchConfig({ ...(baseConfig() as Record<string, unknown>), workflow: { target: 'finalization' }, enrichment: { modules: ['clusters'] } }), '$.finalization is required');
});

test('query suggestion controls require the query_suggestions module', () => {
  expectSchemaError(() => validateOperatorResearchConfig({
    ...(baseConfig() as Record<string, unknown>),
    workflow: { target: 'enrichment' },
    enrichment: { modules: ['clusters'], querySuggestions: { maxParents: 25 } },
  }), '$.enrichment.querySuggestions requires "query_suggestions"');
});

test('operator config rejects whitespace-only semantic strings', () => {
  const blankLabel = baseConfig() as { research: { label: string } };
  blankLabel.research.label = '   ';
  expectSchemaError(() => validateOperatorResearchConfig(blankLabel), '$.research.label must not be blank');
  const blankMarket = baseConfig() as { research: { market?: string } };
  blankMarket.research.market = ' ';
  expectSchemaError(() => validateOperatorResearchConfig(blankMarket), '$.research.market must not be blank');
});

test('operator config rejects absolute machine paths', () => {
  const posix = baseConfig() as { research: { input: { path: string } } }; posix.research.input.path = '/tmp/seeds.csv';
  expectSchemaError(() => validateOperatorResearchConfig(posix), 'must be relative');
  const windows = baseConfig() as { research: { input: { path: string } } }; windows.research.input.path = 'C:\\data\\seeds.csv';
  expectSchemaError(() => validateOperatorResearchConfig(windows), 'must be relative');
});

test('continuation requires explicit research id and validates discriminated payloads', () => {
  const continuation = validateOperatorContinuation({ version: 1, researchId: 'research-123', action: { type: 'shortlist', path: 'inputs/shortlist.csv' } });
  assert.equal(continuation.researchId, 'research-123');
  assert.equal(continuation.action.type, 'shortlist');
  expectSchemaError(() => validateOperatorContinuation({ version: 1, researchId: 'research-123', action: { type: 'traffic', path: 'traffic.csv' } }), 'lowBaseOrganicTrafficThreshold');
  expectSchemaError(() => validateOperatorContinuation({ version: 1, researchId: ' ', action: { type: 'finalists_all' } }), '$.researchId must not be blank');
});

test('committed JSON schemas stay synchronized with runtime contracts', async () => {
  const researchArtifact = JSON.parse(await readFile(resolve('schemas/operator-research-config-v1.schema.json'), 'utf8')) as unknown;
  const continuationArtifact = JSON.parse(await readFile(resolve('schemas/operator-continuation-v1.schema.json'), 'utf8')) as unknown;
  assert.deepEqual(researchArtifact, operatorResearchConfigJsonSchema());
  assert.deepEqual(continuationArtifact, operatorContinuationJsonSchema());
});
