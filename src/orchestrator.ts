import { createAgent, type InvokeAgent } from "./agent";
import { loadRuntime } from "./config";
import {
  createGitRunner,
  ProjectHistory,
  type RunGit
} from "./git";
import { Jobs, type Job, type Submission } from "./jobs";
import { Projects } from "./project";
import {
  Queue,
  type ActiveLock,
  type ProcessIdentity,
  type QueueWork
} from "./queue";
import { Router } from "./router";
import { JOB_STATUSES, type JobStatus } from "./jobs";

export type RuntimeStatus = {
  jobs: Record<JobStatus, number>;
  locks: ActiveLock[];
};

/** Coordinates durable job registration, router draining, and project draining. */
export class Orchestrator {
  private constructor(
    private readonly jobs: Jobs,
    private readonly router: Router,
    private readonly projects: Projects,
    private readonly queue: Queue
  ) {}

  /** Creates the complete runtime object graph from environment and provider input. */
  static async create(
    env: NodeJS.ProcessEnv = process.env,
    invoke?: InvokeAgent,
    runGit?: RunGit
  ): Promise<Orchestrator> {
    const runtime = await loadRuntime(env);
    const queue = new Queue(runtime.paths.locks);
    const runAgent = createAgent(
      runtime.paths.sessions,
      runtime.paths.copilot,
      runtime.paths.skills,
      queue,
      invoke,
      env
    );
    return new Orchestrator(
      new Jobs(runtime.paths),
      new Router(
        runAgent,
        runtime.paths.routerMemory,
        runtime.paths.copilot
      ),
      new Projects(
        runtime.paths,
        runtime.config.projectsRoot,
        runAgent,
        new ProjectHistory(
          runGit || createGitRunner(queue, runtime.paths.copilot, env)
        )
      ),
      queue
    );
  }

  /** Persists one submission without starting any agent work. */
  async register(submission: Submission): Promise<Job> {
    const interactiveOwner =
      submission.mode === "interactive"
        ? await this.queue.currentIdentity()
        : null;
    return this.queue.exclusive("jobs", () =>
      this.jobs.register(submission, interactiveOwner)
    );
  }

  /** Waits through the shared router FIFO and returns the requested routed job. */
  async route(jobId: string): Promise<Job> {
    await this.queue.waitOrDrain(
      this.router.workerKey,
      () => this.leftRouter(jobId),
      this.routerWork()
    );
    return this.jobs.read(jobId);
  }

  /** Advances one existing job through any remaining routing and project work. */
  async drive(jobId: string): Promise<Job> {
    let routed = await this.jobs.read(jobId);
    if (routed.status === "queued-router" || routed.status === "routing") {
      routed = await this.route(jobId);
    }
    if (
      routed.status !== "queued-project" &&
      routed.status !== "working"
    ) {
      return routed;
    }

    const current = await this.queue.currentIdentity();
    const workerKey = this.projects.workerKey(routed.route!.project!);
    const others =
      routed.input.mode === "interactive"
        ? []
        : this.projects
            .pendingWorkerKeys(await this.jobs.list())
            .filter((candidate) => candidate !== workerKey);

    await Promise.all([
      this.queue.waitOrDrain(
        workerKey,
        () => this.leftProject(jobId),
        this.projectWork(workerKey, current)
      ),
      ...others.map((candidate) =>
        this.queue.drain(
          candidate,
          this.projectWork(candidate, current)
        )
      )
    ]);
    return this.jobs.read(jobId);
  }

  /** Best-effort drains every router and project worker with pending work. */
  async wake(): Promise<void> {
    await this.queue.drain(this.router.workerKey, this.routerWork());
    const current = await this.queue.currentIdentity();
    const workerKeys = this.projects.pendingWorkerKeys(await this.jobs.list());
    await Promise.all(
      workerKeys.map((workerKey) =>
        this.queue.drain(workerKey, this.projectWork(workerKey, current))
      )
    );
  }

  /** Reads one job or summarizes all jobs and active worker locks. */
  async status(jobId?: string): Promise<Job | RuntimeStatus> {
    if (jobId) {
      try {
        return await this.jobs.read(jobId);
      } catch (error) {
        if (isNotFound(error)) throw new Error(`job not found: ${jobId}`);
        throw error;
      }
    }

    const counts = Object.fromEntries(
      JOB_STATUSES.map((status) => [status, 0])
    ) as Record<JobStatus, number>;
    for (const job of await this.jobs.list()) counts[job.status] += 1;
    return {
      jobs: counts,
      locks: (await this.queue.activeLocks()).filter(
        (lock) =>
          lock.workerKey !== "sessions" && lock.workerKey !== "jobs"
      )
    };
  }

