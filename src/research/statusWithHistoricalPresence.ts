import { join } from 'node:path';
import { RunStore } from '../db/store.js';
import { loadEntrantCohortState } from '../db/entrantCohorts.js';
import { loadCohortHistoricalPresenceState } from '../db/cohortHistoricalPresence.js';
import {
  projectSampledHistoricalPresenceCoverage,
  type SampledHistoricalPresenceCoverage,
} from '../historicalPresence/evidenceProjection.js';
import { buildResearchStatus, type ResearchStatus } from './status.js';

export type ResearchStatusWithHistoricalPresence = Omit<ResearchStatus, 'version'> & {
  version: '1.2.0';
  sampledHistoricalPresence: SampledHistoricalPresenceCoverage | null;
};

export async function buildResearchStatusWithHistoricalPresence(input: {
  outputRoot: string;
  targetRunId: string;
}): Promise<ResearchStatusWithHistoricalPresence> {
  const base = await buildResearchStatus(input);
  if (base.legacy || base.currentEnrichmentId === null) {
    return { ...base, version: '1.2.0', sampledHistoricalPresence: null };
  }

  const enrichment = base.enrichments.find(
    (item) => item.enrichmentId === base.currentEnrichmentId && item.isLatestForCurrentDiscovery,
  );
  if (!enrichment) {
    throw new Error(`Current enrichment ${base.currentEnrichmentId} is missing from the read-only status projection.`);
  }

  const store = RunStore.openReadOnly(
    join(base.researchDirectory, enrichment.directoryName, 'enrichment.sqlite'),
  );
  try {
    const entrant = loadEntrantCohortState(store, enrichment.enrichmentId);
    const state = loadCohortHistoricalPresenceState(store, enrichment.enrichmentId);
    return {
      ...base,
      version: '1.2.0',
      sampledHistoricalPresence: projectSampledHistoricalPresenceCoverage({
        cohorts: entrant?.cohorts ?? null,
        state,
      }),
    };
  } finally {
    store.close();
  }
}
