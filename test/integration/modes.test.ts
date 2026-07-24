import assert from "node:assert/strict";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess
} from "child_process";
import { once } from "events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  writeFile
} from "fs/promises";
import {
  request as httpRequest,
  type IncomingHttpHeaders
} from "node:http";
import test, { type TestContext } from "node:test";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { promisify } from "util";
import { main } from "../../src/cli";
import { loadRuntime } from "../../src/config";
import { Orchestrator } from "../../src/orchestrator";
import { Queue } from "../../src/queue";

const execFile = promisify(execFileCallback);
const GUPPI_BIN = resolve(__dirname, "..", "..", "..", "bin", "guppi.js");

test("standard returns after routing while project work continues", async () => {
  const fixture = await createFixture();
  const barrier = join(fixture.root, "project.release");
  const { stdout, stderr } = await runGuppi(
    ["Capture standard work"],
    {
      ...fixture.env,
      GUPPI_FAKE_PROJECT_BARRIER: barrier
    }
  );

  assert.equal(stderr, "");
  const jobId = outputJobId(stdout);
  assert.match(stdout, new RegExp(`^${jobId} -> Alpha\\n$`));
  assert.ok(["queued-project", "working"].includes((await readJob(fixture)).status));
  await writeFile(barrier, "release\n", "utf8");
  assert.equal((await waitForJob(fixture, "done")).status, "done");
  assert.deepEqual(await readdir(fixture.configHome), ["config.json"]);
});

test("async returns before routing finishes", async () => {
  const fixture = await createFixture();
  const barrier = join(fixture.root, "router.release");
  const { stdout, stderr } = await runGuppi(
    ["--async", "Capture async work"],
    {
      ...fixture.env,
      GUPPI_FAKE_ROUTER_BARRIER: barrier
    }
  );

  assert.equal(stderr, "");
  const jobId = outputJobId(stdout);
  assert.equal(stdout, `${jobId}\n`);
  assert.ok(["queued-router", "routing"].includes((await readJob(fixture)).status));
  await writeFile(barrier, "release\n", "utf8");
  assert.equal((await waitForJob(fixture, "done")).status, "done");
});

test("standard wakes older work even when its own route needs input", async () => {
  const fixture = await createFixture();
  assert.equal(
    await main(
      ["--async", "Older work"],
      io([], []),
      {
        ...fixture.env,
        NODE_OPTIONS: "--guppi-invalid-node-option"
      }
    ),
    1
  );

  const { stdout, stderr } = await runGuppi(
    ["Ambiguous request"],
    fixture.env
  );
  assert.equal(stderr, "");
  assert.match(stdout, /: Which project\?\n$/);
  await waitForStatusSet(fixture, ["done", "needs-input"]);
});

