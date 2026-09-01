import {
  IMPLEMENTED_ENRICHMENT_MODULES,
  QUERY_SUGGESTION_SOURCES,
  type QuerySuggestionSource,
} from '../enrichment/types.js';
import { ResearchError } from '../shared/errors.js';

export type JsonContractSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  const?: string | number | boolean;
  enum?: readonly (string | number | boolean)[];
  oneOf?: readonly JsonContractSchema[];
  properties?: Readonly<Record<string, JsonContractSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonContractSchema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  description?: string;
};

export type ResearchInputV1 =
  | { type: 'seeds'; path: string }
  | { type: 'microsoft'; path: string };

export type WorkflowTargetV1 = 'discovery' | 'enrichment' | 'finalization';
export type EnrichmentModuleV1 = (typeof IMPLEMENTED_ENRICHMENT_MODULES)[number];

export type OperatorResearchConfigV1 = {
  version: 1;
  research: {
    label: string;
    input: ResearchInputV1;
    market?: string;
    googleHl?: string;
    googleGl?: string;
  };
  workflow?: { target?: WorkflowTargetV1 };
  discovery?: { topN?: number; expand?: boolean; requireAhrefs?: boolean };
  enrichment?: {
    modules: EnrichmentModuleV1[];
    clustering?: {
      topN?: number;
      minSharedDomains?: number;
      minDomainJaccard?: number;
      minSharedUrls?: number;
      minUrlJaccard?: number;
    };
    querySuggestions?: {
      sources?: QuerySuggestionSource[];
      maxSuggestionsPerSource?: number;
      maxParents?: number;
    };
  };
  finalization?: {
    representativeCount?: number;
    historyPolicy: {
      youngDomainMaxAgeDays: number;
      recentWebPresenceMaxAgeDays: number;
      repurposeGapMinDays: number;
    };
    historicalPresence?: {
      collectionMode?: 'latest' | 'annual';
      recentMonths?: number;
      maxCollections?: number;
      domainCap?: number;
    };
  };
};

/** Author-facing config before preset inheritance is applied. */
export type OperatorResearchConfigSourceV1 = {
  version: 1;
  preset?: string;
  research: OperatorResearchConfigV1['research'];
  workflow?: OperatorResearchConfigV1['workflow'];
  discovery?: OperatorResearchConfigV1['discovery'];
  enrichment?: {
    modules?: EnrichmentModuleV1[];
    clustering?: OperatorResearchConfigV1['enrichment'] extends infer T
      ? T extends { clustering?: infer C } ? C : never
      : never;
    querySuggestions?: OperatorResearchConfigV1['enrichment'] extends infer T
      ? T extends { querySuggestions?: infer Q } ? Q : never
      : never;
  };
  finalization?: {
    representativeCount?: number;
    historyPolicy?: {
      youngDomainMaxAgeDays?: number;
      recentWebPresenceMaxAgeDays?: number;
      repurposeGapMinDays?: number;
    };
    historicalPresence?: {
      collectionMode?: 'latest' | 'annual';
      recentMonths?: number;
      maxCollections?: number;
      domainCap?: number;
    };
  };
};

/** Built-in preset overlay. It deliberately cannot contain labels, input paths, human decisions, or machine settings. */
export type OperatorResearchPresetV1 = {
  version: 1;
  id: string;
  revision: number;
  research?: {
    market?: string;
    googleHl?: string;
    googleGl?: string;
  };
  workflow?: { target?: WorkflowTargetV1 };
  discovery?: { topN?: number; expand?: boolean; requireAhrefs?: boolean };
  enrichment?: {
    modules?: EnrichmentModuleV1[];
    clustering?: {
      topN?: number;
      minSharedDomains?: number;
      minDomainJaccard?: number;
      minSharedUrls?: number;
      minUrlJaccard?: number;
    };
    querySuggestions?: {
      sources?: QuerySuggestionSource[];
      maxSuggestionsPerSource?: number;
      maxParents?: number;
    };
  };
  finalization?: {
    representativeCount?: number;
    historyPolicy?: {
      youngDomainMaxAgeDays?: number;
      recentWebPresenceMaxAgeDays?: number;
      repurposeGapMinDays?: number;
    };
    historicalPresence?: {
      collectionMode?: 'latest' | 'annual';
      recentMonths?: number;
      maxCollections?: number;
      domainCap?: number;
    };
  };
};

