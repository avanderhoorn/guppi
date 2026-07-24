import { spawn, type ChildProcess } from "child_process";
import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option
} from "commander";
import { resolve } from "path";
import { createInterface } from "readline/promises";
import {
  createConfig,
  DEFAULT_PROJECTS_ROOT,
  MissingConfigError
} from "./config";
import type { Job, JobMode } from "./jobs";
import {
  Orchestrator,
  type RuntimeStatus
} from "./orchestrator";
import { JOB_STATUSES } from "./jobs";
import {
  DEFAULT_SERVICE_PORT,
  startService
} from "./service";

type Io = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  prompt?: (message: string) => Promise<string>;
};

type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean };
type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean };

type IntakeOptions = {
  interactive?: boolean;
  project?: string;
  async?: boolean;
};

type ServiceOptions = {
  port: number;
};

const WORKER_START_TIMEOUT_MS = 5000;

/** Parses one CLI invocation, runs its job flow, and returns the process exit code. */
export async function main(
  argv: string[],
  io: Io = defaultIo(),
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const program = new Command();
  let commandExitCode = 0;
  program
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr
    });
  program
    .name("guppi")
    .description("Route one thought into durable project state.")
    .argument("<message...>", "thought to route")
    .addOption(
      new Option("-i, --interactive", "own the project turn in this terminal").conflicts(
        "async"
      )
    )
    .option("-p, --project <hint>", "strong project hint")
    .addOption(
      new Option("-a, --async", "return after registering the job").conflicts(
        "interactive"
      )
    )
    .action(async (message: string[], options: IntakeOptions) => {
      let jobId: string | null = null;
      try {
        const mode: JobMode = options.interactive
          ? "interactive"
          : options.async
            ? "async"
            : "standard";
        const orchestrator = await createVisibleOrchestrator(io, env);
        const registered = await orchestrator.register({
          raw: message.join(" "),
          mode,
          projectHint: options.project || null,
          cwd: process.cwd()
        });
        jobId = registered.id;

        if (mode === "async") {
          await launchWorker(registered.id, env);
          io.stdout(`${registered.id}\n`);
          return;
        }

        if (mode === "standard") {
          const routed = await orchestrator.route(registered.id);
          try {
            await launchWorker(registered.id, env);
          } catch (error) {
            commandExitCode = 1;
            renderWorkerFailure(routed, error, io);
            return;
          }
          commandExitCode = renderJob(routed, mode, io);
          return;
        }

        const completed = await orchestrator.drive(registered.id);
        try {
          await launchWorker(registered.id, env);
        } catch (error) {
          commandExitCode = 1;
          renderWorkerFailure(completed, error, io);
          return;
        }
        commandExitCode = renderJob(completed, mode, io);
      } catch (error) {
        commandExitCode = 1;
        io.stderr(`${jobId ? `${jobId}: ` : ""}${errorMessage(error)}\n`);
      }
    });

  program
    .command("__worker <jobId>", { hidden: true })
    .action(async (jobId: string) => {
      const orchestrator = await Orchestrator.create(env);
      await acknowledgeWorker();
      const job = await orchestrator.drive(jobId);
      await orchestrator.wake();
      commandExitCode = job.status === "failed" ? 1 : 0;
    });

  program
    .command("service")
    .description("run the attached loopback HTTP service")
    .option(
      "--port <port>",
      "loopback HTTP port",
      parseServicePort,
      DEFAULT_SERVICE_PORT
    )
    .action(async (options: ServiceOptions) => {
      try {
        await runAttachedService(options.port, io, env);
      } catch (error) {
        commandExitCode = 1;
        io.stderr(`${errorMessage(error)}\n`);
      }
    });

  program
    .command("status [jobId]")
    .description("show Guppi queue or job status")
    .action(async (jobId?: string) => {
      try {
        const orchestrator = await createVisibleOrchestrator(io, env);
        const status = await orchestrator.status(jobId);
        if (jobId) {
          io.stdout(`${JSON.stringify(status, null, 2)}\n`);
        } else {
          renderStatus(status as RuntimeStatus, io);
        }
      } catch (error) {
        commandExitCode = 1;
        io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      }
    });

  try {
    await program.parseAsync(argv, { from: "user" });
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }
      return error.exitCode;
    }
    throw error;
  }
}

async function runAttachedService(
  port: number,
  io: Io,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const orchestrator = await createVisibleOrchestrator(io, env);
  const service = await startService(orchestrator, {
    port,
    cwd: process.cwd(),
    diagnostic: (message) => io.stderr(`${message}\n`)
  });
  io.stdout(
    `Guppi service listening: POST http://${service.address.host}:${service.address.port}/jobs\n`
  );
  await service.lifetime;
}

