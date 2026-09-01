import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
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
    const draft = this.requireDraft(draftId, 'new');
    return this.deps.runNew(draft.path, this.outputRoot, this.env);
  }

  async status(researchId: string): Promise<ResearchStatusWithHistoricalPresence> {
    return this.deps.buildStatus({ outputRoot: this.outputRoot, targetRunId: researchId });
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
    if (draftId === null) {
      return this.deps.runExisting(researchId, null, this.outputRoot, this.env);
    }
    const draft = this.requireDraft(draftId, 'continuation');
    if (draft.researchId !== researchId) {
      throw new ResearchError(
        'INPUT_SCHEMA_ERROR',
        `GUI continuation draft targets research ${draft.researchId}, not ${researchId}.`,
      );
    }
    return this.deps.runExisting(researchId, draft.path, this.outputRoot, this.env);
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
