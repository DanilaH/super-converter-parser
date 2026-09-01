import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import type {
  OperatorResearchConfigFileV1,
  OperatorResearchPresetV1,
} from './contracts.js';
import {
  loadOperatorResearchPreset,
  mergeOperatorResearchConfig,
} from './presets.js';
import {
  buildLoadedOperatorResearchConfig,
  buildNewResearchPlan,
} from './resolve.js';

function deepPreset(): OperatorResearchPresetV1 {
  return {
    version: 1,
    id: 'deep-research',
    revision: 7,
    overlay: {
      workflow: { target: 'finalization' },
      discovery: { topN: 10, expand: true, requireAhrefs: false },
      enrichment: {
        modules: ['clusters', 'query_suggestions', 'domain_age'],
        clustering: { topN: 10, minSharedDomains: 3 },
        querySuggestions: {
          sources: ['surfer_related', 'google_autocomplete', 'google_paa'],
          maxSuggestionsPerSource: 20,
          maxParents: 200,
        },
      },
      finalization: {
        representativeCount: 5,
        historyPolicy: {
          youngDomainMaxAgeDays: 730,
          recentWebPresenceMaxAgeDays: 1095,
          repurposeGapMinDays: 365,
        },
        historicalPresence: {
          collectionMode: 'annual',
          recentMonths: 18,
          maxCollections: 24,
          domainCap: 30,
        },
      },
    },
  };
}

function authored(): OperatorResearchConfigFileV1 {
  return {
    version: 1,
    preset: 'deep-research',
    research: {
      label: 'preset-merge',
      input: { type: 'seeds', path: 'input/seeds.csv' },
    },
    discovery: { topN: 7 },
    enrichment: {
      modules: ['clusters'],
      clustering: { minUrlJaccard: 0.25 },
    },
    finalization: {
      historyPolicy: { recentWebPresenceMaxAgeDays: 900 },
    },
  };
}

test('preset merge recurses through objects while arrays replace inherited arrays', () => {
  const merged = mergeOperatorResearchConfig(authored(), deepPreset());

  assert.equal(merged.config.workflow?.target, 'finalization');
  assert.deepEqual(merged.config.enrichment?.modules, ['clusters']);
  assert.equal(merged.config.enrichment?.clustering?.topN, 10);
  assert.equal(merged.config.enrichment?.clustering?.minSharedDomains, 3);
  assert.equal(merged.config.enrichment?.clustering?.minUrlJaccard, 0.25);
  assert.deepEqual(merged.config.finalization?.historyPolicy, {
    youngDomainMaxAgeDays: 730,
    recentWebPresenceMaxAgeDays: 900,
    repurposeGapMinDays: 365,
  });

  assert.equal(merged.origins['$.workflow.target'], 'preset');
  assert.equal(merged.origins['$.discovery.topN'], 'file');
  assert.equal(merged.origins['$.discovery.expand'], 'preset');
  assert.equal(merged.origins['$.enrichment.modules'], 'file');
  assert.equal(merged.origins['$.enrichment.clustering.topN'], 'preset');
  assert.equal(merged.origins['$.enrichment.clustering.minUrlJaccard'], 'file');
  assert.equal(merged.origins['$.finalization.historyPolicy.youngDomainMaxAgeDays'], 'preset');
  assert.equal(merged.origins['$.finalization.historyPolicy.recentWebPresenceMaxAgeDays'], 'file');
});

test('preset provenance does not change stage fingerprints for equivalent effective semantics', () => {
  const configPath = resolve('/tmp/preset-project/research.config.json');
  const loaded = buildLoadedOperatorResearchConfig(authored(), deepPreset(), configPath);
  const manual = buildNewResearchPlan(loaded.config, configPath);

  assert.deepEqual(loaded.plan.preset, { id: 'deep-research', revision: 7 });
  assert.deepEqual(loaded.plan.stageFingerprints, manual.stageFingerprints);
  assert.equal(loaded.plan.effectiveConfigFingerprint, manual.effectiveConfigFingerprint);
  assert.equal(loaded.plan.semantics.provenance['$.workflow.target'], 'preset');
  assert.equal(loaded.plan.semantics.provenance['$.discovery.topN'], 'file');
  assert.equal(manual.semantics.provenance['$.workflow.target'], 'file');
});

test('all committed curated presets load with matching stable identity', async () => {
  const ids = ['quick-scan', 'standard', 'deep-research', 'finalist-validation'];
  for (const id of ids) {
    const preset = await loadOperatorResearchPreset(id);
    assert.equal(preset.id, id);
    assert.equal(preset.version, 1);
    assert.equal(preset.revision, 1);
  }
});
