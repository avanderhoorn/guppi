import assert from "node:assert/strict";
import { execFile as execFileCallback } from "child_process";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile
} from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import type { AgentTurn, InvokeAgent } from "../../src/agent";
import { createConfig, loadRuntime } from "../../src/config";
import {
  createGitRunner,
  type RunGit,
  type SourceGitSnapshot
} from "../../src/git";
import { Orchestrator } from "../../src/orchestrator";
import { Queue } from "../../src/queue";

const execFile = promisify(execFileCallback);

test("commits the model-provided project subject before marking done", async () => {
  const fixture = await createFixture();
  const subject = "Record the release decision";
  const { job, projectCalls } = await runJob(fixture, "release decision", subject);
  const projectRoot = join(fixture.guppiHome, "Alpha");

  assert.equal(job.status, "done");
  assert.equal(projectCalls, 1);
  assert.deepEqual(await gitLines(projectRoot, [
    "log",
    "--reverse",
    "--format=%s"
  ]), [
    "Initialize Guppi project state",
    subject
  ]);
  assert.equal(
    (await gitText(projectRoot, ["log", "-1", "--format=%B"])).trimEnd(),
    `${subject}\n\nGuppi-Job: ${job.id}`
  );
  assert.equal(
    await gitText(projectRoot, ["show", "HEAD:.guppi-receipts"]),
    `v1\n${job.id}\n`
  );
  assert.doesNotMatch(
    await gitText(projectRoot, ["show", "HEAD:agents.md"]),
    /Processed Jobs/
  );
  assert.equal(await gitText(projectRoot, ["status", "--porcelain"]), "");
  assert.equal(
    (await readdir(projectRoot)).includes(".guppi-commit-message"),
    false
  );
  assert.doesNotMatch(
    await gitText(projectRoot, ["ls-tree", "-r", "--name-only", "HEAD"]),
    /\.guppi-commit-message/
  );
});

test("checkpoints dirty Guppi state before the next project commit", async () => {
  const fixture = await createFixture();
  const first = await runJob(fixture, "first", "Record the first decision");
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await appendFile(projectRoot + "/project.md", "- Manual follow-up\n", "utf8");

  const second = await runJob(fixture, "second", "Record the second decision");
  assert.equal(second.job.status, "done");
  assert.deepEqual(await gitLines(projectRoot, [
    "log",
    "--reverse",
    "--format=%s"
  ]), [
    "Initialize Guppi project state",
    "Record the first decision",
    `Checkpoint Guppi state before ${second.job.id}`,
    "Record the second decision"
  ]);
  assert.equal(await gitText(projectRoot, ["status", "--porcelain"]), "");
  assert.equal(first.projectCalls, 1);
  assert.equal(second.projectCalls, 1);
});

test("supplies dirty exact-root source Git facts without mutating the source", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(sourceRoot, "tracked.txt"), "baseline\n", "utf8");
  await gitText(sourceRoot, ["add", "tracked.txt"]);
  await commitSource(sourceRoot, "Source baseline");
  const head = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
  await gitText(sourceRoot, [
    "update-ref",
    "refs/remotes/origin/main",
    head
  ]);
  await writeFile(join(sourceRoot, "tracked.txt"), "modified\n", "utf8");
  await writeFile(join(sourceRoot, "untracked.txt"), "new\n", "utf8");
  const statusBefore = await gitText(sourceRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all"
  ]);
  const refsBefore = await gitText(sourceRoot, ["show-ref"]);
  const indexBefore = await readFile(join(sourceRoot, ".git", "index"));

  const { job, projectPrompts } = await runJob(
    fixture,
    "inspect dirty source",
    "Record dirty source evidence"
  );
  assert.equal(job.status, "done");
  assert.deepEqual(projectPrompts[0].sourceGit, {
    branch: "main",
    head,
    dirty: true,
    statusPorcelain: [" M tracked.txt", "?? untracked.txt"],
    statusTruncated: false,
    localOriginMain: head,
    aheadOfOriginMain: 0,
    behindOriginMain: 0
  });
  assert.equal(await gitText(sourceRoot, ["rev-parse", "HEAD"]), `${head}\n`);
  assert.equal(
    await gitText(sourceRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all"
    ]),
    statusBefore
  );
  assert.equal(await gitText(sourceRoot, ["show-ref"]), refsBefore);
  assert.deepEqual(await readFile(join(sourceRoot, ".git", "index")), indexBefore);
});

