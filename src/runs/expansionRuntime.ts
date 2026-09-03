import type { ResearchConfig } from '../config/config.js';
import { ResearchError } from '../shared/errors.js';
import { EXPANSION_ADMISSION_VERSION } from './expansionAdmission.js';

type VersionedExpansionConfig = ResearchConfig['expansion'] & {
  admissionVersion?: string;
};

export function withCurrentExpansionAdmission(
  expansion: ResearchConfig['expansion'],
): ResearchConfig['expansion'] {
  return {
    ...expansion,
    admissionVersion: EXPANSION_ADMISSION_VERSION,
  } as VersionedExpansionConfig;
}

export function expansionAdmissionVersion(
  expansion: ResearchConfig['expansion'],
): string | null {
  const value = (expansion as VersionedExpansionConfig).admissionVersion;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function usesGlobalExpansionAdmission(config: ResearchConfig): boolean {
  const version = expansionAdmissionVersion(config.expansion);
  if (version === null) return false;
  if (version !== EXPANSION_ADMISSION_VERSION) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Run uses unsupported expansion admission ${version}; this build supports ${EXPANSION_ADMISSION_VERSION}. Start a new run instead of mixing expansion algorithms inside one run.`,
    );
  }
  return true;
}
