import { resolve } from 'node:path';
import {
  type OperatorContinuationV1,
  type OperatorResearchConfigSourceV1,
  validateOperatorContinuation,
  validateOperatorResearchConfigSource,
} from '../operatorConfig/contracts.js';
import {
  loadBuiltInOperatorPreset,
  mergeOperatorResearchConfig,
} from '../operatorConfig/presets.js';
import {
  buildNewResearchPlan,
  resolveDeclaredPath,
  type LoadedOperatorResearchConfig,
  type ResolvedOperatorContinuation,
} from '../operatorConfig/resolve.js';

/**
 * Resolve an already-parsed operator config without requiring a JSON file.
 * `declaringPath` exists only to preserve the existing declaring-file-relative
 * path contract for research inputs.
 */
export async function resolveOperatorResearchConfigInput(
  source: OperatorResearchConfigSourceV1,
  declaringPath: string,
): Promise<LoadedOperatorResearchConfig> {
  const sourceConfig = validateOperatorResearchConfigSource(source);
  const preset = sourceConfig.preset === undefined
    ? null
    : await loadBuiltInOperatorPreset(sourceConfig.preset);
  const config = mergeOperatorResearchConfig(sourceConfig, preset);
  const plan = buildNewResearchPlan(config, resolve(declaringPath), { sourceConfig, preset });
  return { config, sourceConfig, preset, plan };
}

/**
 * Resolve an already-parsed continuation without requiring a continuation JSON
 * file. Path-bearing actions retain the same declaring-file-relative semantics.
 */
export function resolveOperatorContinuationInput(
  value: OperatorContinuationV1,
  declaringPath: string,
): ResolvedOperatorContinuation {
  const continuation = validateOperatorContinuation(value);
  const continuationPath = resolve(declaringPath);
  const action = continuation.action;
  const declaredFilePath = 'path' in action
    ? resolveDeclaredPath(continuationPath, action.path)
    : null;
  return { continuation, continuationPath, declaredFilePath };
}