test("reports divergence from the local origin/main ref", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(sourceRoot, "base.txt"), "base\n", "utf8");
  await gitText(sourceRoot, ["add", "base.txt"]);
  await commitSource(sourceRoot, "Base");
  await gitText(sourceRoot, ["checkout", "--quiet", "-b", "feature/source"]);
  await writeFile(join(sourceRoot, "feature.txt"), "feature\n", "utf8");
  await gitText(sourceRoot, ["add", "feature.txt"]);
  await commitSource(sourceRoot, "Feature");
  const featureHead = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
  await gitText(sourceRoot, ["checkout", "--quiet", "main"]);
  await writeFile(join(sourceRoot, "main.txt"), "main\n", "utf8");
  await gitText(sourceRoot, ["add", "main.txt"]);
  await commitSource(sourceRoot, "Main");
  const originMain = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
  await gitText(sourceRoot, [
    "update-ref",
    "refs/remotes/origin/main",
    originMain
  ]);
  await gitText(sourceRoot, ["checkout", "--quiet", "feature/source"]);

  const { projectPrompts } = await runJob(
    fixture,
    "compare source history",
    "Record source divergence"
  );
  assert.deepEqual(projectPrompts[0].sourceGit, {
    branch: "feature/source",
    head: featureHead,
    dirty: false,
    statusPorcelain: [],
    statusTruncated: false,
    localOriginMain: originMain,
    aheadOfOriginMain: 1,
    behindOriginMain: 1
  });
});

test("reports a clean main checkout aligned with local origin/main", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(sourceRoot, "source.txt"), "source\n", "utf8");
  await gitText(sourceRoot, ["add", "source.txt"]);
  await commitSource(sourceRoot, "Source");
  const head = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
  await gitText(sourceRoot, [
    "update-ref",
    "refs/remotes/origin/main",
    head
  ]);

  const { projectPrompts } = await runJob(
    fixture,
    "inspect clean source",
    "Record clean source"
  );
  assert.deepEqual(projectPrompts[0].sourceGit, {
    branch: "main",
    head,
    dirty: false,
    statusPorcelain: [],
    statusTruncated: false,
    localOriginMain: head,
    aheadOfOriginMain: 0,
    behindOriginMain: 0
  });
});

