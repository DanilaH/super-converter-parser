import type { ResearchStatusWithHistoricalPresence } from './statusWithHistoricalPresence.js';

export const RESEARCH_AUDIT_VERSION = '1.0.0' as const;

export type ResearchAuditCheckStatus = 'pass' | 'warn' | 'fail' | 'not_applicable' | 'unknown';
export type ResearchAuditOverall = 'pass' | 'warn' | 'fail';

export type ResearchAuditCheckId =
  | 'research_projection'
  | 'layout_coverage'
  | 'discovery_completion'
  | 'discovery_quality'
  | 'current_enrichment'
  | 'finalization_projection'
  | 'deep_evidence_coverage'
  | 'sampled_historical_presence'
  | 'library_publication';

export type ResearchAuditCheck = {
  id: ResearchAuditCheckId;
  status: ResearchAuditCheckStatus;
  message: string;
};

export type ResearchAudit = {
  version: typeof RESEARCH_AUDIT_VERSION;
  researchId: string;
  label: string | null;
  legacy: boolean | null;
  overall: ResearchAuditOverall;
  checks: ResearchAuditCheck[];
};

export function buildResearchAudit(status: ResearchStatusWithHistoricalPresence): ResearchAudit {
  const checks: ResearchAuditCheck[] = [
    {
      id: 'research_projection',
      status: 'pass',
      message: 'Current durable research state projected successfully through the existing read-only status path.',
    },
    auditLayout(status),
    auditDiscoveryCompletion(status),
    auditDiscoveryQuality(status),
    auditCurrentEnrichment(status),
    auditFinalization(status),
    auditDeepEvidence(status),
    auditSampledHistoricalPresence(status),
    auditLibrary(status),
  ];

  return {
    version: RESEARCH_AUDIT_VERSION,
    researchId: status.researchId,
    label: status.label,
    legacy: status.legacy,
    overall: overallStatus(checks),
    checks,
  };
}

export function buildFailedResearchAudit(input: {
  targetResearchId: string;
  code: string;
  message: string;
}): ResearchAudit {
  const checks: ResearchAuditCheck[] = [{
    id: 'research_projection',
    status: 'fail',
    message: `${input.code}: ${input.message}`,
  }];
  return {
    version: RESEARCH_AUDIT_VERSION,
    researchId: input.targetResearchId,
    label: null,
    legacy: null,
    overall: 'fail',
    checks,
  };
}

function auditLayout(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  if (status.legacy) {
    return {
      id: 'layout_coverage',
      status: 'warn',
      message: 'Legacy layout is readable, but modern research-container, enrichment, finalization, and Library integrity coverage is unavailable.',
    };
  }
  return {
    id: 'layout_coverage',
    status: 'pass',
    message: 'Current research layout is available for modern lineage and downstream integrity checks.',
  };
}

function auditDiscoveryCompletion(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const counts = status.discovery.keywordCounts;
  const degraded = status.discovery.state !== 'completed'
    || counts.pending > 0
    || counts.running > 0
    || counts.partial > 0
    || counts.failed > 0
    || counts.repairable > 0;

  if (!degraded) {
    return {
      id: 'discovery_completion',
      status: 'pass',
      message: `Discovery ${status.discovery.runId} is exactly completed with ${counts.completed}/${counts.total} terminal completed keywords.`,
    };
  }

  return {
    id: 'discovery_completion',
    status: 'warn',
    message: `Discovery ${status.discovery.runId} is ${status.discovery.state}: completed=${counts.completed}/${counts.total}, partial=${counts.partial}, failed=${counts.failed}, pending=${counts.pending}, running=${counts.running}, repairable=${counts.repairable}. Incomplete or repairable discovery is degraded evidence, not structural corruption.`,
  };
}

function auditDiscoveryQuality(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const warnings = status.discovery.qualityWarnings;
  if (warnings.length === 0) {
    return {
      id: 'discovery_quality',
      status: 'pass',
      message: 'Current discovery run-quality projection has no warnings.',
    };
  }
  return {
    id: 'discovery_quality',
    status: 'warn',
    message: `${warnings.length} run-quality warning(s): ${warnings.map((warning) => warning.code).join(', ')}.`,
  };
}

function auditCurrentEnrichment(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  if (status.currentEnrichmentId === null) {
    return {
      id: 'current_enrichment',
      status: 'not_applicable',
      message: 'No enrichment exists for the current discovery generation.',
    };
  }

  const current = status.enrichments.find(
    (item) => item.enrichmentId === status.currentEnrichmentId && item.isLatestForCurrentDiscovery,
  );
  if (!current) {
    return {
      id: 'current_enrichment',
      status: 'fail',
      message: `Current enrichment ${status.currentEnrichmentId} is not represented as the latest enrichment for the current discovery generation.`,
    };
  }

  const moduleCounts = Object.values(current.itemCounts);
  const errorCount = moduleCounts.reduce((sum, counts) => sum + counts.error, 0);
  const openCount = moduleCounts.reduce((sum, counts) => sum + counts.pending + counts.running, 0);
  const notAttemptedCount = moduleCounts.reduce((sum, counts) => sum + counts.notAttempted, 0);
  const degraded = current.state !== 'completed' || errorCount > 0 || openCount > 0 || notAttemptedCount > 0;

  if (!degraded) {
    return {
      id: 'current_enrichment',
      status: 'pass',
      message: `Current enrichment ${current.enrichmentId} is completed with no persisted module errors/open/not-attempted items.`,
    };
  }

  return {
    id: 'current_enrichment',
    status: 'warn',
    message: `Current enrichment ${current.enrichmentId} is ${current.state}: moduleErrors=${errorCount}, openItems=${openCount}, notAttempted=${notAttemptedCount}${current.error ? `, runError=${current.error}` : ''}.`,
  };
}

