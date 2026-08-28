import type { KeywordRecord, KeywordStatus, SerpObservationStatus } from './run.js';

export type SerpEvidenceInput = {
  status: KeywordStatus;
  error: { code: string; message: string } | null;
  google: KeywordRecord['google'];
};

export type ResolvedSerpEvidence = {
  status: SerpObservationStatus;
  organicResultCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  trustworthy: boolean;
};

// One definition of truth for persisted/output SERP evidence. Fresh V2.1 rows
// carry google.serpStatus explicitly. Historical rows are interpreted only when
// the old state is provable from durable facts; ambiguous zero-row terminal rows
// become `unknown`, never a fabricated numeric zero.
export function resolveSerpEvidence(
  keyword: SerpEvidenceInput,
  storedOrganicCount: number,
): ResolvedSerpEvidence {
  const explicitStatus = keyword.google?.serpStatus;
  const explicitError = keyword.google?.serpError ?? null;

  if (explicitStatus !== undefined) {
    switch (explicitStatus) {
      case 'ok':
        if (storedOrganicCount > 0) {
          return {
            status: 'ok',
            organicResultCount: storedOrganicCount,
            errorCode: null,
            errorMessage: null,
            trustworthy: true,
          };
        }
        // `ok` with zero stored rows is internally inconsistent. Do not turn
        // the contradiction into a valid zero.
        return unknownEvidence();
      case 'empty':
        if (storedOrganicCount === 0) {
          return {
            status: 'empty',
            organicResultCount: 0,
            errorCode: null,
            errorMessage: null,
            trustworthy: true,
          };
        }
        return unknownEvidence();
      case 'fetch_error':
      case 'parse_error':
        return {
          status: explicitStatus,
          organicResultCount: null,
          errorCode: explicitError?.code ?? null,
          errorMessage: explicitError?.message ?? null,
          trustworthy: false,
        };
      case 'not_fetched':
      case 'unknown':
        return {
          status: explicitStatus,
          organicResultCount: null,
          errorCode: explicitError?.code ?? null,
          errorMessage: explicitError?.message ?? null,
          trustworthy: false,
        };
    }
  }

  // Compatibility for discovery runs persisted before source-specific SERP
  // status existed. Positive stored rows prove a successful observation.
  if (storedOrganicCount > 0) {
    return {
      status: 'ok',
      organicResultCount: storedOrganicCount,
      errorCode: null,
      errorMessage: null,
      trustworthy: true,
    };
  }

  if (keyword.status === 'pending' || keyword.status === 'running') {
    return {
      status: 'not_fetched',
      organicResultCount: null,
      errorCode: null,
      errorMessage: null,
      trustworthy: false,
    };
  }

  const legacyError = keyword.error;
  if (legacyError?.code === 'GOOGLE_SERP_PARSE_ERROR') {
    return {
      status: 'parse_error',
      organicResultCount: null,
      errorCode: legacyError.code,
      errorMessage: legacyError.message,
      trustworthy: false,
    };
  }
  if (legacyError?.code === 'GOOGLE_UNAVAILABLE') {
    return {
      status: 'fetch_error',
      organicResultCount: null,
      errorCode: legacyError.code,
      errorMessage: legacyError.message,
      trustworthy: false,
    };
  }

  // Under the old collector contract a clean completed keyword with no SERP
  // rows could only be emitted after Google explicitly confirmed its zero-result
  // page. This is the one zero-row legacy state that is still provable.
  if (keyword.status === 'completed' && legacyError === null) {
    return {
      status: 'empty',
      organicResultCount: 0,
      errorCode: null,
      errorMessage: null,
      trustworthy: true,
    };
  }

  // Example: an old failed row whose first error is Surfer. Google may have
  // genuinely been empty or may have failed second; the old schema discarded
  // that distinction, so the only truthful projection is unknown/missing.
  return unknownEvidence();
}

function unknownEvidence(): ResolvedSerpEvidence {
  return {
    status: 'unknown',
    organicResultCount: null,
    errorCode: null,
    errorMessage: null,
    trustworthy: false,
  };
}
