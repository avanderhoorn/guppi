import {
  link,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { randomBytes } from "crypto";
import { join } from "path";
import type { GuppiPaths } from "./config";
import type { ProcessIdentity } from "./queue";

const JOB_ID =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/;

export type JobMode = "standard" | "interactive" | "async";

export type JobStatus =
  | "queued-router"
  | "routing"
  | "queued-project"
  | "working"
  | "done"
  | "needs-input"
  | "failed";

export const JOB_STATUSES: readonly JobStatus[] = [
  "queued-router",
  "routing",
  "queued-project",
  "working",
  "done",
  "needs-input",
  "failed"
];

export type Route = {
  project: string | null;
  sourceRoot: string | null;
  reason: string;
  question: string | null;
};

export type Job = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  input: {
    raw: string;
    mode: JobMode;
    projectHint: string | null;
    cwd: string;
    interactiveOwner: ProcessIdentity | null;
  };
  status: JobStatus;
  route: Route | null;
  attempts: {
    router: number;
    project: number;
  };
  error: string | null;
};

export type Submission = {
  raw: string;
  mode: JobMode;
  projectHint: string | null;
  cwd: string;
};

/** Owns durable job records, FIFO selection, and lifecycle transitions. */
export class Jobs {
  constructor(private readonly paths: GuppiPaths) {}

  /** Creates the sole durable copy of a submission's raw input. */
  async register(
    submission: Submission,
    interactiveOwner: ProcessIdentity | null = null
  ): Promise<Job> {
    const latest = (await this.list()).at(-1);
    const now = new Date(
      Math.max(
        Date.now(),
        latest ? Date.parse(latest.createdAt) + 1 : 0
      )
    ).toISOString();
    const id = `${now.replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`;
    const job: Job = {
      version: 1,
      id,
      createdAt: now,
      updatedAt: now,
      input: {
        raw: submission.raw,
        mode: submission.mode,
        projectHint: submission.projectHint,
        cwd: submission.cwd,
        interactiveOwner
      },
      status: "queued-router",
      route: null,
      attempts: {
        router: 0,
        project: 0
      },
      error: null
    };

    await createJob(this.pathFor(id), job);
    return job;
  }

  /** Reads one job by its stable identifier. */
  async read(id: string): Promise<Job> {
    return JSON.parse(await readFile(this.pathFor(id), "utf8")) as Job;
  }

  /** Returns all jobs in deterministic FIFO order. */
  async list(): Promise<Job[]> {
    const files = (await readdir(this.paths.jobs))
      .filter((file) => file.endsWith(".json"))
      .sort();
    const jobs = await Promise.all(
      files.map((file) => this.read(file.slice(0, -5)))
    );
    return jobs.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id)
    );
  }

  /** Selects the oldest job in a status that satisfies the worker predicate. */
  async next(
    status: JobStatus,
    eligible: (job: Job) => boolean = () => true
  ): Promise<Job | null> {
    return (await this.list()).find(
      (job) => job.status === status && eligible(job)
    ) || null;
  }

  /** Marks a router turn active and records its attempt. */
  routing(id: string): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      status: "routing",
      error: null,
      attempts: {
        ...job.attempts,
        router: job.attempts.router + 1
      }
    }));
  }

  /** Persists the router decision and advances to project work or clarification. */
  routed(id: string, route: Route): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      route,
      status: route.project ? "queued-project" : "needs-input",
      error: null
    }));
  }

  /** Marks a project turn active and records its attempt. */
  working(id: string): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      status: "working",
      error: null,
      attempts: {
        ...job.attempts,
        project: job.attempts.project + 1
      }
    }));
  }

  /** Marks a job complete after durable project incorporation is confirmed. */
  done(id: string): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      status: "done",
      error: null
    }));
  }

  /** Returns a failed router turn to its FIFO queue for another bounded attempt. */
  requeueRouter(id: string, error: unknown): Promise<Job> {
    return this.retry(id, "queued-router", error);
  }

  /** Returns a failed project turn to its FIFO queue for another bounded attempt. */
  requeueProject(id: string, error: unknown): Promise<Job> {
    return this.retry(id, "queued-project", error);
  }

  /** Records a terminal failure without duplicating raw input in the error. */
  fail(id: string, error: unknown): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      status: "failed",
      error: formatError(error, job.input.raw)
    }));
  }

  private pathFor(id: string): string {
    if (!JOB_ID.test(id)) throw new Error(`invalid job ID: ${id}`);
    return join(this.paths.jobs, `${id}.json`);
  }

  private async update(
    id: string,
    update: (job: Job) => Job
  ): Promise<Job> {
    const next = update(await this.read(id));
    next.updatedAt = new Date().toISOString();
    await writeJob(this.pathFor(id), next);
    return next;
  }

  private retry(
    id: string,
    status: "queued-router" | "queued-project",
    error: unknown
  ): Promise<Job> {
    return this.update(id, (job) => ({
      ...job,
      status,
      error: formatError(error, job.input.raw)
    }));
  }
}

async function createJob(path: string, job: Job): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(job, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function writeJob(path: string, job: Job): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(job, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function redactRawInput(message: string, rawInput: string): string {
  return rawInput
    ? message.split(rawInput).join("[raw input omitted]")
    : message;
}

function formatError(error: unknown, rawInput: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactRawInput(message, rawInput).slice(0, 4096);
}
