import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import {
  validateOperatorResearchConfig,
  validateOperatorResearchConfigSource,
  validateOperatorResearchPreset,
  type OperatorResearchConfigSourceV1,
  type OperatorResearchConfigV1,
  type OperatorResearchPresetV1,
} from './contracts.js';
import { mergeOperatorResearchConfig } from './presets.js';
import {
  buildNewResearchPlan,
  canonicalJson,
  type LoadedOperatorResearchConfig,
  type ResolvedResearchSemantics,
  type StageSemanticFingerprints,
} from './resolve.js';

export const OPERATOR_CONFIG_PROVENANCE_FILE = 'operator-config.json';
export const OPERATOR_CONFIG_PROVENANCE_VERSION = 1;

export type PortableResolvedResearchSemantics = Omit<ResolvedResearchSemantics, 'research'> & {
  research: Omit<ResolvedResearchSemantics['research'], 'input'> & {
    input: {
      type: ResolvedResearchSemantics['research']['input']['type'];
      logicalPath: string;
    };
  };
  preset?: { id: string; revision: number };
};

export type PersistedOperatorConfigV1 = {
  version: 1;
  authoredConfig: OperatorResearchConfigSourceV1;
  preset?: OperatorResearchPresetV1;
  effectiveConfig?: OperatorResearchConfigV1;
  effectiveConfigFingerprint: string;
  stageFingerprints: StageSemanticFingerprints;
  semantics: PortableResolvedResearchSemantics;
};

export function buildPersistedOperatorConfig(loaded: LoadedOperatorResearchConfig): PersistedOperatorConfigV1 {
  const preset = loaded.preset ?? null;
  const base = {
    version: 1 as const,
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    stageFingerprints: loaded.plan.stageFingerprints,
    semantics: toPortableSemantics(loaded.plan.semantics, preset),
  };

  if (preset === null) {
    return {
      ...base,
      authoredConfig: loaded.config,
    };
  }

  const sourceConfig = loaded.sourceConfig;
  if (sourceConfig === undefined) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Loaded preset ${preset.id}@${preset.revision} has no authored source config snapshot.`,
    );
  }
  if (sourceConfig.preset !== preset.id) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Loaded preset ${preset.id}@${preset.revision} does not match authored config preset ${sourceConfig.preset ?? 'none'}.`,
    );
  }
  return {
    ...base,
    authoredConfig: sourceConfig,
    preset,
    effectiveConfig: loaded.config,
  };
}

export async function writeOperatorConfigProvenance(
  researchDirectory: string,
  loaded: LoadedOperatorResearchConfig,
): Promise<PersistedOperatorConfigV1> {
  const path = join(researchDirectory, OPERATOR_CONFIG_PROVENANCE_FILE);
  const next = buildPersistedOperatorConfig(loaded);
  const existing = await readOperatorConfigProvenance(researchDirectory);
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(next)) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Research already contains different ${OPERATOR_CONFIG_PROVENANCE_FILE} provenance. Refusing to overwrite immutable operator semantics.`,
      );
    }
    return existing;
  }

  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tempPath, path);
    return next;
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (error instanceof ResearchError) throw error;
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to persist ${path}.`, { cause: error });
  }
}

export async function readOperatorConfigProvenance(
  researchDirectory: string,
): Promise<PersistedOperatorConfigV1 | null> {
  const path = join(researchDirectory, OPERATOR_CONFIG_PROVENANCE_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to read ${path}.`, { cause: error });
  }
  return validatePersistedOperatorConfig(parsed, path);
}

export function validatePersistedOperatorConfig(value: unknown, source: string): PersistedOperatorConfigV1 {
  if (!isRecord(value) || value.version !== OPERATOR_CONFIG_PROVENANCE_VERSION) {
    throw corrupt(source);
  }

  const hasPresetSnapshot = Object.prototype.hasOwnProperty.call(value, 'preset');
  const hasEffectiveConfig = Object.prototype.hasOwnProperty.call(value, 'effectiveConfig');
  if (hasPresetSnapshot !== hasEffectiveConfig) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `${source} must contain both preset and effectiveConfig for preset-backed provenance.`,
    );
  }

  if (!hasPresetSnapshot) {
    let authoredConfig: OperatorResearchConfigV1;
    try {
      authoredConfig = validateOperatorResearchConfig(value.authoredConfig);
    } catch (error) {
      throw invalidAuthored(source, error);
    }
    const rebuilt = buildNewResearchPlan(authoredConfig, '/operator-config-provenance/research.config.json');
    const expected = buildPersistedOperatorConfig({ config: authoredConfig, plan: rebuilt });
    if (canonicalJson(value) !== canonicalJson(expected)) {
      throw mismatch(source);
    }
    return expected;
  }

  let authoredConfig: OperatorResearchConfigSourceV1;
  let preset: OperatorResearchPresetV1;
  let effectiveConfig: OperatorResearchConfigV1;
  try {
    authoredConfig = validateOperatorResearchConfigSource(value.authoredConfig);
    preset = validateOperatorResearchPreset(value.preset);
    effectiveConfig = validateOperatorResearchConfig(value.effectiveConfig);
  } catch (error) {
    throw invalidAuthored(source, error);
  }
  if (authoredConfig.preset !== preset.id) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `${source} authored config names preset ${authoredConfig.preset ?? 'none'}, but persisted snapshot is ${preset.id}@${preset.revision}.`,
    );
  }

  let merged: OperatorResearchConfigV1;
  try {
    merged = mergeOperatorResearchConfig(authoredConfig, preset);
  } catch (error) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `${source} contains an invalid preset/config merge.`, { cause: error });
  }
  if (canonicalJson(merged) !== canonicalJson(effectiveConfig)) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `${source} effectiveConfig does not match its immutable authored config + preset snapshot.`,
    );
  }

  const rebuilt = buildNewResearchPlan(
    effectiveConfig,
    '/operator-config-provenance/research.config.json',
    { sourceConfig: authoredConfig, preset },
  );
  const expected = buildPersistedOperatorConfig({
    config: effectiveConfig,
    sourceConfig: authoredConfig,
    preset,
    plan: rebuilt,
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw mismatch(source);
  }
  return expected;
}

function toPortableSemantics(
  semantics: ResolvedResearchSemantics,
  preset: OperatorResearchPresetV1 | null,
): PortableResolvedResearchSemantics {
  return {
    ...semantics,
    research: {
      ...semantics.research,
      input: {
        type: semantics.research.input.type,
        logicalPath: semantics.research.input.logicalPath,
      },
    },
    ...(preset === null ? {} : { preset: { id: preset.id, revision: preset.revision } }),
  };
}

function invalidAuthored(source: string, cause: unknown): ResearchError {
  return new ResearchError(
    'OUTPUT_WRITE_ERROR',
    `Invalid authored/effective operator config inside provenance: ${source}.`,
    { cause },
  );
}

function mismatch(source: string): ResearchError {
  return new ResearchError(
    'OUTPUT_WRITE_ERROR',
    `${source} does not match the effective semantics/fingerprints derived from its immutable operator provenance.`,
  );
}

function corrupt(source: string): ResearchError {
  return new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