export type OperatorContinuationV1 =
  | { version: 1; researchId: string; action: { type: 'shortlist'; path: string } }
  | { version: 1; researchId: string; action: { type: 'finalists'; clusters: string[] } }
  | { version: 1; researchId: string; action: { type: 'finalists_all' } }
  | { version: 1; researchId: string; action: { type: 'representative_overrides'; path: string } }
  | { version: 1; researchId: string; action: { type: 'traffic'; path: string; lowBaseOrganicTrafficThreshold: number } }
  | { version: 1; researchId: string; action: { type: 'decisions'; path: string } }
  | { version: 1; researchId: string; action: { type: 'publication_override'; publishWithoutDecisions: true } };

const STRING_NON_EMPTY = { type: 'string', minLength: 1 } as const satisfies JsonContractSchema;
const PRESET_ID = {
  type: 'string',
  minLength: 1,
  pattern: '^[a-z0-9][a-z0-9-]*$',
  description: 'Built-in preset id using lowercase letters, digits, and hyphens.',
} as const satisfies JsonContractSchema;
const PORTABLE_PATH = {
  type: 'string',
  minLength: 1,
  description: 'Path relative to the JSON file that declares it.',
} as const satisfies JsonContractSchema;

const INPUT_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type', 'path'], properties: { type: { const: 'seeds' }, path: PORTABLE_PATH } },
    { type: 'object', additionalProperties: false, required: ['type', 'path'], properties: { type: { const: 'microsoft' }, path: PORTABLE_PATH } },
  ],
} as const satisfies JsonContractSchema;

const RESEARCH_SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['label', 'input'],
  properties: {
    label: STRING_NON_EMPTY,
    market: { type: 'string', minLength: 1, default: 'US' },
    googleHl: { type: 'string', minLength: 1, default: 'en' },
    googleGl: { type: 'string', minLength: 1, default: 'us' },
    input: INPUT_SCHEMA,
  },
} as const satisfies JsonContractSchema;

const RESEARCH_PRESET_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    market: { type: 'string', minLength: 1 },
    googleHl: { type: 'string', minLength: 1 },
    googleGl: { type: 'string', minLength: 1 },
  },
} as const satisfies JsonContractSchema;

const WORKFLOW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { target: { type: 'string', enum: ['discovery', 'enrichment', 'finalization'], default: 'discovery' } },
} as const satisfies JsonContractSchema;

const DISCOVERY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    topN: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
    expand: { type: 'boolean', default: false },
    requireAhrefs: { type: 'boolean', default: false },
  },
} as const satisfies JsonContractSchema;

const CLUSTERING_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    topN: { type: 'integer', minimum: 1, maximum: 30, default: 10 },
    minSharedDomains: { type: 'integer', minimum: 1, maximum: 30, default: 3 },
    minDomainJaccard: { type: 'number', minimum: 0, maximum: 1, default: 0.3 },
    minSharedUrls: { type: 'integer', minimum: 1, maximum: 30, default: 2 },
    minUrlJaccard: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
  },
} as const satisfies JsonContractSchema;

const QUERY_SUGGESTIONS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    sources: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: QUERY_SUGGESTION_SOURCES } },
    maxSuggestionsPerSource: { type: 'integer', minimum: 1, default: 20 },
    maxParents: { type: 'integer', minimum: 5, maximum: 200, default: 200 },
  },
} as const satisfies JsonContractSchema;

const ENRICHMENT_SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    modules: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: IMPLEMENTED_ENRICHMENT_MODULES } },
    clustering: CLUSTERING_SCHEMA,
    querySuggestions: QUERY_SUGGESTIONS_SCHEMA,
  },
} as const satisfies JsonContractSchema;

const ENRICHMENT_EFFECTIVE_SCHEMA = {
  ...ENRICHMENT_SOURCE_SCHEMA,
  required: ['modules'],
} as const satisfies JsonContractSchema;

const HISTORY_POLICY_SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    youngDomainMaxAgeDays: { type: 'integer', minimum: 0 },
    recentWebPresenceMaxAgeDays: { type: 'integer', minimum: 0 },
    repurposeGapMinDays: { type: 'integer', minimum: 0 },
  },
} as const satisfies JsonContractSchema;