test("reports explicit null source Git fields for expected repository states", async (context) => {
  await context.test("non-Git source", async () => {
    const fixture = await createFixture();
    const { projectPrompts } = await runJob(
      fixture,
      "inspect non-git source",
      "Record non-Git source"
    );
    assert.equal(projectPrompts[0].sourceGit, null);
  });

  await context.test("ancestor repository", async () => {
    const fixture = await createFixture();
    await gitText(fixture.projectsRoot, [
      "init",
      "--quiet",
      "--initial-branch=main"
    ]);
    await writeFile(
      join(fixture.projectsRoot, "Alpha", "source.txt"),
      "source\n",
      "utf8"
    );
    await gitText(fixture.projectsRoot, ["add", "Alpha/source.txt"]);
    await commitSource(fixture.projectsRoot, "Parent repository");
    const { projectPrompts } = await runJob(
      fixture,
      "inspect nested source",
      "Record nested source"
    );
    assert.equal(projectPrompts[0].sourceGit, null);
  });

  await context.test("unborn repository", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
    const { projectPrompts } = await runJob(
      fixture,
      "inspect unborn source",
      "Record unborn source"
    );
    assert.deepEqual(projectPrompts[0].sourceGit, {
      branch: "main",
      head: null,
      dirty: false,
      statusPorcelain: [],
      statusTruncated: false,
      localOriginMain: null,
      aheadOfOriginMain: null,
      behindOriginMain: null
    });
  });

  await context.test("main repository without origin/main", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(sourceRoot, "source.txt"), "source\n", "utf8");
    await gitText(sourceRoot, ["add", "source.txt"]);
    await commitSource(sourceRoot, "Source");
    const head = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
    const { projectPrompts } = await runJob(
      fixture,
      "inspect source without origin",
      "Record source without origin"
    );
    assert.deepEqual(projectPrompts[0].sourceGit, {
      branch: "main",
      head,
      dirty: false,
      statusPorcelain: [],
      statusTruncated: false,
      localOriginMain: null,
      aheadOfOriginMain: null,
      behindOriginMain: null
    });
  });

  await context.test("detached repository without origin/main", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(sourceRoot, "source.txt"), "source\n", "utf8");
    await gitText(sourceRoot, ["add", "source.txt"]);
    await commitSource(sourceRoot, "Source");
    const head = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
    await gitText(sourceRoot, ["checkout", "--quiet", "--detach", head]);
    const { projectPrompts } = await runJob(
      fixture,
      "inspect detached source",
      "Record detached source"
    );
    assert.deepEqual(projectPrompts[0].sourceGit, {
      branch: null,
      head,
      dirty: false,
      statusPorcelain: [],
      statusTruncated: false,
      localOriginMain: null,
      aheadOfOriginMain: null,
      behindOriginMain: null
    });
  });

  await context.test("unrelated local origin/main", async () => {
    const fixture = await createFixture();
    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
    await writeFile(join(sourceRoot, "main.txt"), "main\n", "utf8");
    await gitText(sourceRoot, ["add", "main.txt"]);
    await commitSource(sourceRoot, "Main root");
    const originMain = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();
    await gitText(sourceRoot, [
      "update-ref",
      "refs/remotes/origin/main",
      originMain
    ]);
    await gitText(sourceRoot, ["checkout", "--quiet", "--orphan", "unrelated"]);
    await gitText(sourceRoot, ["rm", "--quiet", "-rf", "."]);
    await writeFile(join(sourceRoot, "other.txt"), "other\n", "utf8");
    await gitText(sourceRoot, ["add", "other.txt"]);
    await commitSource(sourceRoot, "Unrelated root");
    const head = (await gitText(sourceRoot, ["rev-parse", "HEAD"])).trim();

    const { projectPrompts } = await runJob(
      fixture,
      "inspect unrelated history",
      "Record unrelated source"
    );
    assert.deepEqual(projectPrompts[0].sourceGit, {
      branch: "unrelated",
      head,
      dirty: false,
      statusPorcelain: [],
      statusTruncated: false,
      localOriginMain: originMain,
      aheadOfOriginMain: null,
      behindOriginMain: null
    });
  });
});

test("bounds source status while retaining tracked and untracked evidence", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  for (let index = 0; index < 105; index += 1) {
    await writeFile(
      join(sourceRoot, `tracked-${String(index).padStart(3, "0")}.txt`),
      "baseline\n",
      "utf8"
    );
  }
  await gitText(sourceRoot, ["add", "."]);
  await commitSource(sourceRoot, "Source baseline");
  for (let index = 0; index < 105; index += 1) {
    await writeFile(
      join(sourceRoot, `tracked-${String(index).padStart(3, "0")}.txt`),
      "modified\n",
      "utf8"
    );
  }
  await writeFile(join(sourceRoot, "untracked.txt"), "new\n", "utf8");

  const { projectPrompts } = await runJob(
    fixture,
    "inspect large dirty source",
    "Record bounded source status"
  );
  const sourceGit = projectPrompts[0].sourceGit;
  assert.ok(sourceGit);
  assert.equal(sourceGit.dirty, true);
  assert.equal(sourceGit.statusTruncated, true);
  assert.equal(sourceGit.statusPorcelain.length, 100);
  assert.ok(sourceGit.statusPorcelain.some((line) => line.startsWith(" M ")));
  assert.ok(sourceGit.statusPorcelain.includes("?? untracked.txt"));
});

