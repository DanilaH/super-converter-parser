import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import {
  validateOperatorResearchConfig,
  validateOperatorResearchConfigFile,
  validateOperatorResearchPreset,
  type OperatorResearchConfigFileV1,
  type OperatorResearchConfigV1,
  type OperatorResearchPresetV1,
} from './contracts.js';
import {
  buildLoadedOperatorResearchConfig,
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
};

export type PersistedOperatorConfigV1 = {
  version: 1;
  authoredConfig: OperatorResearchConfigV1 | OperatorResearchConfigFileV1;
  preset?: OperatorResearchPresetV1;
  effectiveConfigFingerprint: string;
  stageFingerprints: StageSemanticFingerprints;
  semantics: PortableResolvedResearchSemantics;
};

export function buildPersistedOperatorConfig(loaded: LoadedOperatorResearchConfig): PersistedOperatorConfigV1 {
  const authoredConfig = loaded.authoredConfig ?? loaded.config;
  const preset = loaded.preset ?? null;
  return {
    version: OPERATOR_CONFIG_PROVENANCE_VERSION,
    authoredConfig,
    ...(preset === null ? {} : { preset }),
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    stageFingerprints: loaded.plan.stageFingerprints,
    semantics: toPortableSemantics(loaded.plan.semantics),
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

  let expected: PersistedOperatorConfigV1;
  if (value.preset === undefined) {
    let authoredConfig: OperatorResearchConfigV1;
    try {
      authoredConfig = validateOperatorResearchConfig(value.authoredConfig);
    } catch (error) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Invalid authored operator config inside provenance: ${source}.`,
        { cause: error },
      );
    }

    // Legacy/no-preset v1 provenance is rebuilt exactly as before. The
    // declaring path is synthetic because absolute machine paths are runtime
    // data and are removed from the persisted projection.
    const rebuilt = buildNewResearchPlan(authoredConfig, '/operator-config-provenance/research.config.json');
    expected = buildPersistedOperatorConfig({ config: authoredConfig, plan: rebuilt });
  } else {
    let authoredConfig: OperatorResearchConfigFileV1;
    let preset: OperatorResearchPresetV1;
    try {
      authoredConfig = validateOperatorResearchConfigFile(value.authoredConfig);
      preset = validateOperatorResearchPreset(value.preset);
    } catch (error) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `Invalid preset operator provenance inside ${source}.`,
        { cause: error },
      );
    }
    if (authoredConfig.preset !== preset.id) {
      throw new ResearchError(
        'OUTPUT_WRITE_ERROR',
        `${source} authored config references preset "${authoredConfig.preset ?? 'none'}" but persisted preset snapshot is "${preset.id}".`,
      );
    }
    const rebuilt = buildLoadedOperatorResearchConfig(
      authoredConfig,
      preset,
      '/operator-config-provenance/research.config.json',
    );
    expected = buildPersistedOperatorConfig(rebuilt);
  }

  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `${source} does not match the effective semantics/fingerprints derived from its immutable authored config and preset snapshot.`,
    );
  }
  return expected;
}

function toPortableSemantics(semantics: ResolvedResearchSemantics): PortableResolvedResearchSemantics {
  return {
    ...semantics,
    research: {
      ...semantics.research,
      input: {
        type: semantics.research.input.type,
        logicalPath: semantics.research.input.logicalPath,
      },
    },
  };
}

function corrupt(source: string): ResearchError {
  return new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