test("interactive stays attached through the project turn", async () => {
  const fixture = await createFixture();
  const child = spawn(
    process.execPath,
    [GUPPI_BIN, "--interactive", "Capture interactive work"],
    {
      env: {
        ...fixture.env,
        GUPPI_FAKE_INTERACTIVE_STDIN: "true"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));

  await waitForCallCount(fixture.log, "project", 1);
  const owner = JSON.parse(
    await readFile(
      join(fixture.guppiHome, "_locks", "project-alpha", "owner.json"),
      "utf8"
    )
  ) as { owner: { pid: number } };
  assert.equal(owner.owner.pid, child.pid);
  assert.equal(child.exitCode, null);
  child.stdin.write("continue\n");
  child.stdin.end();
  const [exitCode] = await once(child, "exit");

  assert.equal(exitCode, 0);
  assert.equal(stderr.join(""), "");
  const output = stdout.join("");
  const jobId = outputJobId(output);
  assert.equal((await readJob(fixture)).status, "done");
  const calls = await readCalls(fixture.log);
  const project = calls.find((call) => call.kind === "project");
  assert.ok(project);
  assert.ok(project.args.includes("--interactive"));
  assert.equal(project.args.includes("-p"), false);
  assert.ok(project.args.includes("--yolo"));
  assert.equal(project.args.includes("--no-ask-user"), false);
  assert.ok(
    project.args.includes(
      "--available-tools=skill,view,glob,grep,edit,create,web_fetch,task,ask_user"
    )
  );
  assert.ok(project.args.includes("--allow-tool=skill"));
  assert.equal(
    project.skills,
    await realpath(
      join(fixture.guppiHome, ".agents", "skills", "project")
    )
  );
  assert.equal(project.payload.isInteractive, true);
  assert.equal(
    calls.find((call) => call.kind === "project-end")?.payload.input,
    "continue"
  );
  await waitForNoLocks(fixture);
  assert.match(output, new RegExp(`^${jobId} -> Alpha\\n$`));
});

test("service accepts durable jobs and remains attached", async (context) => {
  const fixture = await createFixture();
  const barrier = join(fixture.root, "service-project.release");
  const serviceCwd = join(fixture.root, "service-cwd");
  await mkdir(serviceCwd, { recursive: true });
  const expectedCwd = await realpath(serviceCwd);
  const service = await spawnService(
    context,
    fixture,
    {
      ...fixture.env,
      GUPPI_FAKE_PROJECT_BARRIER: barrier
    },
    serviceCwd
  );
  const prompt = "Capture service work without logging this phrase";
  const response = await postServiceJob(service.endpoint, {
    prompt,
    projectHint: "  Alpha  "
  });

  assert.equal(response.status, 202);
  const { jobId } = JSON.parse(response.body) as { jobId: string };
  const stored = await readJobById(fixture, jobId);
  assert.deepEqual(stored.input, {
    raw: prompt,
    mode: "async",
    projectHint: "Alpha",
    cwd: expectedCwd,
    interactiveOwner: null
  });
  assert.equal(service.child.exitCode, null);
  assert.doesNotMatch(service.stdout(), new RegExp(prompt));
  assert.doesNotMatch(service.stderr(), new RegExp(prompt));

  await writeFile(barrier, "release\n", "utf8");
  assert.equal((await waitForJobById(fixture, jobId, "done")).status, "done");
  await waitForNoLocks(fixture);
  assert.doesNotMatch(service.stdout(), new RegExp(prompt));
  assert.doesNotMatch(service.stderr(), new RegExp(prompt));
  assert.equal(service.child.exitCode, null);
});

test("the targeted drive used by service waits through a live router lock", async (context) => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const queue = new Queue(runtime.paths.locks);
  const orchestrator = await Orchestrator.create(fixture.env);
  let releaseOwner!: () => void;
  const ownerRelease = new Promise<void>((resolvePromise) => {
    releaseOwner = resolvePromise;
  });
  let confirmOwner!: () => void;
  const ownerAcquired = new Promise<void>((resolvePromise) => {
    confirmOwner = resolvePromise;
  });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseOwner();
  };
  const holding = queue.exclusive("router", async () => {
    confirmOwner();
    await ownerRelease;
  });
  context.after(async () => {
    release();
    await holding;
  });
  await ownerAcquired;

  const registered = await orchestrator.register({
    raw: "Capture work submitted during foreign ownership",
    mode: "async",
    projectHint: null,
    cwd: fixture.root
  });
  let settled = false;
  const driving = orchestrator.drive(registered.id).then((job) => {
    settled = true;
    return job;
  });
  await delay(150);
  assert.equal(settled, false);
  assert.equal(
    (await readJobById(fixture, registered.id)).status,
    "queued-router"
  );

  release();
  await holding;
  assert.equal((await driving).status, "done");
  await waitForNoLocks(fixture);
});

test("service startup wakes pre-existing backlog", async (context) => {
  const fixture = await createFixture();
  const orchestrator = await Orchestrator.create(fixture.env);
  const registered = await orchestrator.register({
    raw: "Backlog before service startup",
    mode: "async",
    projectHint: null,
    cwd: fixture.root
  });

  const service = await spawnService(context, fixture);
  assert.equal(
    (await waitForJobById(fixture, registered.id, "done")).status,
    "done"
  );
  await waitForNoLocks(fixture);
  assert.equal(service.child.exitCode, null);
});

