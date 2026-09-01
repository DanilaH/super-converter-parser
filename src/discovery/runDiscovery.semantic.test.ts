import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { effectiveConfigForResume } from './runDiscovery.js';

test('effectiveConfigForResume keeps operational env but restores persisted scoring semantics', () => {
  const current = loadConfig({
    CDP_URL: 'http://127.0.0.1:9444',
    SURFER_WAIT_MS: '45000',
    SCORING_DR_VERY_WEAK_MAX: '1',
    SCORING_DR_WEAK_MAX: '2',
    SCORING_DR_STRONG_MIN: '98',
    SCORING_DR_STRONG_MAX: '99',
  } as NodeJS.ProcessEnv);
  const persisted = loadConfig({
    RESEARCH_MARKET: 'GB',
    TOP_N: '15',
    SCORING_DR_VERY_WEAK_MAX: '8',
    SCORING_DR_WEAK_MAX: '25',
    SCORING_DR_STRONG_MIN: '55',
    SCORING_DR_STRONG_MAX: '70',
  } as NodeJS.ProcessEnv);

  const merged = effectiveConfigForResume(current, persisted, 'run-1');

  assert.equal(merged.browser.cdpUrl, 'http://127.0.0.1:9444');
  assert.equal(merged.browser.surferWaitTimeoutMs, 45000);
  assert.equal(merged.research.market, 'GB');
  assert.equal(merged.research.topN, 15);
  assert.deepEqual(merged.scoring, persisted.scoring);
  assert.notDeepEqual(merged.scoring, current.scoring);
});