test("bounds source status by encoded byte size", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  for (let index = 0; index < 90; index += 1) {
    await writeFile(
      join(
        sourceRoot,
        `${String(index).padStart(3, "0")}-${"x".repeat(190)}.txt`
      ),
      "new\n",
      "utf8"
    );
  }

  const { projectPrompts } = await runJob(
    fixture,
    "inspect byte-heavy status",
    "Record byte-bounded source status"
  );
  const sourceGit = projectPrompts[0].sourceGit;
  assert.ok(sourceGit);
  assert.equal(sourceGit.dirty, true);
  assert.equal(sourceGit.statusTruncated, true);
  assert.ok(sourceGit.statusPorcelain.length < 90);
  assert.ok(sourceGit.statusPorcelain.length > 0);
});

test("surfaces unexpected source Git failures before invoking the model", async () => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const realRunGit = createGitRunner(
    new Queue(runtime.paths.locks),
    runtime.paths.copilot,
    fixture.env
  );
  const runGit: RunGit = (request) =>
    request.operation === "inspect source worktree root"
      ? Promise.resolve({
          code: 128,
          signal: null,
          stdout: "",
          stderr: "fatal: detected dubious ownership",
          gateError: null
        })
      : realRunGit(request);

  const { job, projectCalls } = await runJob(
    fixture,
    "inspect unsafe source",
    "Unexpected completion",
    runGit
  );
  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 0);
  assert.match(job.error || "", /detected dubious ownership/);
});

test("surfaces source status failures before invoking the model", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  const runtime = await loadRuntime(fixture.env);
  const realRunGit = createGitRunner(
    new Queue(runtime.paths.locks),
    runtime.paths.copilot,
    fixture.env
  );
  const runGit: RunGit = (request) =>
    request.operation === "inspect tracked source status"
      ? Promise.resolve({
          code: 128,
          signal: null,
          stdout: "",
          stderr: "fatal: simulated source status failure",
          gateError: null
        })
      : realRunGit(request);

  const { job, projectCalls } = await runJob(
    fixture,
    "inspect failed source status",
    "Unexpected completion",
    runGit
  );
  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 0);
  assert.match(job.error || "", /simulated source status failure/);
});

test("accepts a paired legacy HEAD without replaying the model", async () => {
  const fixture = await createFixture();
  let projectCalls = 0;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Alpha",
        sourceRoot: join(fixture.projectsRoot, "Alpha"),
        reason: "The model chose Alpha.",
        question: null
      });
    }
    projectCalls += 1;
    await completeProject(turn, "Unexpected replay");
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register({
    raw: "legacy completion",
    mode: "standard",
    projectHint: null,
    cwd: "/original/cwd"
  });
  await orchestrator.route(registered.id);
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(join(projectRoot, "research"), { recursive: true });
  await mkdir(join(projectRoot, "plans"), { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\n\n## Processed Jobs\n\n- ${registered.id}\n`,
    "utf8"
  );
  await writeFile(join(projectRoot, "project.md"), "# Alpha\n\n", "utf8");
  await writeFile(join(projectRoot, "archive.md"), "# Archive\n\n", "utf8");
  await gitText(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
  await gitText(projectRoot, ["add", "--all"]);
  await gitText(projectRoot, [
    "-c",
    "user.name=Legacy",
    "-c",
    "user.email=legacy@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Legacy completion",
    "-m",
    `Guppi-Job: ${registered.id}`
  ]);
  const legacyHead = await gitText(projectRoot, ["rev-parse", "HEAD"]);

  assert.equal((await orchestrator.drive(registered.id)).status, "done");
  assert.equal(projectCalls, 0);
  assert.equal(await gitText(projectRoot, ["rev-parse", "HEAD"]), legacyHead);
  assert.equal(
    await readFile(join(projectRoot, ".guppi-receipts"), "utf8"),
    `v1\n${registered.id}\n`
  );
  assert.doesNotMatch(
    await readFile(join(projectRoot, "agents.md"), "utf8"),
    /Processed Jobs/
  );
  assert.notEqual(await gitText(projectRoot, ["status", "--porcelain"]), "");
});