function auditFinalization(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const finalization = status.finalization;
  const staleCurrentParentArtifact = finalization.artifactWarning?.includes(
    'stale relative to current durable parent snapshots',
  ) === true;

  if (staleCurrentParentArtifact) {
    return {
      id: 'finalization_projection',
      status: 'fail',
      message: `Current finalization artifact is known stale and unsafe to treat as current: ${finalization.artifactWarning}`,
    };
  }

  if (finalization.state === 'not_started') {
    return {
      id: 'finalization_projection',
      status: finalization.artifactWarning === null ? 'not_applicable' : 'warn',
      message: finalization.artifactWarning === null
        ? 'Finalization has not started for the current enrichment.'
        : `Finalization has not started and its derived artifact surface is incomplete/degraded: ${finalization.artifactWarning}`,
    };
  }

  if (finalization.artifactWarning !== null) {
    return {
      id: 'finalization_projection',
      status: 'warn',
      message: `Finalization artifact surface is incomplete/degraded but not proven stale against current parents: ${finalization.artifactWarning}`,
    };
  }

  if (finalization.state === 'in_progress') {
    return {
      id: 'finalization_projection',
      status: 'warn',
      message: 'Finalization is in progress; current finalist evidence is not yet a complete finalization package.',
    };
  }

  return {
    id: 'finalization_projection',
    status: 'pass',
    message: `Finalization state is ${finalization.state}; no stale/current-parent artifact warning is present.`,
  };
}

function auditDeepEvidence(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const coverage = status.evidenceCoverage;
  if (coverage === null) {
    return {
      id: 'deep_evidence_coverage',
      status: 'not_applicable',
      message: 'Deep evidence coverage is unavailable because no current deep-evidence projection exists.',
    };
  }
  if (coverage.warnings.length === 0) {
    return {
      id: 'deep_evidence_coverage',
      status: 'pass',
      message: 'Current deep-evidence coverage projection has no warnings.',
    };
  }
  return {
    id: 'deep_evidence_coverage',
    status: 'warn',
    message: `${coverage.warnings.length} deep-evidence warning(s): ${coverage.warnings.map((warning) => warning.code).join(', ')}. Missing optional evidence remains warning-level uncertainty, not corruption.`,
  };
}

function auditSampledHistoricalPresence(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const sampled = status.sampledHistoricalPresence;
  if (sampled === null) {
    return {
      id: 'sampled_historical_presence',
      status: 'not_applicable',
      message: 'No sampled historical-presence projection exists for the current research state.',
    };
  }
  if (sampled.warnings.length === 0) {
    return {
      id: 'sampled_historical_presence',
      status: 'pass',
      message: 'Sampled historical-presence projection has no warnings under its bounded sampled-presence semantics.',
    };
  }
  return {
    id: 'sampled_historical_presence',
    status: 'warn',
    message: `${sampled.warnings.length} sampled historical-presence warning(s): ${sampled.warnings.map((warning) => warning.code).join(', ')}.`,
  };
}

function auditLibrary(status: ResearchStatusWithHistoricalPresence): ResearchAuditCheck {
  const library = status.library;
  if (library.lookupError !== null) {
    return {
      id: 'library_publication',
      status: 'warn',
      message: `Research Library publication/current-snapshot lookup is degraded (${library.reason ?? 'unknown_reason'}): ${library.lookupError}`,
    };
  }

  if (!library.published) {
    return {
      id: 'library_publication',
      status: 'not_applicable',
      message: `No current matching Library publication exists (${library.reason ?? 'not_published'}). Publication absence is not evidence corruption.`,
    };
  }

  if (library.derivedSnapshotsCurrent === true) {
    return {
      id: 'library_publication',
      status: 'pass',
      message: `Current Library publication ${library.publicationId ?? 'unknown'} and its derived snapshots are current with durable Library truth.`,
    };
  }

  if (library.derivedSnapshotsCurrent === false) {
    return {
      id: 'library_publication',
      status: 'warn',
      message: `Durable Library publication exists, but derived snapshots need repair: ${library.derivedSnapshotWarning ?? 'derived snapshot mismatch'}.`,
    };
  }

  return {
    id: 'library_publication',
    status: 'unknown',
    message: 'A current Library publication exists, but derived-snapshot health could not be established.',
  };
}

function overallStatus(checks: ResearchAuditCheck[]): ResearchAuditOverall {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn' || check.status === 'unknown')) return 'warn';
  return 'pass';
}
