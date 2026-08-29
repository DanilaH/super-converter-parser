import {
  TRAFFIC_EVIDENCE_VERSION,
  validateTrafficEvidencePolicy,
  type TrafficEvidencePolicy,
} from './trafficEvidence.js';

export function resolveTrafficEvidencePolicy(input: {
  previous: TrafficEvidencePolicy | null;
  lowBaseOrganicTrafficThreshold?: number | undefined;
}): TrafficEvidencePolicy {
  const threshold = input.lowBaseOrganicTrafficThreshold
    ?? input.previous?.lowBaseOrganicTrafficThreshold;
  if (threshold === undefined) {
    throw new Error(
      'First traffic-evidence run requires explicit --low-base-organic-traffic-threshold; no implicit traffic baseline is applied.',
    );
  }
  const policy: TrafficEvidencePolicy = {
    version: TRAFFIC_EVIDENCE_VERSION,
    lowBaseOrganicTrafficThreshold: threshold,
  };
  validateTrafficEvidencePolicy(policy);
  return policy;
}
