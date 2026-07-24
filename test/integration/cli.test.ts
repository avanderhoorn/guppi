import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir
} from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";
import { PassThrough } from "stream";
import {
  main,
  terminalPrompt
} from "../../src/cli";
import {
  createConfig,
  loadRuntime,
  MissingConfigError
} from "../../src/config";
import { Jobs } from "../../src/jobs";

test("help succeeds without an error diagnostic", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  assert.equal(await main(["--help"], io(stdout, stderr)), 0);
  assert.match(stdout.join(""), /Usage: guppi/);
  assert.match(stdout.join(""), /\bservice\b/);
  assert.doesNotMatch(stdout.join(""), /--service/);
  assert.equal(stderr.join(""), "");
});

test("conflicting modes fail", async () => {
  const stderr: string[] = [];
  assert.equal(await main(["-i", "-a", "message"], io([], stderr)), 1);
  assert.ok(stderr.join("").trim());
});

test("status reports an empty isolated runtime", async () => {
  const fixture = await createFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  assert.equal(
    await main(
      ["status"],
      io(stdout, stderr, async () => {
        throw new Error("configured status must not prompt");
      }),
      fixture.env
    ),
    0
  );
  assert.match(stdout.join(""), /queued-router: 0/);
  assert.match(stdout.join(""), /failed: 0/);
  assert.match(stdout.join(""), /locks: none/);
  assert.equal(stderr.join(""), "");
});

test("first visible command asks for projectsRoot and persists it", async () => {
  const fixture = await createUnconfiguredFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const questions: string[] = [];

  assert.equal(
    await main(
      ["status"],
      io(stdout, stderr, async (question) => {
        questions.push(question);
        return "~/Code";
      }),
      fixture.env
    ),
    0
  );
  assert.deepEqual(questions, ["Projects root [~/Projects]: "]);
  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.guppiHome, "config.json"), "utf8")),
    { version: 1, projectsRoot: "~/Code" }
  );
  assert.match(stdout.join(""), /queued-router: 0/);
  assert.equal(stderr.join(""), "");
});

test("first-run whitespace input uses the projectsRoot default", async () => {
  const fixture = await createUnconfiguredFixture();

  assert.equal(
    await main(
      ["status"],
      io([], [], async () => "   "),
      fixture.env
    ),
    0
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.guppiHome, "config.json"), "utf8")),
    { version: 1, projectsRoot: "~/Projects" }
  );
});

test("first run without a prompt fails without writing state", async () => {
  const fixture = await createUnconfiguredFixture();
  const stderr: string[] = [];

  assert.equal(await main(["status"], io([], stderr), fixture.env), 1);
  assert.match(stderr.join(""), /Guppi is not configured/);
  assert.match(stderr.join(""), /"projectsRoot":"~\/Projects"/);
  await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
});

test("cancelled first-run setup writes no config or state", async () => {
  const fixture = await createUnconfiguredFixture();
  const stderr: string[] = [];

  assert.equal(
    await main(
      ["status"],
      io([], stderr, async () => {
        throw new Error("cancelled");
      }),
      fixture.env
    ),
    1
  );
  assert.equal(stderr.join(""), "Guppi setup cancelled\n");
  await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
});

test("terminal prompting requires both TTYs and cancels on EOF", async () => {
  const inputOnly = terminalStreams(true, false);
  const outputOnly = terminalStreams(false, true);
  assert.equal(terminalPrompt(inputOnly.input, inputOnly.output), undefined);
  assert.equal(terminalPrompt(outputOnly.input, outputOnly.output), undefined);

  const terminal = terminalStreams(true, true);
  const prompt = terminalPrompt(terminal.input, terminal.output);
  assert.ok(prompt);
  const pending = prompt("Projects root: ");
  terminal.input.end();
  await assert.rejects(pending, /Guppi setup cancelled/);

  const answered = terminalStreams(true, true);
  const answerPrompt = terminalPrompt(answered.input, answered.output);
  assert.ok(answerPrompt);
  const answer = answerPrompt("Projects root: ");
  answered.input.write("~/Code\n");
  assert.equal(await answer, "~/Code");

  const interrupted = terminalStreams(true, true);
  const interruptPrompt = terminalPrompt(
    interrupted.input,
    interrupted.output
  );
  assert.ok(interruptPrompt);
  const interrupt = interruptPrompt("Projects root: ");
  interrupted.input.write("\u0003");
  await assert.rejects(interrupt, /Guppi setup cancelled/);
});

test("hidden workers never invoke first-run setup", async () => {
  const fixture = await createUnconfiguredFixture();
  let prompted = false;

  await assert.rejects(
    main(
      ["__worker", "missing-job"],
      io([], [], async () => {
        prompted = true;
        return "~/Projects";
      }),
      fixture.env
    ),
    MissingConfigError
  );
  assert.equal(prompted, false);
  await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
});

