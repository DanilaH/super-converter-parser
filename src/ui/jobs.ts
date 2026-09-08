import { randomUUID } from 'node:crypto';
import type { ResearchBatchExecutionResultV1 } from '../application/researchBatches.js';
import type { ResearchDiscoveryRepairResultV1 } from '../application/researchRepair.js';
import type {
  ResearchRunExecution,
  ResearchRunMachineResultV1,
} from '../application/researchWorkflow.js';
import { ResearchError } from '../shared/errors.js';

export type UiJobKind = 'create_research' | 'resume_research' | 'shortlist_research' | 'finalist_scope_research' | 'decisions_research' | 'repair_discovery' | 'append_batch';
export type UiJobState = 'running' | 'finished' | 'failed';

export type UiJobSnapshotV1 = {
  version: 1;
  jobId: string;
  kind: UiJobKind;
  state: UiJobState;
  researchId: string | null;
  createdAt: string;
  startedAt: string;
  finishedAt: string | null;
  result: ResearchRunMachineResultV1 | null;
  repairResult: ResearchDiscoveryRepairResultV1 | null;
  batchResult: ResearchBatchExecutionResultV1 | null;
  error: { code: string; message: string } | null;
};

export type UiJobControl = {
  setResearchId: (researchId: string) => void;
};

export class UiJobBusyError extends Error {
  readonly activeJob: UiJobSnapshotV1;

  constructor(activeJob: UiJobSnapshotV1) {
    super(`Another UI execution job is already running: ${activeJob.jobId}.`);
    this.name = 'UiJobBusyError';
    this.activeJob = activeJob;
  }
}

export type UiJobRegistryOptions = {
  now?: () => Date;
  createId?: () => string;
  retainFinished?: number;
};

type WorkflowJobKind = 'create_research' | 'resume_research' | 'shortlist_research' | 'finalist_scope_research' | 'decisions_research';

export class UiJobRegistry {
  private readonly jobs = new Map<string, UiJobSnapshotV1>();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly retainFinished: number;
  private activeJobId: string | null = null;

  constructor(options: UiJobRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
    this.retainFinished = options.retainFinished ?? 50;
    if (!Number.isInteger(this.retainFinished) || this.retainFinished < 0) {
      throw new RangeError('retainFinished must be a non-negative integer.');
    }
  }

  start(
    kind: WorkflowJobKind,
    researchId: string | null,
    task: (control: UiJobControl) => Promise<ResearchRunExecution>,
  ): UiJobSnapshotV1 {
    const job = this.begin(kind, researchId);
    const control: UiJobControl = {
      setResearchId: (nextResearchId) => {
        const normalized = nextResearchId.trim();
        if (normalized === '') {
          throw new ResearchError('INPUT_SCHEMA_ERROR', 'UI job research id must not be empty.');
        }
        job.researchId = normalized;
      },
    };

    void Promise.resolve()
      .then(() => task(control))
      .then((execution) => {
        job.result = execution.result;
        job.researchId = execution.result.researchId ?? job.researchId;
        this.finish(job);
      })
      .catch((error: unknown) => this.fail(job, error));

    return snapshot(job);
  }

  startRepair(
    researchId: string,
    task: () => Promise<ResearchDiscoveryRepairResultV1>,
  ): UiJobSnapshotV1 {
    const normalizedId = requireJobResearchId(researchId, 'Repair');
    const job = this.begin('repair_discovery', normalizedId);

    void Promise.resolve()
      .then(task)
      .then((result) => {
        job.repairResult = { ...result };
        job.researchId = result.researchId;
        this.finish(job);
      })
      .catch((error: unknown) => this.fail(job, error));

    return snapshot(job);
  }

  startBatch(
    researchId: string,
    task: () => Promise<ResearchBatchExecutionResultV1>,
  ): UiJobSnapshotV1 {
    const normalizedId = requireJobResearchId(researchId, 'Batch');
    const job = this.begin('append_batch', normalizedId);

    void Promise.resolve()
      .then(task)
      .then((result) => {
        job.batchResult = cloneBatchResult(result);
        job.researchId = result.researchId;
        this.finish(job);
      })
      .catch((error: unknown) => this.fail(job, error));

    return snapshot(job);
  }

  get(jobId: string): UiJobSnapshotV1 | null {
    const job = this.jobs.get(jobId);
    return job ? snapshot(job) : null;
  }

  list(): UiJobSnapshotV1[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId))
      .map(snapshot);
  }

  active(): UiJobSnapshotV1 | null {
    if (this.activeJobId === null) return null;
    const job = this.jobs.get(this.activeJobId);
    return job ? snapshot(job) : null;
  }

  private begin(kind: UiJobKind, researchId: string | null): UiJobSnapshotV1 {
    const active = this.activeJobId === null ? null : this.jobs.get(this.activeJobId) ?? null;
    if (active?.state === 'running') throw new UiJobBusyError(snapshot(active));

    this.trimFinished();
    const startedAt = this.now().toISOString();
    const job: UiJobSnapshotV1 = {
      version: 1,
      jobId: this.createId(),
      kind,
      state: 'running',
      researchId,
      createdAt: startedAt,
      startedAt,
      finishedAt: null,
      result: null,
      repairResult: null,
      batchResult: null,
      error: null,
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;
    return job;
  }

  private finish(job: UiJobSnapshotV1): void {
    job.state = 'finished';
    job.finishedAt = this.now().toISOString();
    if (this.activeJobId === job.jobId) this.activeJobId = null;
    this.trimFinished();
  }

  private fail(job: UiJobSnapshotV1, error: unknown): void {
    job.state = 'failed';
    job.error = errorSnapshot(error);
    job.finishedAt = this.now().toISOString();
    if (this.activeJobId === job.jobId) this.activeJobId = null;
    this.trimFinished();
  }

  private trimFinished(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.state !== 'running')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.jobId.localeCompare(a.jobId));
    for (const job of finished.slice(this.retainFinished)) this.jobs.delete(job.jobId);
  }
}

function snapshot(job: UiJobSnapshotV1): UiJobSnapshotV1 {
  return {
    ...job,
    result: job.result === null ? null : cloneResult(job.result),
    repairResult: job.repairResult === null ? null : { ...job.repairResult },
    batchResult: job.batchResult === null ? null : cloneBatchResult(job.batchResult),
    error: job.error === null ? null : { ...job.error },
  };
}

function cloneResult(result: ResearchRunMachineResultV1): ResearchRunMachineResultV1 {
  return {
    ...result,
    unresolvedHumanRequirements: [...result.unresolvedHumanRequirements],
    stageFingerprints: { ...result.stageFingerprints },
  };
}

function cloneBatchResult(result: ResearchBatchExecutionResultV1): ResearchBatchExecutionResultV1 {
  return {
    ...result,
    promotedNormalizedKeywords: [...result.promotedNormalizedKeywords],
    discovery: { ...result.discovery },
  };
}

function requireJobResearchId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === '') {
    throw new ResearchError('INPUT_SCHEMA_ERROR', `${label} job research id must not be empty.`);
  }
  return normalized;
}

function errorSnapshot(error: unknown): { code: string; message: string } {
  if (error instanceof ResearchError) return { code: error.code, message: error.message };
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