const HISTORY_POLICY_EFFECTIVE_SCHEMA = {
  ...HISTORY_POLICY_SOURCE_SCHEMA,
  required: ['youngDomainMaxAgeDays', 'recentWebPresenceMaxAgeDays', 'repurposeGapMinDays'],
} as const satisfies JsonContractSchema;

const HISTORICAL_PRESENCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    collectionMode: { type: 'string', enum: ['latest', 'annual'], default: 'annual' },
    recentMonths: { type: 'integer', minimum: 1, maximum: 120, default: 18 },
    maxCollections: { type: 'integer', minimum: 1, maximum: 100, default: 24 },
    domainCap: { type: 'integer', minimum: 1, maximum: 100, default: 30 },
  },
} as const satisfies JsonContractSchema;

const FINALIZATION_SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    representativeCount: { type: 'integer', minimum: 3, maximum: 10, default: 5 },
    historyPolicy: HISTORY_POLICY_SOURCE_SCHEMA,
    historicalPresence: HISTORICAL_PRESENCE_SCHEMA,
  },
} as const satisfies JsonContractSchema;

const FINALIZATION_EFFECTIVE_SCHEMA = {
  ...FINALIZATION_SOURCE_SCHEMA,
  required: ['historyPolicy'],
  properties: {
    ...FINALIZATION_SOURCE_SCHEMA.properties,
    historyPolicy: HISTORY_POLICY_EFFECTIVE_SCHEMA,
  },
} as const satisfies JsonContractSchema;

export const OPERATOR_RESEARCH_CONFIG_V1_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'research'],
  properties: {
    version: { const: 1 },
    preset: PRESET_ID,
    research: RESEARCH_SOURCE_SCHEMA,
    workflow: WORKFLOW_SCHEMA,
    discovery: DISCOVERY_SCHEMA,
    enrichment: ENRICHMENT_SOURCE_SCHEMA,
    finalization: FINALIZATION_SOURCE_SCHEMA,
  },
} as const satisfies JsonContractSchema;

const EFFECTIVE_OPERATOR_RESEARCH_CONFIG_V1_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'research'],
  properties: {
    version: { const: 1 },
    research: RESEARCH_SOURCE_SCHEMA,
    workflow: WORKFLOW_SCHEMA,
    discovery: DISCOVERY_SCHEMA,
    enrichment: ENRICHMENT_EFFECTIVE_SCHEMA,
    finalization: FINALIZATION_EFFECTIVE_SCHEMA,
  },
} as const satisfies JsonContractSchema;

export const OPERATOR_RESEARCH_PRESET_V1_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'id', 'revision'],
  properties: {
    version: { const: 1 },
    id: PRESET_ID,
    revision: { type: 'integer', minimum: 1 },
    research: RESEARCH_PRESET_SCHEMA,
    workflow: WORKFLOW_SCHEMA,
    discovery: DISCOVERY_SCHEMA,
    enrichment: ENRICHMENT_SOURCE_SCHEMA,
    finalization: FINALIZATION_SOURCE_SCHEMA,
  },
} as const satisfies JsonContractSchema;

const CONTINUATION_ACTION_SCHEMA = {
  oneOf: [
    { type: 'object', additionalProperties: false, required: ['type', 'path'], properties: { type: { const: 'shortlist' }, path: PORTABLE_PATH } },
    { type: 'object', additionalProperties: false, required: ['type', 'clusters'], properties: { type: { const: 'finalists' }, clusters: { type: 'array', minItems: 1, uniqueItems: true, items: STRING_NON_EMPTY } } },
    { type: 'object', additionalProperties: false, required: ['type'], properties: { type: { const: 'finalists_all' } } },
    { type: 'object', additionalProperties: false, required: ['type', 'path'], properties: { type: { const: 'representative_overrides' }, path: PORTABLE_PATH } },
    { type: 'object', additionalProperties: false, required: ['type', 'path', 'lowBaseOrganicTrafficThreshold'], properties: { type: { const: 'traffic' }, path: PORTABLE_PATH, lowBaseOrganicTrafficThreshold: { type: 'number', minimum: 0 } } },
    { type: 'object', additionalProperties: false, required: ['type', 'path'], properties: { type: { const: 'decisions' }, path: PORTABLE_PATH } },
    { type: 'object', additionalProperties: false, required: ['type', 'publishWithoutDecisions'], properties: { type: { const: 'publication_override' }, publishWithoutDecisions: { const: true } } },
  ],
} as const satisfies JsonContractSchema;