test("continues an interrupted legacy migration without changing unrelated bytes", async () => {
  const fixture = await createFixture();
  let projectCalls = 0;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Alpha",
        sourceRoot: join(fixture.projectsRoot, "Alpha"),
        reason: "The model chose Alpha.",
        question: null
      });
    }
    projectCalls += 1;
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register({
    raw: "resume migration",
    mode: "standard",
    projectHint: null,
    cwd: "/original/cwd"
  });
  await orchestrator.route(registered.id);
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\r\n\r\nKeep this exactly.\r\n\r\n## Processed Jobs\r\n\r\n- ${registered.id}\r\n\r\n## Durable Guidance\r\n\r\nKeep this too.\r\n`,
    "utf8"
  );
  await writeFile(
    join(projectRoot, ".guppi-receipts"),
    `v1\n${registered.id}\n`,
    "utf8"
  );

  assert.equal((await orchestrator.drive(registered.id)).status, "done");
  assert.equal(projectCalls, 0);
  assert.equal(
    await readFile(join(projectRoot, "agents.md"), "utf8"),
    "# Alpha Agent Guidance\r\n\r\nKeep this exactly.\r\n\r\n## Durable Guidance\r\n\r\nKeep this too.\r\n"
  );
  assert.equal(
    await readFile(join(projectRoot, ".guppi-receipts"), "utf8"),
    `v1\n${registered.id}\n`
  );
  assert.equal(await gitText(projectRoot, ["status", "--porcelain"]), "");
});

test("removes stale regular migration files before project validation", async () => {
  const fixture = await createFixture();
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, ".guppi-receipts.tmp-dead"),
    "stale\n",
    "utf8"
  );
  await writeFile(
    join(projectRoot, ".guppi-agents-migration.tmp-dead"),
    "stale\n",
    "utf8"
  );

  const { job } = await runJob(fixture, "clean stale files", "Record clean state");
  assert.equal(job.status, "done");
  assert.equal(
    (await readdir(projectRoot)).some((name) => name.includes(".tmp-dead")),
    false
  );
});

test("rejects unsafe stale migration paths", async (context) => {
  for (const shape of ["symlink", "hard-link", "directory"] as const) {
    await context.test(shape, async () => {
      const fixture = await createFixture();
      const projectRoot = join(fixture.guppiHome, "Alpha");
      const stale = join(projectRoot, `.guppi-receipts.tmp-${shape}`);
      const target = join(fixture.root, `${shape}.txt`);
      await mkdir(projectRoot, { recursive: true });
      if (shape === "directory") {
        await mkdir(stale);
      } else {
        await writeFile(target, "stale\n", "utf8");
        if (shape === "symlink") await symlink(target, stale);
        else await link(target, stale);
      }

      const { job, projectCalls } = await runJob(
        fixture,
        `reject ${shape}`,
        "Unexpected completion"
      );
      assert.equal(job.status, "failed");
      assert.equal(projectCalls, 0);
      assert.match(job.error || "", /unsafe stale project migration path/);
    });
  }
});

test("rejects a missing model commit subject without publishing state", async () => {
  const fixture = await createFixture();
  const { job, projectCalls } = await runJob(
    fixture,
    "invalid commit output",
    null
  );
  const projectRoot = join(fixture.guppiHome, "Alpha");

  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 3);
  assert.match(job.error || "", /\.guppi-commit-message/);
  assert.deepEqual(await gitLines(projectRoot, [
    "log",
    "--format=%s"
  ]), ["Initialize Guppi project state"]);
  assert.doesNotMatch(
    await readFile(join(projectRoot, "project.md"), "utf8"),
    /invalid commit output/
  );
});

test("rejects a multiline model commit subject without publishing state", async () => {
  const fixture = await createFixture();
  const { job, projectCalls } = await runJob(
    fixture,
    "multiline commit output",
    "Record project work\nwith an invalid body"
  );
  const projectRoot = join(fixture.guppiHome, "Alpha");

  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 3);
  assert.match(job.error || "", /one trimmed line/);
  assert.deepEqual(await gitLines(projectRoot, [
    "log",
    "--format=%s"
  ]), ["Initialize Guppi project state"]);
  assert.doesNotMatch(
    await readFile(join(projectRoot, "project.md"), "utf8"),
    /multiline commit output/
  );
});

