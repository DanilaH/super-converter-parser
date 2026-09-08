import { randomUUID } from 'node:crypto';
import type {
  ResearchRunExecution,
  ResearchRunMachineResultV1,
} from '../application/researchWorkflow.js';
import { ResearchError } from '../shared/errors.js';

export type UiJobKind = 'create_research' | 'resume_research';
export type UiJobState = 'running' | 'completed' | 'failed';

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
  error: { code: string; message: string } | null;
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
  }

  start(
    kind: UiJobKind,
    researchId: string | null,
    task: () => Promise<ResearchRunExecution>,
  ): UiJobSnapshotV1 {
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
      error: null,
    };
    this.jobs.set(job.jobId, job);
    this.activeJobId = job.jobId;

    void Promise.resolve()
      .then(task)
      .then((execution) => {
        job.state = 'completed';
        job.result = execution.result;
        job.researchId = execution.result.researchId ?? job.researchId;
        job.finishedAt = this.now().toISOString();
        if (this.activeJobId === job.jobId) this.activeJobId = null;
      })
      .catch((error: unknown) => {
        job.state = 'failed';
        job.error = errorSnapshot(error);
        job.finishedAt = this.now().toISOString();
        if (this.activeJobId === job.jobId) this.activeJobId = null;
      });

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

  private trimFinished(): void {
    if (this.retainFinished < 0) return;
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

function errorSnapshot(error: unknown): { code: string; message: string } {
  if (error instanceof ResearchError) return { code: error.code, message: error.message };
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