test("service rejects invalid ports before first-run setup", async () => {
  for (const port of ["-1", "1.5", "65536", "port"]) {
    const fixture = await createUnconfiguredFixture();
    const stderr: string[] = [];
    assert.equal(
      await main(["service", "--port", port], io([], stderr), fixture.env),
      1
    );
    assert.match(
      stderr.join(""),
      /service port must be an integer from 0 to 65535/
    );
    await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
  }
});

test("service first run without a terminal fails before listening", async () => {
  const fixture = await createUnconfiguredFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  assert.equal(
    await main(["service", "--port", "0"], io(stdout, stderr), fixture.env),
    1
  );
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /Guppi is not configured/);
  await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
});

test("service reports bind failure without readiness output", async (context) => {
  const fixture = await createFixture();
  const blocker = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", resolvePromise);
  });
  context.after(
    () =>
      new Promise<void>((resolvePromise, reject) => {
        blocker.close((error) => {
          if (error) reject(error);
          else resolvePromise();
        });
      })
  );
  const address = blocker.address();
  assert.ok(address && typeof address !== "string");
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await main(
      ["service", "--port", String(address.port)],
      io(stdout, stderr),
      fixture.env
    ),
    1
  );
  assert.equal(stdout.join(""), "");
  assert.match(stderr.join(""), /EADDRINUSE/);
});

test("service command owns its port and rejects root intake syntax", async () => {
  const fixture = await createUnconfiguredFixture();
  const serviceMessageError: string[] = [];
  assert.equal(
    await main(
      ["service", "unexpected message"],
      io([], serviceMessageError),
      fixture.env
    ),
    1
  );
  assert.match(serviceMessageError.join(""), /too many arguments for 'service'/);

  const serviceFlagError: string[] = [];
  assert.equal(
    await main(["--service"], io([], serviceFlagError), fixture.env),
    1
  );
  assert.match(serviceFlagError.join(""), /unknown option '--service'/);

  const rootPortError: string[] = [];
  assert.equal(
    await main(
      ["--port", "9000", "message"],
      io([], rootPortError),
      fixture.env
    ),
    1
  );
  assert.match(rootPortError.join(""), /unknown option '--port'/);

  const missingMessageError: string[] = [];
  assert.equal(await main([], io([], missingMessageError), fixture.env), 1);
  assert.match(
    missingMessageError.join(""),
    /missing required argument 'message'/
  );
  await assert.rejects(readdir(fixture.guppiHome), { code: "ENOENT" });
});

test("status reports a missing job without launching an agent", async () => {
  const fixture = await createFixture();
  const stderr: string[] = [];
  const jobId = "2026-01-01T00-00-00.000Z-deadbeef";
  assert.equal(
    await main(["status", jobId], io([], stderr), fixture.env),
    1
  );
  assert.equal(stderr.join(""), `job not found: ${jobId}\n`);
});

test("status rejects job IDs that escape the jobs directory", async () => {
  const fixture = await createFixture();
  const stderr: string[] = [];
  assert.equal(
    await main(["status", "../config"], io([], stderr), fixture.env),
    1
  );
  assert.equal(stderr.join(""), "invalid job ID: ../config\n");
});

test("status prints one job as JSON", async () => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const job = await new Jobs(runtime.paths).register({
    raw: "message",
    mode: "async",
    projectHint: null,
    cwd: "/original/cwd"
  });
  const stdout: string[] = [];

  assert.equal(
    await main(["status", job.id], io(stdout), fixture.env),
    0
  );
  const rendered = JSON.parse(stdout.join("")) as {
    id: string;
    status: string;
  };
  assert.equal(rendered.id, job.id);
  assert.equal(rendered.status, "queued-router");
});

async function createFixture() {
  const fixture = await createUnconfiguredFixture();
  const projectsRoot = join(fixture.home, "Projects");
  await mkdir(join(projectsRoot, "Alpha"), { recursive: true });
  await createConfig(projectsRoot, fixture.env);
  return fixture;
}

async function createUnconfiguredFixture() {
  const root = await mkdtemp(join(tmpdir(), "guppi-cli-"));
  const home = join(root, "home");
  const guppiHome = join(home, ".guppi");
  return {
    home,
    guppiHome,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GUPPI_HOME: guppiHome
    }
  };
}

function io(
  stdout: string[],
  stderr: string[] = [],
  prompt?: (message: string) => Promise<string>
) {
  return {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message),
    ...(prompt ? { prompt } : {})
  };
}

function terminalStreams(inputTty: boolean, outputTty: boolean) {
  const input = Object.assign(new PassThrough(), {
    isTTY: inputTty,
    setRawMode: () => input
  });
  const output = Object.assign(new PassThrough(), {
    isTTY: outputTty,
    columns: 80,
    cursorTo: () => true,
    moveCursor: () => true,
    clearLine: () => true
  });
  return { input, output };
}