test("recovers a transient final commit failure without replaying the model", async () => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const realRunGit = createGitRunner(
    new Queue(runtime.paths.locks),
    runtime.paths.copilot,
    fixture.env
  );
  let failed = false;
  const runGit: RunGit = async (request) => {
    if (
      !failed &&
      request.operation === "commit project state" &&
      request.args.some((argument) => argument.startsWith("Guppi-Job: "))
    ) {
      failed = true;
      return {
        code: 1,
        signal: null,
        stdout: "",
        stderr: "simulated final commit failure",
        gateError: null
      };
    }
    return realRunGit(request);
  };

  const { job, projectCalls } = await runJob(
    fixture,
    "recover commit",
    "Record recoverable work",
    runGit
  );
  const projectRoot = join(fixture.guppiHome, "Alpha");
  assert.equal(job.status, "done");
  assert.equal(projectCalls, 1);
  assert.equal(
    await gitText(projectRoot, ["log", "-1", "--format=%s"]),
    `Recover completed Guppi job ${job.id}\n`
  );
  assert.equal(
    (await gitText(projectRoot, ["log", "-1", "--format=%B"])).trimEnd(),
    `Recover completed Guppi job ${job.id}\n\nGuppi-Job: ${job.id}`
  );
});

test("persistent final commit failure never marks the job done", async () => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const realRunGit = createGitRunner(
    new Queue(runtime.paths.locks),
    runtime.paths.copilot,
    fixture.env
  );
  const runGit: RunGit = (request) =>
    request.operation === "commit project state" &&
    request.args.some((argument) => argument.startsWith("Guppi-Job: "))
      ? Promise.resolve({
          code: 1,
          signal: null,
          stdout: "",
          stderr: "persistent final commit failure",
          gateError: null
        })
      : realRunGit(request);

  const { job, projectCalls } = await runJob(
    fixture,
    "persistent commit failure",
    "Record work that cannot commit",
    runGit
  );
  const projectRoot = join(fixture.guppiHome, "Alpha");
  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 1);
  assert.match(job.error || "", /persistent final commit failure/);
  assert.deepEqual(await gitLines(projectRoot, [
    "log",
    "--format=%s"
  ]), ["Initialize Guppi project state"]);
  assert.notEqual(await gitText(projectRoot, ["status", "--porcelain"]), "");
});

test("hostile ambient Git variables cannot redirect project commits", async () => {
  const fixture = await createFixture();
  const sourceRoot = join(fixture.projectsRoot, "Alpha");
  await gitText(sourceRoot, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(sourceRoot, "source.txt"), "source\n", "utf8");
  await gitText(sourceRoot, ["add", "source.txt"]);
  await gitText(sourceRoot, [
    "-c",
    "user.name=Source",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Source baseline"
  ]);
  const sourceHead = await gitText(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceConfig = await readFile(join(sourceRoot, ".git", "config"), "utf8");
  const env = {
    ...fixture.env,
    GIT_DIR: join(sourceRoot, ".git"),
    GIT_WORK_TREE: sourceRoot,
    GIT_INDEX_FILE: join(sourceRoot, ".git", "index"),
    GIT_OBJECT_DIRECTORY: join(sourceRoot, ".git", "objects"),
    GIT_AUTHOR_NAME: "Ambient Author",
    GIT_COMMITTER_NAME: "Ambient Committer"
  };

  const result = await runJob(
    { ...fixture, env },
    "isolated git",
    "Record isolated state"
  );
  assert.equal(result.job.status, "done");
  assert.equal(await gitText(sourceRoot, ["rev-parse", "HEAD"]), sourceHead);
  assert.equal(await gitText(sourceRoot, ["status", "--porcelain"]), "");
  assert.equal(
    await readFile(join(sourceRoot, ".git", "config"), "utf8"),
    sourceConfig
  );
  assert.equal(
    await realpath(join(fixture.guppiHome, "Alpha", ".git")),
    join(await realpath(join(fixture.guppiHome, "Alpha")), ".git")
  );
});

test("rejects unmanaged attributes before initializing project history", async () => {
  const fixture = await createFixture();
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, ".gitattributes"),
    "*.md filter=unsafe\n",
    "utf8"
  );

  const { job, projectCalls } = await runJob(
    fixture,
    "unsafe attributes",
    "Record unsafe work"
  );
  assert.equal(job.status, "failed");
  assert.equal(projectCalls, 0);
  assert.match(job.error || "", /unmanaged path: \.gitattributes/);
  assert.equal((await readdir(projectRoot)).includes(".git"), false);
});