async function createVisibleOrchestrator(
  io: Io,
  env: NodeJS.ProcessEnv
): Promise<Orchestrator> {
  try {
    return await Orchestrator.create(env);
  } catch (error) {
    if (!(error instanceof MissingConfigError)) throw error;
    if (!io.prompt) {
      throw new Error(
        `Guppi is not configured. Run this command in an interactive terminal or create ${error.configPath} with {"version":1,"projectsRoot":"${DEFAULT_PROJECTS_ROOT}"}`
      );
    }

    let answer: string;
    try {
      answer = await io.prompt(
        `Projects root [${DEFAULT_PROJECTS_ROOT}]: `
      );
    } catch {
      throw new Error("Guppi setup cancelled");
    }
    await createConfig(
      answer.trim() || DEFAULT_PROJECTS_ROOT,
      env,
      process.cwd()
    );
    return Orchestrator.create(env);
  }
}

function defaultIo(): Io {
  return {
    stdout: (message) => process.stdout.write(message),
    stderr: (message) => process.stderr.write(message),
    prompt: terminalPrompt()
  };
}

export function terminalPrompt(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stdout
): Io["prompt"] {
  if (input.isTTY !== true || output.isTTY !== true) {
    return undefined;
  }
  return async (message) => {
    const reader = createInterface({
      input,
      output
    });
    const controller = new AbortController();
    reader.once("SIGINT", () => controller.abort());
    const closed = new Promise<never>((_resolve, reject) => {
      reader.once("close", () => reject(new Error("Guppi setup cancelled")));
    });
    try {
      return await Promise.race([
        reader.question(message, { signal: controller.signal }),
        closed
      ]);
    } catch {
      throw new Error("Guppi setup cancelled");
    } finally {
      reader.close();
    }
  };
}

function renderJob(job: Job, mode: JobMode, io: Io): number {
  if (job.status === "failed") {
    io.stderr(`${job.id}: ${job.error || "job failed"}\n`);
    return 1;
  }
  if (mode === "async") {
    io.stdout(`${job.id}\n`);
    return 0;
  }
  if (job.status === "needs-input") {
    io.stdout(`${job.id}: ${job.route?.question}\n`);
    return 0;
  }
  if (job.status === "queued-project") {
    if (mode === "interactive") {
      io.stderr(`${job.id}: interactive turn is still queued\n`);
      return 1;
    }
    io.stdout(`${job.id} -> ${job.route?.project}\n`);
    return 0;
  }
  if (mode === "standard" && job.status === "working") {
    io.stdout(`${job.id} -> ${job.route?.project}\n`);
    return 0;
  }
  if (job.status !== "done") {
    io.stderr(`${job.id}: job remains ${job.status}\n`);
    return 1;
  }
  io.stdout(`${job.id} -> ${job.route?.project}\n`);
  return 0;
}

function renderWorkerFailure(job: Job, error: unknown, io: Io): void {
  const outcome =
    job.status === "failed"
      ? `job failed: ${job.error || "unknown error"}; `
      : job.status === "needs-input"
        ? `job needs input: ${job.route?.question || "clarification required"}; `
        : job.status === "done"
          ? "job completed, but "
          : "";
  io.stderr(`${job.id}: ${outcome}${errorMessage(error)}\n`);
}

async function launchWorker(
  jobId: string,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const child = spawn(
    process.execPath,
    [resolve(__dirname, "..", "..", "bin", "guppi.js"), "__worker", jobId],
    {
      detached: true,
      env,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    }
  );

  try {
    await waitForWorker(child);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    if (child.connected) child.disconnect();
    child.unref();
    throw new Error(`worker failed to start: ${errorMessage(error)}`);
  }

  if (child.connected) child.disconnect();
  child.unref();
}

function waitForWorker(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("startup acknowledgement timed out"));
    }, WORKER_START_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      if (!isWorkerReady(message)) return;
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const exit = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      reject(new Error(`exited before acknowledgement with ${exit}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function acknowledgeWorker(): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (!process.send) {
      reject(new Error("worker requires an IPC parent"));
      return;
    }
    process.send({ type: "ready" }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

function isWorkerReady(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "ready"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseServicePort(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError(
      "service port must be an integer from 0 to 65535"
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535) {
    throw new InvalidArgumentError(
      "service port must be an integer from 0 to 65535"
    );
  }
  return port;
}

function renderStatus(status: RuntimeStatus, io: Io): void {
  for (const jobStatus of JOB_STATUSES) {
    io.stdout(`${jobStatus}: ${status.jobs[jobStatus]}\n`);
  }
  if (!status.locks.length) {
    io.stdout("locks: none\n");
    return;
  }
  io.stdout("locks:\n");
  for (const lock of status.locks) {
    const child = lock.childPid === null ? "" : ` child=${lock.childPid}`;
    io.stdout(`  ${lock.workerKey} pid=${lock.pid}${child}\n`);
  }
}