test("two standard jobs for one project serialize", async () => {
  const fixture = await createFixture();
  const barrier = join(fixture.root, "project.release");
  const env = {
    ...fixture.env,
    GUPPI_FAKE_PROJECT_BARRIER: barrier
  };

  await Promise.all([
    runGuppi(["Capture first work"], env),
    runGuppi(["Capture second work"], env)
  ]);
  const active = await waitForProjectStatuses(fixture, 2);
  assert.equal(active.filter((job) => job.status === "working").length, 1);
  assert.equal(
    active.filter((job) => job.status === "queued-project").length,
    1
  );
  await waitForCallCount(fixture.log, "project", 1);
  assert.equal(
    (await readCalls(fixture.log)).filter((call) => call.kind === "project")
      .length,
    1
  );
  await writeFile(barrier, "release\n", "utf8");
  await waitForJobs(fixture, 2, "done");

  const calls = await readCalls(fixture.log);
  const projectCalls = calls.filter((call) => call.kind === "project");
  assert.equal(projectCalls.length, 2);
  assert.equal(
    sessionId(projectCalls[0].args),
    sessionId(projectCalls[1].args)
  );
  const kinds = calls
    .map((call) => call.kind)
    .filter((kind) => kind === "project" || kind === "project-end");
  assert.deepEqual(kinds, [
    "project",
    "project-end",
    "project",
    "project-end"
  ]);
  const jobs = await readJobs(fixture);
  const receipts = await readFile(
    join(fixture.guppiHome, "Alpha", ".guppi-receipts"),
    "utf8"
  );
  const memory = await readFile(
    join(fixture.guppiHome, "Alpha", "agents.md"),
    "utf8"
  );
  const journal = await readFile(
    join(fixture.guppiHome, "Alpha", "project.md"),
    "utf8"
  );
  for (const job of jobs) {
    assert.equal(receipts.split(job.id).length - 1, 1);
    assert.equal(journal.split(`- ${job.id}`).length - 1, 1);
  }
  assert.doesNotMatch(memory, /Processed Jobs/);
});

test("worker startup failure is reported", async () => {
  const fixture = await createFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await main(
      ["--async", "Capture work"],
      io(stdout, stderr),
      {
        ...fixture.env,
        NODE_OPTIONS: "--guppi-invalid-node-option"
      }
    ),
    1
  );
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /worker failed to start/);
  assert.equal((await readJob(fixture)).status, "queued-router");
});

test("interactive does not print success when its wake worker fails", async () => {
  const fixture = await createFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await main(
      ["--interactive", "Capture work"],
      io(stdout, stderr),
      {
        ...fixture.env,
        NODE_OPTIONS: "--guppi-invalid-node-option"
      }
    ),
    1
  );
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /job completed, but worker failed to start/);
  assert.equal((await readJob(fixture)).status, "done");
});

type Fixture = {
  root: string;
  configHome: string;
  guppiHome: string;
  log: string;
  env: NodeJS.ProcessEnv;
};

type FakeCall = {
  args: string[];
  kind: "router" | "project" | "project-end";
  skills?: string;
  payload: {
    input?: string;
    isInteractive?: boolean;
  };
};

type StoredJob = {
  id: string;
  status: string;
  input: {
    raw: string;
    mode: string;
    projectHint: string | null;
    cwd: string;
    interactiveOwner: unknown;
  };
};

type ServiceProcess = {
  child: ChildProcess;
  endpoint: string;
  stdout: () => string;
  stderr: () => string;
};

type ServiceResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "guppi-modes-"));
  const home = join(root, "home");
  const configHome = join(home, ".guppi");
  const guppiHome = join(home, "guppi-state");
  const projectsRoot = join(home, "Projects");
  const bin = join(root, "bin");
  const log = join(root, "copilot.ndjson");
  await mkdir(configHome, { recursive: true });
  await writeFile(
    join(configHome, "config.json"),
    `${JSON.stringify({
      version: 1,
      projectsRoot,
      guppiRoot: guppiHome
    }, null, 2)}\n`,
    "utf8"
  );
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "copilot");
  await writeFile(executable, FAKE_COPILOT, "utf8");
  await chmod(executable, 0o755);
  return {
    root,
    configHome,
    guppiHome,
    log,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GUPPI_HOME: configHome,
      GUPPI_FAKE_LOG: log,
      PATH: `${bin}:${process.env.PATH || ""}`
    }
  };
}