export const OPERATOR_CONTINUATION_V1_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'researchId', 'action'],
  properties: { version: { const: 1 }, researchId: STRING_NON_EMPTY, action: CONTINUATION_ACTION_SCHEMA },
} as const satisfies JsonContractSchema;

export function operatorResearchConfigJsonSchema(): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://local.utility-research-runner/schemas/operator-research-config-v1.schema.json', title: 'Utility Research Runner OperatorResearchConfigV1', ...OPERATOR_RESEARCH_CONFIG_V1_SCHEMA };
}

export function operatorResearchPresetJsonSchema(): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://local.utility-research-runner/schemas/operator-research-preset-v1.schema.json', title: 'Utility Research Runner OperatorResearchPresetV1', ...OPERATOR_RESEARCH_PRESET_V1_SCHEMA };
}

export function operatorContinuationJsonSchema(): Record<string, unknown> {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://local.utility-research-runner/schemas/operator-continuation-v1.schema.json', title: 'Utility Research Runner OperatorContinuationV1', ...OPERATOR_CONTINUATION_V1_SCHEMA };
}

export function validateOperatorResearchConfigSource(value: unknown): OperatorResearchConfigSourceV1 {
  validateContract(OPERATOR_RESEARCH_CONFIG_V1_SCHEMA, value, '$');
  const config = value as OperatorResearchConfigSourceV1;
  validateResearchIdentity(config.research);
  if (config.preset !== undefined) assertPresetId(config.preset, '$.preset');
  return config;
}

export function validateOperatorResearchPreset(value: unknown): OperatorResearchPresetV1 {
  validateContract(OPERATOR_RESEARCH_PRESET_V1_SCHEMA, value, '$');
  const preset = value as OperatorResearchPresetV1;
  assertPresetId(preset.id, '$.id');
  if (preset.research?.market !== undefined) assertNonBlank(preset.research.market, '$.research.market');
  if (preset.research?.googleHl !== undefined) assertNonBlank(preset.research.googleHl, '$.research.googleHl');
  if (preset.research?.googleGl !== undefined) assertNonBlank(preset.research.googleGl, '$.research.googleGl');
  return preset;
}

export function validateOperatorResearchConfig(value: unknown): OperatorResearchConfigV1 {
  validateContract(EFFECTIVE_OPERATOR_RESEARCH_CONFIG_V1_SCHEMA, value, '$');
  const config = value as OperatorResearchConfigV1;
  validateResearchIdentity(config.research);

  const target = config.workflow?.target ?? 'discovery';
  if ((target === 'enrichment' || target === 'finalization') && config.enrichment === undefined) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '$.enrichment is required when $.workflow.target is enrichment or finalization.');
  }
  if (target === 'finalization' && config.finalization === undefined) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '$.finalization is required when $.workflow.target is finalization.');
  }
  const clustering = config.enrichment?.clustering;
  if (clustering !== undefined) {
    const topN = clustering.topN ?? 10;
    if ((clustering.minSharedDomains ?? 3) > topN) throw new ResearchError('INPUT_SCHEMA_ERROR', '$.enrichment.clustering.minSharedDomains cannot exceed topN.');
    if ((clustering.minSharedUrls ?? 2) > topN) throw new ResearchError('INPUT_SCHEMA_ERROR', '$.enrichment.clustering.minSharedUrls cannot exceed topN.');
  }
  if (config.enrichment?.querySuggestions !== undefined && !config.enrichment.modules.includes('query_suggestions')) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', '$.enrichment.querySuggestions requires "query_suggestions" in $.enrichment.modules.');
  }
  return config;
}

export function validateOperatorContinuation(value: unknown): OperatorContinuationV1 {
  validateContract(OPERATOR_CONTINUATION_V1_SCHEMA, value, '$');
  const continuation = value as OperatorContinuationV1;
  assertNonBlank(continuation.researchId, '$.researchId');
  if ('path' in continuation.action) assertPortableRelativePath(continuation.action.path, '$.action.path');
  if (continuation.action.type === 'finalists') {
    for (let index = 0; index < continuation.action.clusters.length; index += 1) {
      assertNonBlank(continuation.action.clusters[index] ?? '', `$.action.clusters[${index}]`);
    }
  }
  return continuation;
}

