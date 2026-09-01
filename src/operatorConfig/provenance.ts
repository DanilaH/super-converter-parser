import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ResearchError } from '../shared/errors.js';
import type { OperatorResearchConfigV1 } from './contracts.js';
import {
  canonicalJson,
  fingerprint,
  portableEffectiveConfigProjection,
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
  authoredConfig: OperatorResearchConfigV1;
  effectiveConfigFingerprint: string;
  stageFingerprints: StageSemanticFingerprints;
  semantics: PortableResolvedResearchSemantics;
};

export function buildPersistedOperatorConfig(loaded: LoadedOperatorResearchConfig): PersistedOperatorConfigV1 {
  const semantics = toPortableSemantics(loaded.plan.semantics);
  return {
    version: OPERATOR_CONFIG_PROVENANCE_VERSION,
    authoredConfig: loaded.config,
    effectiveConfigFingerprint: loaded.plan.effectiveConfigFingerprint,
    stageFingerprints: loaded.plan.stageFingerprints,
    semantics,
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
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
  }
  if (!isRecord(value.authoredConfig) || !isRecord(value.stageFingerprints) || !isRecord(value.semantics)) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
  }
  if (typeof value.effectiveConfigFingerprint !== 'string') {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
  }
  const stage = value.stageFingerprints;
  if (
    typeof stage.discoverySemanticFingerprint !== 'string'
    || typeof stage.enrichmentSemanticFingerprint !== 'string'
    || typeof stage.finalizationPolicyFingerprint !== 'string'
  ) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Unsupported or corrupt operator config provenance: ${source}.`);
  }
  const persisted = value as PersistedOperatorConfigV1;
  const recomputed = fingerprint('operator-config-v1', portableEffectiveConfigProjection(fromPortableSemantics(persisted.semantics)));
  if (recomputed !== persisted.effectiveConfigFingerprint) {
    throw new ResearchError('OUTPUT_WRITE_ERROR', `${source} effective config fingerprint does not match persisted semantics.`);
  }
  return persisted;
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

function fromPortableSemantics(semantics: PortableResolvedResearchSemantics): ResolvedResearchSemantics {
  return {
    ...semantics,
    research: {
      ...semantics.research,
      input: {
        ...semantics.research.input,
        resolvedPath: semantics.research.input.logicalPath,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
