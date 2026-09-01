import type { PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import type { ResolvedOperatorContinuation } from '../operatorConfig/resolve.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import { runFinalistEvidence, type FinalistEvidenceRunResult } from './finalistEvidenceRun.js';
import { runFullFinalization, type FullFinalizationRunResult } from './fullFinalizationRun.js';
import { runLibraryPublication, type LibraryPublicationRunResult } from './libraryPublicationRun.js';
import { runTrafficEvidence, type TrafficEvidenceRunResult } from './trafficEvidenceRun.js';

export type ConfiguredFinalizationOutcome =
  | { kind: 'awaiting_finalist_scope'; state: 'awaiting_finalist_scope' }
  | { kind: 'awaiting_decisions'; state: 'awaiting_decisions'; finalistCount: number; currentDecisionCount: number }
  | { kind: 'published'; state: 'published'; publicationId: string };

export type ConfiguredFinalizationRequest = {
  outputRoot: string;
  researchId: string;
  researchDirectory: string;
  enrichmentId: string;
  operatorConfig: PersistedOperatorConfigV1;
  continuation: ResolvedOperatorContinuation | null;
  status: ResearchStatusWithHistoricalPresence;
  env?: NodeJS.ProcessEnv;
  logger?: (line: string) => void;
};

export type ConfiguredFinalizationResult = {
  outcome: ConfiguredFinalizationOutcome;
  fullRun: FullFinalizationRunResult | null;
  traffic: TrafficEvidenceRunResult | null;
  finalistEvidence: FinalistEvidenceRunResult | null;
  publication: LibraryPublicationRunResult | null;
};

export type ConfiguredFinalizationDeps = {
  runFullFinalization: typeof runFullFinalization;
  runTrafficEvidence: typeof runTrafficEvidence;
  runFinalistEvidence: typeof runFinalistEvidence;
  runLibraryPublication: typeof runLibraryPublication;
};

export const DEFAULT_CONFIGURED_FINALIZATION_DEPS: ConfiguredFinalizationDeps = {
  runFullFinalization,
  runTrafficEvidence,
  runFinalistEvidence,
  runLibraryPublication,
};

export async function runConfiguredFinalization(
  request: ConfiguredFinalizationRequest,
  deps: ConfiguredFinalizationDeps = DEFAULT_CONFIGURED_FINALIZATION_DEPS,
): Promise<ConfiguredFinalizationResult> {
  assertRequestMatchesDurableState(request);
  const semantics = request.operatorConfig.semantics;
  if (semantics.workflow.target !== 'finalization' || semantics.finalization === null) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', 'Persisted OperatorConfig does not request finalization.');
  }

  const logger = request.logger ?? ((line: string) => console.log(line));
  const action = request.continuation?.continuation.action ?? null;
  const resolvedPath = request.continuation?.declaredFilePath?.resolvedPath ?? null;

  if (action?.type === 'decisions' && !request.status.finalization.finalistMatrixPublished) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      'A decisions continuation requires a current finalist evidence matrix; finish upstream finalization evidence first.',
    );
  }

  if (action?.type === 'publication_override') {
    const publication = await deps.runLibraryPublication({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      logger,
    });
    return published(publication);
  }

  if (request.status.finalization.state === 'ready_to_publish' && action === null) {
    const publication = await deps.runLibraryPublication({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      logger,
    });
    return published(publication);
  }

  if (action?.type === 'decisions') {
    if (resolvedPath === null) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'Decisions continuation is missing its resolved file path.');
    }
    const finalistEvidence = await deps.runFinalistEvidence({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      decisionsPath: resolvedPath,
      logger,
    });
    if (finalistEvidence.currentHumanDecisionCount !== finalistEvidence.finalistCount) {
      return awaitingDecisions(finalistEvidence, null);
    }
    const publication = await deps.runLibraryPublication({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      logger,
    });
    return {
      ...published(publication),
      finalistEvidence,
    };
  }

  if (
    action?.type === 'traffic'
    && (
      request.status.finalization.state === 'awaiting_decisions'
      || request.status.finalization.state === 'ready_to_publish'
      || request.status.finalization.state === 'published'
    )
  ) {
    if (resolvedPath === null) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', 'Traffic continuation is missing its resolved file path.');
    }
    const traffic = await deps.runTrafficEvidence({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      inputPath: resolvedPath,
      lowBaseOrganicTrafficThreshold: action.lowBaseOrganicTrafficThreshold,
      logger,
    });
    const finalistEvidence = await deps.runFinalistEvidence({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      decisionsPath: null,
      logger,
    });
    if (finalistEvidence.currentHumanDecisionCount !== finalistEvidence.finalistCount) {
      return awaitingDecisions(finalistEvidence, traffic);
    }
    const publication = await deps.runLibraryPublication({
      outputRoot: request.outputRoot,
      enrichmentId: request.enrichmentId,
      logger,
    });
    return {
      ...published(publication),
      traffic,
      finalistEvidence,
    };
  }

  if (action === null && request.status.finalization.state === 'awaiting_decisions') {
    return {
      outcome: {
        kind: 'awaiting_decisions',
        state: 'awaiting_decisions',
        finalistCount: request.status.finalization.finalistCount,
        currentDecisionCount: request.status.finalization.currentDecisionCount,
      },
      fullRun: null,
      traffic: null,
      finalistEvidence: null,
      publication: null,
    };
  }

  if (action === null && request.status.finalization.state === 'not_started') {
    return {
      outcome: { kind: 'awaiting_finalist_scope', state: 'awaiting_finalist_scope' },
      fullRun: null,
      traffic: null,
      finalistEvidence: null,
      publication: null,
    };
  }

  const selectedClusterIds = action?.type === 'finalists' ? [...action.clusters] : undefined;
  const allClusters = action?.type === 'finalists_all';
  const representativeOverridesPath = action?.type === 'representative_overrides'
    ? requiredResolvedPath(resolvedPath, 'Representative-overrides')
    : undefined;
  const trafficInputPath = action?.type === 'traffic'
    ? requiredResolvedPath(resolvedPath, 'Traffic')
    : null;
  const lowBaseOrganicTrafficThreshold = action?.type === 'traffic'
    ? action.lowBaseOrganicTrafficThreshold
    : undefined;

  const policy = semantics.finalization;
  const fullRun = await deps.runFullFinalization({
    outputRoot: request.outputRoot,
    enrichmentId: request.enrichmentId,
    ...(selectedClusterIds === undefined ? {} : { selectedClusterIds }),
    allClusters,
    representativeCount: policy.representativeCount,
    ...(representativeOverridesPath === undefined ? {} : { representativeOverridesPath }),
    youngDomainMaxAgeDays: policy.historyPolicy.youngDomainMaxAgeDays,
    recentWebPresenceMaxAgeDays: policy.historyPolicy.recentWebPresenceMaxAgeDays,
    repurposeGapMinDays: policy.historyPolicy.repurposeGapMinDays,
    historicalPresence: { ...policy.historicalPresence },
    trafficInputPath,
    ...(lowBaseOrganicTrafficThreshold === undefined ? {} : { lowBaseOrganicTrafficThreshold }),
    decisionsPath: null,
    publishWithoutDecisions: false,
    ...(request.env === undefined ? {} : { env: request.env }),
    logger,
  });

  if (fullRun.state === 'published') {
    if (fullRun.publication === null) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', 'Full finalization reported published without a Library publication result.');
    }
    return {
      outcome: {
        kind: 'published',
        state: 'published',
        publicationId: fullRun.publication.publicationId,
      },
      fullRun,
      traffic: fullRun.traffic,
      finalistEvidence: fullRun.finalistEvidence,
      publication: fullRun.publication,
    };
  }

  return {
    outcome: {
      kind: 'awaiting_decisions',
      state: 'awaiting_decisions',
      finalistCount: fullRun.finalistEvidence.finalistCount,
      currentDecisionCount: fullRun.finalistEvidence.currentHumanDecisionCount,
    },
    fullRun,
    traffic: fullRun.traffic,
    finalistEvidence: fullRun.finalistEvidence,
    publication: null,
  };
}

