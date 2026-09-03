import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../config/config.js';
import { ResearchError } from '../shared/errors.js';
import {
  usesGlobalExpansionAdmission,
  withCurrentExpansionAdmission,
} from './expansionRuntime.js';

const BASE = loadConfig({});

test('fresh expansion stamping enables V1 without mutating the caller object', () => {
  const stamped = withCurrentExpansionAdmission(BASE.expansion);
  assert.notEqual(stamped, BASE.expansion);
  assert.equal((stamped as ResearchConfigExpansionWithVersion).admissionVersion, 'v1');
  assert.equal((BASE.expansion as ResearchConfigExpansionWithVersion).admissionVersion, undefined);
  assert.equal(usesGlobalExpansionAdmission({ ...BASE, expansion: stamped }), true);
});

test('legacy persisted expansion config remains on immediate admission semantics', () => {
  assert.equal(usesGlobalExpansionAdmission(BASE), false);
});

test('unknown persisted expansion admission version fails closed', () => {
  const expansion = { ...BASE.expansion, admissionVersion: 'v999' } as typeof BASE.expansion;
  assert.throws(
    () => usesGlobalExpansionAdmission({ ...BASE, expansion }),
    (error: unknown) => error instanceof ResearchError && error.code === 'RESUME_CONFIG_MISMATCH',
  );
});

type ResearchConfigExpansionWithVersion = typeof BASE.expansion & {
  admissionVersion?: string;
};
