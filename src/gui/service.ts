import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../db/store.js';
import {
  operatorContinuationJsonSchema,
  operatorResearchConfigJsonSchema,
  operatorResearchPresetJsonSchema,
} from '../operatorConfig/contracts.js';
import { buildExistingResearchPlan, type ResearchExecutionPlan } from '../operatorConfig/planner.js';
import { loadBuiltInOperatorPreset } from '../operatorConfig/presets.js';
import { readOperatorConfigProvenance } from '../operatorConfig/provenance.js';
import {
  loadOperatorContinuation,
  loadOperatorResearchConfig,
} from '../operatorConfig/resolve.js';
import { resolveOutputRoot } from '../outputs/researchLayout.js';
import { buildResearchStatusWithHistoricalPresence, type ResearchStatusWithHistoricalPresence } from '../research/statusWithHistoricalPresence.js';
import { ResearchError } from '../shared/errors.js';
import {
  runResearchFromConfig,
  runResearchFromExisting,
  type ResearchRunExecution,
} from '../cli/researchRun.js';

export type GuiDraftFiles = Record<string, string>;
export type GuiClusterList = ReturnType<RunStore['loadKeywordClusters']>;

export type GuiBootstrap = {
  schemas: {
    researchConfig: Record<string, unknown>;
    continuation: Record<string, unknown>;
    preset: Record<string, unknown>;
  };
  presets: Awaited<ReturnType<typeof loadBuiltInOperatorPreset>>[];
  outputRoot: string;
};

export type GuiResearchList = {
  researches: ResearchStatusWithHistoricalPresence[];
  errors: Array<{ runId: string; message: string }>;
};

export type GuiPlannedDraft = {
  draftId: string | null;
  plan: ResearchExecutionPlan;
};

type StoredDraft =
  | { kind: 'new'; path: string }
  | { kind: 'continuation'; path: string; researchId: string };

type GuiServiceDeps = {
  loadConfig: typeof loadOperatorResearchConfig;
  loadContinuation: typeof loadOperatorContinuation;
  readProvenance: typeof readOperatorConfigProvenance;
  buildStatus: typeof buildResearchStatusWithHistoricalPresence;
  buildExistingPlan: typeof buildExistingResearchPlan;
  runNew: (configPath: string, outputRoot: string, env: NodeJS.ProcessEnv) => Promise<ResearchRunExecution>;
  runExisting: (
    researchId: string,
    continuationPath: string | null,
    outputRoot: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<ResearchRunExecution>;
};

const DEFAULT_DEPS: GuiServiceDeps = {
  loadConfig: loadOperatorResearchConfig,
  loadContinuation: loadOperatorContinuation,
  readProvenance: readOperatorConfigProvenance,
  buildStatus: buildResearchStatusWithHistoricalPresence,
  buildExistingPlan: buildExistingResearchPlan,
  runNew: (configPath, outputRoot, env) => runResearchFromConfig(configPath, outputRoot, undefined, env),
  runExisting: (researchId, continuationPath, outputRoot, env) =>
    runResearchFromExisting(researchId, continuationPath, outputRoot, undefined, env),
};

const PRESET_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../configs/presets',
);

export class OperatorGuiService {
  readonly outputRoot: string;
  readonly draftRoot: string;
  readonly env: NodeJS.ProcessEnv;
  private readonly deps: GuiServiceDeps;
  private readonly drafts = new Map<string, StoredDraft>();
  private readonly inFlightDrafts = new Set<string>();
  private activeExecution: string | null = null;

  constructor(input: {
    outputRoot: string;
    draftRoot: string;
    env?: NodeJS.ProcessEnv;
    deps?: Partial<GuiServiceDeps>;
  }) {
    this.outputRoot = resolve(input.outputRoot);
    this.draftRoot = resolve(input.draftRoot);
    this.env = input.env ?? process.env;
    this.deps = { ...DEFAULT_DEPS, ...input.deps };
  }

  static async create(input: {
    outputRoot?: string | null;
    env?: NodeJS.ProcessEnv;
    draftRoot?: string;
    deps?: Partial<GuiServiceDeps>;
  } = {}): Promise<OperatorGuiService> {
    const env = input.env ?? process.env;
    const outputRoot = resolveOutputRoot(input.outputRoot, env);
    const draftRoot = input.draftRoot === undefined
      ? await mkdtemp(join(tmpdir(), 'utility-research-gui-'))
      : resolve(input.draftRoot);
    await mkdir(draftRoot, { recursive: true });
    return new OperatorGuiService({
      outputRoot,
      draftRoot,
      env,
      ...(input.deps === undefined ? {} : { deps: input.deps }),
    });
  }