function assertRequestMatchesDurableState(request: ConfiguredFinalizationRequest): void {
  if (request.status.researchId !== request.researchId) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Finalization request targets research ${request.researchId}, but durable status belongs to ${request.status.researchId}.`,
    );
  }
  if (request.status.researchDirectory !== request.researchDirectory) {
    throw new ResearchError('RESUME_CONFIG_MISMATCH', 'Finalization request research directory differs from durable status.');
  }
  if (request.status.currentEnrichmentId !== request.enrichmentId) {
    throw new ResearchError(
      'RESUME_CONFIG_MISMATCH',
      `Finalization request targets enrichment ${request.enrichmentId}, but current enrichment is ${request.status.currentEnrichmentId ?? 'none'}.`,
    );
  }
  const current = request.status.enrichments.find((item) => item.enrichmentId === request.enrichmentId) ?? null;
  if (current === null || !current.isForCurrentDiscovery || current.state !== 'completed') {
    throw new ResearchError('RESUME_CONFIG_MISMATCH', `Finalization requires completed enrichment ${request.enrichmentId} for the current discovery generation.`);
  }
}

function requiredResolvedPath(path: string | null, label: string): string {
  if (path === null) throw new ResearchError('INPUT_SCHEMA_ERROR', `${label} continuation is missing its resolved file path.`);
  return path;
}

function published(publication: LibraryPublicationRunResult): ConfiguredFinalizationResult {
  return {
    outcome: { kind: 'published', state: 'published', publicationId: publication.publicationId },
    fullRun: null,
    traffic: null,
    finalistEvidence: null,
    publication,
  };
}

function awaitingDecisions(
  finalistEvidence: FinalistEvidenceRunResult,
  traffic: TrafficEvidenceRunResult | null,
): ConfiguredFinalizationResult {
  return {
    outcome: {
      kind: 'awaiting_decisions',
      state: 'awaiting_decisions',
      finalistCount: finalistEvidence.finalistCount,
      currentDecisionCount: finalistEvidence.currentHumanDecisionCount,
    },
    fullRun: null,
    traffic,
    finalistEvidence,
    publication: null,
  };
}
