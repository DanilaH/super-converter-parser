import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchError } from '../shared/errors.js';
import {
  validateOperatorResearchConfig,
  validateOperatorResearchPreset,
  type OperatorResearchConfigSourceV1,
  type OperatorResearchConfigV1,
  type OperatorResearchPresetV1,
} from './contracts.js';

export type OperatorPresetIdentity = {
  id: string;
  revision: number;
};

export type SemanticOriginHint = 'file' | 'preset';
export type SemanticOriginHints = Record<string, SemanticOriginHint>;

const BUILTIN_PRESET_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../configs/presets',
);

export async function loadBuiltInOperatorPreset(id: string): Promise<OperatorResearchPresetV1> {
  assertPresetId(id);
  const path = resolve(BUILTIN_PRESET_DIRECTORY, `${id}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown operator preset "${id}".`);
    }
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Failed to read operator preset "${id}".`, { cause: error });
  }
  const preset = validateOperatorResearchPreset(parsed);
  if (preset.id !== id) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Operator preset file ${id}.json declares id "${preset.id}"; preset identity must match its filename.`,
    );
  }
  return preset;
}

export function mergeOperatorResearchConfig(
  source: OperatorResearchConfigSourceV1,
  preset: OperatorResearchPresetV1 | null,
): OperatorResearchConfigV1 {
  if (source.preset === undefined && preset !== null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Preset ${preset.id}@${preset.revision} was supplied for a config that does not declare a preset.`);
  }
  if (source.preset !== undefined && preset === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Config declares preset "${source.preset}", but no preset snapshot was supplied.`);
  }
  if (source.preset !== undefined && preset !== null && source.preset !== preset.id) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Config declares preset "${source.preset}", but supplied preset snapshot is ${preset.id}@${preset.revision}.`,
    );
  }

  const sourceOverlay = withoutKeys(source as Record<string, unknown>, ['version', 'preset']);
  const presetOverlay = preset === null
    ? {}
    : withoutKeys(preset as Record<string, unknown>, ['version', 'id', 'revision']);
  const merged = deepMerge(
    { version: 1 },
    presetOverlay,
    sourceOverlay,
  );
  return validateOperatorResearchConfig(merged);
}

export function buildSemanticOriginHints(
  source: OperatorResearchConfigSourceV1,
  preset: OperatorResearchPresetV1 | null,
): SemanticOriginHints {
  const hints: SemanticOriginHints = {};
  if (preset !== null) {
    collectLeafOrigins(
      withoutKeys(preset as Record<string, unknown>, ['version', 'id', 'revision']),
      '$',
      'preset',
      hints,
    );
  }
  collectLeafOrigins(
    withoutKeys(source as Record<string, unknown>, ['version', 'preset']),
    '$',
    'file',
    hints,
  );
  return hints;
}

export function presetIdentity(preset: OperatorResearchPresetV1 | null): OperatorPresetIdentity | null {
  return preset === null ? null : { id: preset.id, revision: preset.revision };
}

function deepMerge(...values: Record<string, unknown>[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const value of values) mergeInto(result, value);
  return result;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = [...value];
      continue;
    }
    if (isRecord(value)) {
      const current = isRecord(target[key]) ? target[key] as Record<string, unknown> : {};
      target[key] = current;
      mergeInto(current, value);
      continue;
    }
    target[key] = value;
  }
}

function collectLeafOrigins(
  value: Record<string, unknown>,
  path: string,
  origin: SemanticOriginHint,
  result: SemanticOriginHints,
): void {
  for (const [key, nested] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (Array.isArray(nested) || !isRecord(nested)) {
      result[childPath] = origin;
      continue;
    }
    collectLeafOrigins(nested, childPath, origin, result);
  }
}

function withoutKeys(value: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const omitted = new Set(keys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function assertPresetId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Operator preset id "${id}" must use lowercase letters, digits, and hyphens only.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