export function assertPortableRelativePath(value: string, pathLabel: string): void {
  assertNonBlank(value, pathLabel);
  const portable = value.replaceAll('\\', '/');
  if (portable.startsWith('/') || portable.startsWith('//') || /^[A-Za-z]:\//.test(portable)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${pathLabel} must be relative to the JSON file that declares it; absolute machine paths are not allowed.`);
  }
}

function validateResearchIdentity(research: OperatorResearchConfigV1['research']): void {
  assertNonBlank(research.label, '$.research.label');
  if (research.market !== undefined) assertNonBlank(research.market, '$.research.market');
  if (research.googleHl !== undefined) assertNonBlank(research.googleHl, '$.research.googleHl');
  if (research.googleGl !== undefined) assertNonBlank(research.googleGl, '$.research.googleGl');
  assertPortableRelativePath(research.input.path, '$.research.input.path');
}

function assertPresetId(value: string, pathLabel: string): void {
  assertNonBlank(value, pathLabel);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${pathLabel} must use lowercase letters, digits, and hyphens only.`);
  }
}

function validateContract(schema: JsonContractSchema, value: unknown, path: string): void {
  const issues: string[] = [];
  validateInto(schema, value, path, issues);
  if (issues.length > 0) throw new ResearchError('INPUT_SCHEMA_ERROR', issues[0] ?? `${path} is invalid.`);
}

function validateInto(schema: JsonContractSchema, value: unknown, path: string, issues: string[]): void {
  if (schema.oneOf !== undefined) {
    const candidates = schema.oneOf.map((candidate) => {
      const nested: string[] = [];
      validateInto(candidate, value, path, nested);
      return { schema: candidate, issues: nested };
    });
    if (candidates.filter((candidate) => candidate.issues.length === 0).length !== 1) {
      const discriminator = isPlainObject(value) && typeof value.type === 'string' ? value.type : null;
      const discriminated = discriminator === null ? undefined : candidates.find((candidate) => candidate.schema.properties?.type?.const === discriminator);
      const closest = discriminated ?? [...candidates].sort((a, b) => a.issues.length - b.issues.length)[0];
      issues.push(closest?.issues[0] ?? `${path} does not match exactly one allowed shape.`);
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && !Object.is(value, schema.const)) {
    issues.push(`${path} must equal ${JSON.stringify(schema.const)}.`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push(`${path} must be one of: ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}.`);
    return;
  }
  switch (schema.type) {
    case 'object': {
      if (!isPlainObject(value)) { issues.push(`${path} must be an object.`); return; }
      const properties = schema.properties ?? {};
      for (const required of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, required)) issues.push(`${path}.${required} is required.`);
      if (schema.additionalProperties === false) for (const key of Object.keys(value)) if (!(key in properties)) issues.push(`${path}.${key} is an unknown field.`);
      for (const [key, propertySchema] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) validateInto(propertySchema, value[key], `${path}.${key}`, issues);
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) { issues.push(`${path} must be an array.`); return; }
      if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} must contain at least ${schema.minItems} item(s).`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} must contain at most ${schema.maxItems} item(s).`);
      if (schema.uniqueItems) { const keys = value.map((item) => JSON.stringify(item)); if (new Set(keys).size !== keys.length) issues.push(`${path} must contain unique items.`); }
      if (schema.items !== undefined) for (let index = 0; index < value.length; index += 1) validateInto(schema.items, value[index], `${path}[${index}]`, issues);
      return;
    }
    case 'string':
      if (typeof value !== 'string') {
        issues.push(`${path} must be a string.`);
      } else {
        if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} must contain at least ${schema.minLength} character(s).`);
        if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) issues.push(`${path} must match pattern ${schema.pattern}.`);
      }
      return;
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) { issues.push(`${path} must be a finite number.`); return; }
      if (schema.type === 'integer' && !Number.isInteger(value)) issues.push(`${path} must be an integer.`);
      if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} must be >= ${schema.minimum}.`);
      if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} must be <= ${schema.maximum}.`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') issues.push(`${path} must be a boolean.`);
      return;
    default:
      return;
  }
}

function assertNonBlank(value: string, pathLabel: string): void {
  if (value.trim() === '') throw new ResearchError('INPUT_SCHEMA_ERROR', `${pathLabel} must not be blank.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
