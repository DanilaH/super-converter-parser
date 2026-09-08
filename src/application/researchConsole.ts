import { readOperatorConfigProvenance, type PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import { readResearchContainer, type ResearchContainer } from '../research/batches.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { inspectResearch, type ResearchControlOptions } from './researchControl.js';

export type ResearchConsoleDetail = {
  version: 1;
  status: ResearchStatusWithHistoricalPresence;
  container: ResearchContainer | null;
  operatorConfig: PersistedOperatorConfigV1 | null;
};

export async function inspectResearchConsole(
  researchId: string,
  options: Pick<ResearchControlOptions, 'outputRoot' | 'env' | 'deps'> = {},
): Promise<ResearchConsoleDetail> {
  const status = await inspectResearch(researchId, options);
  const container = status.legacy ? null : await readResearchContainer(status.researchDirectory);
  const operatorConfig = status.legacy ? null : await readOperatorConfigProvenance(status.researchDirectory);
  return {
    version: 1,
    status,
    container,
    operatorConfig,
  };
}