async function runGuppi(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFile(process.execPath, [GUPPI_BIN, ...args], {
    env,
    timeout: 5000
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
}

async function spawnService(
  context: TestContext,
  fixture: Fixture,
  env: NodeJS.ProcessEnv = fixture.env,
  cwd = fixture.root
): Promise<ServiceProcess> {
  const child = spawn(
    process.execPath,
    [GUPPI_BIN, "service", "--port", "0"],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  });

  const endpoint = await waitForServiceReady(child, stdout, stderr);
  return {
    child,
    endpoint,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join("")
  };
}

function waitForServiceReady(
  child: ChildProcess,
  stdout: string[],
  stderr: string[],
  timeoutMs = 5000
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`service readiness timed out: ${stderr.join("")}`));
    }, timeoutMs);
    const onData = () => {
      const match = stdout
        .join("")
        .match(
          /Guppi service listening: POST (http:\/\/127\.0\.0\.1:\d+\/jobs)\n/
        );
      if (!match) return;
      cleanup();
      resolvePromise(match[1]);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      const outcome = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      reject(
        new Error(
          `service exited before readiness with ${outcome}: ${stderr.join("")}`
        )
      );
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
    onData();
  });
}

function postServiceJob(
  endpoint: string,
  payload: { prompt: string; projectHint?: string | null }
): Promise<ServiceResponse> {
  const target = new URL(endpoint);
  const body = JSON.stringify(payload);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        port: Number(target.port),
        path: target.pathname,
        method: "POST",
        agent: false,
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString()
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolvePromise({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function readJob(fixture: Fixture): Promise<StoredJob> {
  const jobs = await readJobs(fixture);
  assert.equal(jobs.length, 1);
  return jobs[0];
}

async function readJobById(
  fixture: Fixture,
  jobId: string
): Promise<StoredJob> {
  return JSON.parse(
    await readFile(join(fixture.guppiHome, "_jobs", `${jobId}.json`), "utf8")
  ) as StoredJob;
}

async function waitForJob(
  fixture: Fixture,
  status: string,
  timeoutMs = 5000
): Promise<StoredJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await readJob(fixture);
    if (job.status === status) return job;
    await delay(25);
  }
  throw new Error(`job did not reach ${status}`);
}

async function waitForJobById(
  fixture: Fixture,
  jobId: string,
  status?: string,
  timeoutMs = 5000
): Promise<StoredJob> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = (await readJobs(fixture)).find(
      (candidate) => candidate.id === jobId
    );
    if (job && (!status || job.status === status)) return job;
    await delay(25);
  }
  throw new Error(
    status
      ? `${jobId} did not reach ${status}`
      : `${jobId} was not durably registered`
  );
}

async function waitForJobs(
  fixture: Fixture,
  count: number,
  status: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await readJobs(fixture);
    if (
      jobs.length === count &&
      jobs.every((job) => job.status === status)
    ) {
      return;
    }
    await delay(25);
  }
  throw new Error(`${count} jobs did not reach ${status}`);
}

async function waitForStatusSet(
  fixture: Fixture,
  statuses: string[],
  timeoutMs = 5000
): Promise<void> {
  const expected = [...statuses].sort();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const actual = (await readJobs(fixture))
      .map((job) => job.status)
      .sort();
    if (actual.length === expected.length && actual.every(
      (status, index) => status === expected[index]
    )) {
      return;
    }
    await delay(25);
  }
  throw new Error(`jobs did not reach ${expected.join(", ")}`);
}

async function waitForProjectStatuses(
  fixture: Fixture,
  count: number,
  timeoutMs = 5000
): Promise<StoredJob[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const jobs = await readJobs(fixture);
    if (
      jobs.length === count &&
      jobs.every(
        (job) =>
          job.status === "queued-project" || job.status === "working"
      ) &&
      jobs.some((job) => job.status === "working")
    ) {
      return jobs;
    }
    await delay(25);
  }
  throw new Error(`${count} jobs did not reach project work`);
}