test("mutating Git commands require ownership of the project worker", async () => {
  const fixture = await createFixture();
  const runtime = await loadRuntime(fixture.env);
  const runGit = createGitRunner(
    new Queue(runtime.paths.locks),
    runtime.paths.copilot,
    fixture.env
  );
  const root = join(fixture.guppiHome, "unowned");
  await mkdir(root);

  await assert.rejects(
    runGit({
      workerKey: "project:unowned",
      root,
      args: ["init", "--quiet", "--initial-branch=main"],
      mutating: true,
      operation: "init"
    }),
    /cannot track child without owning project:unowned/
  );
});

type Fixture = {
  root: string;
  projectsRoot: string;
  guppiHome: string;
  env: NodeJS.ProcessEnv;
};

type ProjectPromptPayload = {
  sourceGit: SourceGitSnapshot | null;
};

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "guppi-project-git-"));
  const home = join(root, "home");
  const projectsRoot = join(home, "Projects");
  const guppiHome = join(home, ".guppi");
  await mkdir(join(projectsRoot, "Alpha"), { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GUPPI_HOME: guppiHome
  };
  await createConfig(projectsRoot, env);
  await writeFile(
    join(guppiHome, "agents.md"),
    "# Router Working Memory\n\n## Source Project Summaries\n\n- Source project: Alpha\n  - observedAt: 2026-01-01T00:00:00.000Z\n  - Summary: Test fixture source project.\n",
    "utf8"
  );
  return {
    root,
    projectsRoot: await realpath(projectsRoot),
    guppiHome,
    env
  };
}

async function runJob(
  fixture: Fixture,
  raw: string,
  subject: string | null,
  runGit?: RunGit
): Promise<{
  job: Awaited<ReturnType<Orchestrator["drive"]>>;
  projectCalls: number;
  projectPrompts: ProjectPromptPayload[];
}> {
  let projectCalls = 0;
  const projectPrompts: ProjectPromptPayload[] = [];
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Alpha",
        sourceRoot: join(fixture.projectsRoot, "Alpha"),
        reason: "The model chose Alpha.",
        question: null
      });
    }
    projectCalls += 1;
    projectPrompts.push(JSON.parse(turn.prompt) as ProjectPromptPayload);
    await completeProject(turn, subject);
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke, runGit);
  const registered = await orchestrator.register({
    raw,
    mode: "standard",
    projectHint: null,
    cwd: "/original/cwd"
  });
  return {
    job: await orchestrator.drive(registered.id),
    projectCalls,
    projectPrompts
  };
}

async function completeProject(
  turn: AgentTurn,
  subject: string | null
): Promise<void> {
  const prompt = JSON.parse(turn.prompt) as { jobId: string; rawInput: string };
  await appendFile(
    join(turn.cwd, "project.md"),
    `- ${prompt.rawInput}\n`,
    "utf8"
  );
  if (subject !== null) {
    await writeFile(
      join(turn.cwd, ".guppi-commit-message"),
      `${subject}\n`,
      "utf8"
    );
  }
}

async function gitText(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", root, ...args], {
    env: cleanGitEnvironment()
  });
  return stdout;
}

async function gitLines(root: string, args: string[]): Promise<string[]> {
  return (await gitText(root, args)).trim().split("\n").filter(Boolean);
}

async function commitSource(root: string, subject: string): Promise<void> {
  await gitText(root, [
    "-c",
    "user.name=Source",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "--quiet",
    "-m",
    subject
  ]);
}

function cleanGitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  }
  return env;
}
