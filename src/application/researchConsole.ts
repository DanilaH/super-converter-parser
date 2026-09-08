import { buildExistingResearchPlan } from '../operatorConfig/planner.js';
import { readOperatorConfigProvenance, type PersistedOperatorConfigV1 } from '../operatorConfig/provenance.js';
import { readResearchContainer, type ResearchContainer } from '../research/batches.js';
import type { ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { inspectResearch, type ResearchControlOptions } from './researchControl.js';

export type ResearchConsoleHumanRequirement = 'shortlist' | 'finalist_scope' | 'human_decisions';

export type ResearchConsoleDetail = {
  version: 1;
  status: ResearchStatusWithHistoricalPresence;
  container: ResearchContainer | null;
  operatorConfig: PersistedOperatorConfigV1 | null;
  humanRequirement: ResearchConsoleHumanRequirement | null;
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
    humanRequirement: projectConsoleHumanRequirement(status, operatorConfig),
  };
}

export function projectConsoleHumanRequirement(
  status: ResearchStatusWithHistoricalPresence,
  operatorConfig: PersistedOperatorConfigV1 | null,
): ResearchConsoleHumanRequirement | null {
  if (status.legacy || operatorConfig === null) return null;
  const plan = buildExistingResearchPlan(status, null, operatorConfig);
  const requirements = plan.unresolvedHumanRequirements.filter(isConsoleHumanRequirement);
  if (requirements.length > 1) {
    throw new Error(`Existing research plan exposed multiple simultaneous human gates: ${requirements.join(', ')}.`);
  }
  return requirements[0] ?? null;
}

function isConsoleHumanRequirement(value: string): value is ResearchConsoleHumanRequirement {
  return value === 'shortlist' || value === 'finalist_scope' || value === 'human_decisions';
}