async function waitForNoLocks(
  fixture: Fixture,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await (await Orchestrator.create(fixture.env)).status();
    if ("locks" in status && status.locks.length === 0) return;
    await delay(25);
  }
  throw new Error("worker locks did not clear");
}

async function readJobs(
  fixture: Fixture
): Promise<StoredJob[]> {
  const files = (await readdir(join(fixture.guppiHome, "_jobs")))
    .filter((file) => file.endsWith(".json"))
    .sort();
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(
        await readFile(join(fixture.guppiHome, "_jobs", file), "utf8")
      ) as StoredJob
    )
  );
}

async function readCalls(path: string): Promise<FakeCall[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeCall);
}

async function waitForCallCount(
  path: string,
  kind: FakeCall["kind"],
  count: number,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const calls = await readCalls(path);
      if (calls.filter((call) => call.kind === kind).length >= count) {
        return;
      }
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error(`${kind} did not reach ${count} calls`);
}

function outputJobId(output: string): string {
  const [jobId] = output.trim().split(/\s+/);
  assert.match(
    jobId,
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}$/
  );
  return jobId;
}

function sessionId(args: string[]): string {
  const index = args.indexOf("--session-id");
  assert.ok(index >= 0);
  return args[index + 1];
}

function io(stdout: string[], stderr: string[]) {
  return {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message)
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const promptFlag = args.includes("-p") ? "-p" : "--interactive";
const prompt = args[args.indexOf(promptFlag) + 1];
const inputStart = prompt.indexOf("<guppi-input>\\n") + "<guppi-input>\\n".length;
const inputEnd = prompt.indexOf("\\n</guppi-input>", inputStart);
const payload = JSON.parse(prompt.slice(inputStart, inputEnd));
const isRouter = args.includes("--available-tools=skill,view,glob,grep,edit");
fs.appendFileSync(
  process.env.GUPPI_FAKE_LOG,
  JSON.stringify({
    args,
    kind: isRouter ? "router" : "project",
    payload,
    skills: process.env.COPILOT_SKILLS_DIRS
  }) + "\\n"
);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForFile = async (path) => {
  if (!path) return;
  while (!fs.existsSync(path)) await delay(10);
};
const emit = (content) => {
  if (args.includes("--output-format")) {
    process.stdout.write(JSON.stringify({
      type: "assistant.message",
      data: { content }
    }) + "\\n");
  } else {
    process.stdout.write(content);
  }
};

(async () => {
  if (isRouter) {
    await waitForFile(process.env.GUPPI_FAKE_ROUTER_BARRIER);
    if (payload.rawInput.includes("Ambiguous")) {
      emit(JSON.stringify({
        project: null,
        sourceRoot: null,
        reason: "The destination is ambiguous.",
        question: "Which project?"
      }));
      return;
    }
    emit(JSON.stringify({
      project: "Alpha",
      sourceRoot: null,
      reason: "The model chose Alpha.",
      question: null
    }));
    return;
  }

  if (!isRouter) {
    let input = null;
    if (
      args.includes("--interactive") &&
      process.env.GUPPI_FAKE_INTERACTIVE_STDIN
    ) {
      input = await new Promise((resolve) => {
        process.stdin.once("data", (chunk) => resolve(String(chunk).trim()));
      });
    }
    await waitForFile(process.env.GUPPI_FAKE_PROJECT_BARRIER);
    fs.writeFileSync(
      path.join(process.cwd(), ".guppi-commit-message"),
      "Incorporate project job\\n"
    );
    fs.appendFileSync(
      path.join(process.cwd(), "project.md"),
      "- " + payload.jobId + "\\n"
    );
    fs.appendFileSync(
      process.env.GUPPI_FAKE_LOG,
      JSON.stringify({
        args: [],
        kind: "project-end",
        payload: { input }
      }) + "\\n"
    );
    if (!args.includes("--interactive")) emit("");
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