  private routerWork(): QueueWork<Job> {
    return {
      recover: () => this.recoverRouter(),
      next: () => this.jobs.next("queued-router"),
      handle: (job) => this.routeJob(job)
    };
  }

  private projectWork(
    workerKey: string,
    current: ProcessIdentity
  ): QueueWork<Job> {
    return {
      recover: () => this.recoverProject(workerKey),
      next: () => this.nextProject(workerKey, current),
      handle: (job) => this.incorporate(job)
    };
  }

  private async routeJob(job: Job): Promise<void> {
    await this.jobs.routing(job.id);
    try {
      // This selected snapshot still carries the prior error cleared on disk above.
      const route = await this.router.route(
        job,
        await this.projects.catalog(await this.jobs.list())
      );
      await this.jobs.routed(job.id, route);
    } catch (error) {
      const current = await this.jobs.read(job.id);
      if (current.attempts.router >= 3) {
        await this.jobs.fail(job.id, error);
      } else {
        await this.jobs.requeueRouter(job.id, error);
      }
    }
  }

  private async incorporate(job: Job): Promise<"continue" | "stop"> {
    await this.jobs.working(job.id);
    try {
      await this.projects.incorporate(job);
      await this.jobs.done(job.id);
    } catch (error) {
      let failure = error;
      try {
        if (await this.projects.recoverCompletion(job)) {
          await this.jobs.done(job.id);
          return job.input.mode === "interactive" ? "stop" : "continue";
        }
      } catch (recoveryError) {
        failure = combineErrors(error, recoveryError);
      }
      await this.projectFailed(job, failure);
    }
    return job.input.mode === "interactive" ? "stop" : "continue";
  }

  private async nextProject(
    workerKey: string,
    current: ProcessIdentity
  ): Promise<Job | null> {
    while (true) {
      const job = await this.jobs.next(
        "queued-project",
        (candidate) => this.projects.belongsTo(candidate, workerKey)
      );
      if (!job || job.input.mode !== "interactive") return job;
      if (sameIdentity(job.input.interactiveOwner, current)) return job;
      if (await this.queue.isLive(job.input.interactiveOwner)) return null;
      await this.jobs.fail(
        job.id,
        new Error("interactive owner exited before its project turn")
      );
    }
  }

  private async recoverRouter(): Promise<void> {
    const active = (await this.jobs.list()).filter(
      (job) => job.status === "routing"
    );
    if (active.length > 1) {
      throw new Error("multiple active router jobs found during recovery");
    }
    const [job] = active;
    if (!job) return;
    const error = new Error("router owner exited during its turn");
    if (job.attempts.router >= 3) {
      await this.jobs.fail(job.id, error);
    } else {
      await this.jobs.requeueRouter(job.id, error);
    }
  }

  private async recoverProject(workerKey: string): Promise<void> {
    const active = (await this.jobs.list()).filter(
      (job) =>
        job.status === "working" &&
        this.projects.belongsTo(job, workerKey)
    );
    if (active.length > 1) {
      throw new Error(`multiple active jobs found for ${workerKey}`);
    }
    const [job] = active;
    if (!job) return;
    try {
      if (await this.projects.recoverCompletion(job)) {
        await this.jobs.done(job.id);
        return;
      }
    } catch (error) {
      await this.projectFailed(job, error);
      return;
    }
    await this.projectFailed(
      job,
      new Error("project owner exited during its turn")
    );
  }

  private async projectFailed(job: Job, error: unknown): Promise<void> {
    const current = await this.jobs.read(job.id);
    if (
      job.input.mode === "interactive" ||
      current.attempts.project >= 3
    ) {
      await this.jobs.fail(job.id, error);
    } else {
      await this.jobs.requeueProject(job.id, error);
    }
  }

  private async leftRouter(jobId: string): Promise<boolean> {
    const status = (await this.jobs.read(jobId)).status;
    return status !== "queued-router" && status !== "routing";
  }

  private async leftProject(jobId: string): Promise<boolean> {
    const status = (await this.jobs.read(jobId)).status;
    return status !== "queued-project" && status !== "working";
  }
}

function sameIdentity(
  left: ProcessIdentity | null,
  right: ProcessIdentity
): boolean {
  return Boolean(
    left &&
    left.pid === right.pid &&
    left.startFingerprint === right.startFingerprint
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function combineErrors(primary: unknown, recovery: unknown): Error {
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  return new Error(
    `${message(primary)}; completion recovery failed: ${message(recovery)}`
  );
}
