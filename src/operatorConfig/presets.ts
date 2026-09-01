import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchError } from '../shared/errors.js';
import {
  type OperatorResearchConfigFileV1,
  type OperatorResearchConfigV1,
  type OperatorResearchPresetV1,
  type OperatorResearchSemanticOverlayV1,
  validateOperatorResearchConfig,
  validateOperatorResearchPreset,
} from './contracts.js';

export type PresetSemanticOrigin = 'preset' | 'file';
export type PresetSemanticOrigins = Record<string, PresetSemanticOrigin>;
export type ResolvedPresetIdentity = { id: string; revision: number };

export type MergedOperatorResearchConfig = {
  config: OperatorResearchConfigV1;
  origins: PresetSemanticOrigins;
};

const BUILTIN_PRESET_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../configs/presets',
);

export async function loadOperatorResearchPreset(id: string): Promise<OperatorResearchPresetV1> {
  assertPresetId(id);
  const path = resolve(BUILTIN_PRESET_DIRECTORY, `${id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Operator preset "${id}" is not valid JSON: ${path}.`, { cause: error });
    }
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Cannot read operator preset "${id}" at ${path}.`, { cause: error });
  }
  const preset = validateOperatorResearchPreset(raw);
  if (preset.id !== id) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Operator preset file ${path} declares id "${preset.id}" instead of requested id "${id}".`,
    );
  }
  return preset;
}

export function mergeOperatorResearchConfig(
  authored: OperatorResearchConfigFileV1,
  preset: OperatorResearchPresetV1 | null,
): MergedOperatorResearchConfig {
  if (authored.preset === undefined && preset !== null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Preset "${preset.id}" was supplied but $.preset is absent from the research config.`);
  }
  if (authored.preset !== undefined && preset === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `Research config requests preset "${authored.preset}", but no preset snapshot was supplied.`);
  }
  if (preset !== null && authored.preset !== preset.id) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Research config requests preset "${authored.preset}", but supplied preset id is "${preset.id}".`,
    );
  }

  const fileOverlay = configFileSemanticOverlay(authored);
  const mergedOverlay = deepMerge(
    preset?.overlay ?? {},
    fileOverlay,
  ) as OperatorResearchSemanticOverlayV1;

  const candidate: Record<string, unknown> = {
    version: 1,
    research: {
      ...(mergedOverlay.research ?? {}),
      label: authored.research.label,
      input: authored.research.input,
    },
  };
  if (mergedOverlay.workflow !== undefined) candidate.workflow = mergedOverlay.workflow;
  if (mergedOverlay.discovery !== undefined) candidate.discovery = mergedOverlay.discovery;
  if (mergedOverlay.enrichment !== undefined) candidate.enrichment = mergedOverlay.enrichment;
  if (mergedOverlay.finalization !== undefined) candidate.finalization = mergedOverlay.finalization;

  const origins: PresetSemanticOrigins = {};
  if (preset !== null) collectLeafOrigins(preset.overlay, '$', 'preset', origins);
  collectLeafOrigins(fileOverlay, '$', 'file', origins);

  return {
    config: validateOperatorResearchConfig(candidate),
    origins,
  };
}

export function presetIdentity(preset: OperatorResearchPresetV1 | null): ResolvedPresetIdentity | null {
  return preset === null ? null : { id: preset.id, revision: preset.revision };
}

function configFileSemanticOverlay(authored: OperatorResearchConfigFileV1): OperatorResearchSemanticOverlayV1 {
  const overlay: OperatorResearchSemanticOverlayV1 = {};
  const research: NonNullable<OperatorResearchSemanticOverlayV1['research']> = {};
  if (authored.research.market !== undefined) research.market = authored.research.market;
  if (authored.research.googleHl !== undefined) research.googleHl = authored.research.googleHl;
  if (authored.research.googleGl !== undefined) research.googleGl = authored.research.googleGl;
  if (Object.keys(research).length > 0) overlay.research = research;
  if (authored.workflow !== undefined) overlay.workflow = authored.workflow;
  if (authored.discovery !== undefined) overlay.discovery = authored.discovery;
  if (authored.enrichment !== undefined) overlay.enrichment = authored.enrichment;
  if (authored.finalization !== undefined) overlay.finalization = authored.finalization;
  return overlay;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return cloneJson(base);
  if (Array.isArray(override)) return override.map(cloneJson);
  if (isRecord(override)) {
    const baseRecord = isRecord(base) ? base : {};
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(baseRecord), ...Object.keys(override)])) {
      const overrideValue = override[key];
      result[key] = overrideValue === undefined
        ? cloneJson(baseRecord[key])
        : deepMerge(baseRecord[key], overrideValue);
    }
    return result;
  }
  return override;
}

function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJson(entry)]));
  }
  return value;
}

function collectLeafOrigins(
  value: unknown,
  path: string,
  origin: PresetSemanticOrigin,
  output: PresetSemanticOrigins,
): void {
  if (Array.isArray(value) || !isRecord(value)) {
    output[path] = origin;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    collectLeafOrigins(child, `${path}.${key}`, origin, output);
  }
}

function assertPresetId(id: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `Preset id "${id}" must use lowercase letters, digits, and hyphens only.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
