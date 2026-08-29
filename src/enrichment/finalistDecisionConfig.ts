import type { FinalistDecisionInput } from '../db/finalistDecisions.js';
import type { FinalistBuildDecision, FinalistSeoProductRole } from './finalistEvidence.js';

const BUILD_DECISIONS: ReadonlySet<string> = new Set(['build', 'watch', 'reject', 'unknown']);
const SEO_PRODUCT_ROLES: ReadonlySet<string> = new Set([
  'acquisition_anchor',
  'strong_supporting_tool',
  'completeness_tool',
  'experimental',
  'not_applicable',
]);

export function parseFinalistDecisionsJson(content: string, label = 'finalist decisions'): FinalistDecisionInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array`);

  const seen = new Set<string>();
  return parsed.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`${label} row ${index + 1} must be an object`);
    const allowed = new Set(['clusterId', 'buildDecision', 'seoProductRole']);
    const unknownKeys = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`${label} row ${index + 1} has unknown field(s): ${unknownKeys.join(', ')}`);
    }

    const clusterId = readClusterId(raw.clusterId, `${label} row ${index + 1}`);
    if (seen.has(clusterId)) throw new Error(`${label} contains duplicate cluster ${clusterId}`);
    seen.add(clusterId);

    const buildDecision = readBuildDecision(raw.buildDecision, `${label} row ${index + 1}`);
    const seoProductRole = readSeoProductRole(raw.seoProductRole, `${label} row ${index + 1}`);
    return { clusterId, buildDecision, seoProductRole };
  });
}

function readClusterId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} requires non-empty clusterId`);
  return value.trim();
}

function readBuildDecision(value: unknown, label: string): FinalistBuildDecision | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !BUILD_DECISIONS.has(value)) {
    throw new Error(`${label} buildDecision must be build, watch, reject, unknown, or null`);
  }
  return value as FinalistBuildDecision;
}

function readSeoProductRole(value: unknown, label: string): FinalistSeoProductRole | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !SEO_PRODUCT_ROLES.has(value)) {
    throw new Error(
      `${label} seoProductRole must be acquisition_anchor, strong_supporting_tool, completeness_tool, experimental, not_applicable, or null`,
    );
  }
  return value as FinalistSeoProductRole;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