  async close(): Promise<void> {
    this.drafts.clear();
    this.inFlightDrafts.clear();
    this.activeExecution = null;
    await rm(this.draftRoot, { recursive: true, force: true });
  }

  async bootstrap(): Promise<GuiBootstrap> {
    const entries = await readdir(PRESET_DIRECTORY, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
      .map((entry) => entry.name.slice(0, -'.json'.length))
      .sort((a, b) => a.localeCompare(b));
    const presets = await Promise.all(ids.map((id) => loadBuiltInOperatorPreset(id)));
    return {
      schemas: {
        researchConfig: operatorResearchConfigJsonSchema(),
        continuation: operatorContinuationJsonSchema(),
        preset: operatorResearchPresetJsonSchema(),
      },
      presets,
      outputRoot: this.outputRoot,
    };
  }

  async planNew(config: unknown, files: GuiDraftFiles = {}): Promise<GuiPlannedDraft> {
    const draft = await this.materialize('research.config.json', config, files);
    try {
      const loaded = await this.deps.loadConfig(draft.path);
      this.drafts.set(draft.id, { kind: 'new', path: draft.path });
      return { draftId: draft.id, plan: loaded.plan };
    } catch (error) {
      await rm(draft.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async runNew(draftId: string): Promise<ResearchRunExecution> {
    this.beginExecution(`new research draft ${draftId}`);
    let draft: Extract<StoredDraft, { kind: 'new' }> | null = null;
    try {
      draft = this.beginDraft(draftId, 'new');
      const result = await this.deps.runNew(draft.path, this.outputRoot, this.env);
      if (result.result.researchId !== null) await this.consumeDraft(draftId, draft);
      else this.inFlightDrafts.delete(draftId);
      return result;
    } catch (error) {
      if (draft !== null) this.inFlightDrafts.delete(draftId);
      throw error;
    } finally {
      this.endExecution();
    }
  }

  async status(researchId: string): Promise<ResearchStatusWithHistoricalPresence> {
    return this.deps.buildStatus({ outputRoot: this.outputRoot, targetRunId: researchId });
  }

  async clusters(researchId: string): Promise<GuiClusterList> {
    const status = await this.status(researchId);
    const current = currentEnrichment(status);
    if (current === null) return [];
    const store = RunStore.openReadOnly(join(status.researchDirectory, current.directoryName, 'enrichment.sqlite'));
    try {
      return store.loadKeywordClusters(current.enrichmentId)
        .sort((a, b) => a.clusterId.localeCompare(b.clusterId, undefined, { numeric: true }));
    } finally {
      store.close();
    }
  }

  async finalistEvidence(researchId: string): Promise<Record<string, unknown> | null> {
    const status = await this.status(researchId);
    const current = currentEnrichment(status);
    if (current === null) return null;
    const path = join(status.researchDirectory, current.directoryName, 'finalist-evidence-matrix.json');
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to read current finalist evidence ${path}.`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Current finalist evidence is invalid JSON: ${path}.`, { cause: error });
    }
    if (!isRecord(parsed) || !isRecord(parsed.matrix) || !Array.isArray(parsed.matrix.finalists)) {
      throw new ResearchError('OUTPUT_WRITE_ERROR', `Current finalist evidence has an invalid artifact shape: ${path}.`);
    }
    return parsed;
  }

  async planExisting(
    researchId: string,
    continuation: unknown | null,
    files: GuiDraftFiles = {},
  ): Promise<GuiPlannedDraft> {
    const status = await this.status(researchId);
    const provenance = await this.deps.readProvenance(status.researchDirectory);
    if (continuation === null) {
      return {
        draftId: null,
        plan: this.deps.buildExistingPlan(status, null, provenance),
      };
    }

    const draft = await this.materialize('continuation.json', continuation, files);
    try {
      const loaded = await this.deps.loadContinuation(draft.path);
      const plan = this.deps.buildExistingPlan(status, loaded, provenance);
      this.drafts.set(draft.id, { kind: 'continuation', path: draft.path, researchId: status.researchId });
      return { draftId: draft.id, plan };
    } catch (error) {
      await rm(draft.directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async runExisting(researchId: string, draftId: string | null): Promise<ResearchRunExecution> {
    this.beginExecution(`research ${researchId}`);
    let draft: Extract<StoredDraft, { kind: 'continuation' }> | null = null;
    try {
      draft = draftId === null ? null : this.beginDraft(draftId, 'continuation');
      if (draft !== null && draft.researchId !== researchId) {
        this.inFlightDrafts.delete(draftId as string);
        throw new ResearchError(
          'INPUT_SCHEMA_ERROR',
          `GUI continuation draft targets research ${draft.researchId}, not ${researchId}.`,
        );
      }

      const result = await this.deps.runExisting(researchId, draft?.path ?? null, this.outputRoot, this.env);
      if (draft !== null && draftId !== null) await this.consumeDraft(draftId, draft);
      return result;
    } catch (error) {
      if (draft !== null && draftId !== null) this.inFlightDrafts.delete(draftId);
      throw error;
    } finally {
      this.endExecution();
    }
  }

  async listResearches(): Promise<GuiResearchList> {
    const runIds = await listIndexedRunIds(this.outputRoot);
    const canonical = new Map<string, ResearchStatusWithHistoricalPresence>();
    const errors: GuiResearchList['errors'] = [];
    for (const runId of runIds) {
      try {
        const status = await this.status(runId);
        const existing = canonical.get(status.researchId);
        if (existing === undefined || existing.discovery.updatedAt < status.discovery.updatedAt) {
          canonical.set(status.researchId, status);
        }
      } catch (error) {
        errors.push({ runId, message: error instanceof Error ? error.message : String(error) });
      }
    }
    const researches = [...canonical.values()].sort((a, b) =>
      b.discovery.updatedAt.localeCompare(a.discovery.updatedAt) || a.researchId.localeCompare(b.researchId),
    );
    return { researches, errors };
  }

  private beginExecution(label: string): void {
    if (this.activeExecution !== null) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `Another research execution is already active through this GUI (${this.activeExecution}).`,
      );
    }
    this.activeExecution = label;
  }

  private endExecution(): void {
    this.activeExecution = null;
  }

  private beginDraft<T extends StoredDraft['kind']>(
    draftId: string,
    kind: T,
  ): Extract<StoredDraft, { kind: T }> {
    if (this.inFlightDrafts.has(draftId)) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `GUI draft ${draftId} is already executing.`);
    }
    const draft = this.requireDraft(draftId, kind);
    this.inFlightDrafts.add(draftId);
    return draft;
  }

  private requireDraft<T extends StoredDraft['kind']>(
    draftId: string,
    kind: T,
  ): Extract<StoredDraft, { kind: T }> {
    const draft = this.drafts.get(draftId);
    if (draft === undefined || draft.kind !== kind) {
      throw new ResearchError('INPUT_SCHEMA_ERROR', `Unknown or incompatible GUI draft: ${draftId}.`);
    }
    return draft as Extract<StoredDraft, { kind: T }>;
  }

  private async consumeDraft(draftId: string, draft: StoredDraft): Promise<void> {
    this.inFlightDrafts.delete(draftId);
    this.drafts.delete(draftId);
    await rm(dirname(draft.path), { recursive: true, force: true }).catch(() => undefined);
  }

  private async materialize(
    jsonName: string,
    document: unknown,
    files: GuiDraftFiles,
  ): Promise<{ id: string; directory: string; path: string }> {
    const id = randomUUID();
    const directory = join(this.draftRoot, id);
    await mkdir(directory, { recursive: false });
    try {
      for (const [logicalPath, content] of Object.entries(files)) {
        const target = resolveGuiDraftPath(directory, logicalPath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      }
      const path = join(directory, jsonName);
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
      return { id, directory, path };
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export async function listIndexedRunIds(outputRoot: string): Promise<string[]> {
  const directory = join(resolve(outputRoot), 'index', 'runs');
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw new ResearchError('OUTPUT_WRITE_ERROR', `Failed to list research run index ${directory}.`, { cause: error });
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((runId) => /^[A-Za-z0-9_-]+$/.test(runId))
    .sort((a, b) => a.localeCompare(b));
}

function currentEnrichment(
  status: ResearchStatusWithHistoricalPresence,
): ResearchStatusWithHistoricalPresence['enrichments'][number] | null {
  if (status.currentEnrichmentId === null) return null;
  const current = status.enrichments.find(
    (item) => item.enrichmentId === status.currentEnrichmentId && item.isLatestForCurrentDiscovery,
  );
  if (current === undefined) {
    throw new ResearchError(
      'OUTPUT_WRITE_ERROR',
      `Current enrichment ${status.currentEnrichmentId} is missing from research ${status.researchId}.`,
    );
  }
  return current;
}

function resolveGuiDraftPath(root: string, logicalPath: string): string {
  const portable = logicalPath.replaceAll('\\', '/');
  const segments = portable.split('/');
  if (
    portable === ''
    || portable.startsWith('/')
    || /^[A-Za-z]:\//.test(portable)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ResearchError(
      'INPUT_SCHEMA_ERROR',
      `GUI uploaded file path must be a clean relative path without traversal: ${logicalPath}.`,
    );
  }
  const target = resolve(root, ...segments);
  const relativePath = target.slice(resolve(root).length + 1);
  if (relativePath.startsWith(`..${sep}`) || target === resolve(root)) {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `GUI uploaded file escapes its draft root: ${logicalPath}.`);
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
