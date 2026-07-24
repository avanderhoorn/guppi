import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile
} from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { createAgent } from "../../src/agent";
import { main } from "../../src/cli";
import { createConfig } from "../../src/config";
import { Queue, type ProcessIdentity } from "../../src/queue";

test("the production adapter isolates router and project turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-agent-"));
  const home = join(root, "home");
  const projectsRoot = join(home, "Projects");
  const configHome = join(home, ".guppi");
  const guppiHome = join(home, "guppi-state");
  const bin = join(root, "bin");
  const log = join(root, "copilot.ndjson");
  await mkdir(join(projectsRoot, "Alpha"), { recursive: true });
  await mkdir(join(projectsRoot, "Beta"), { recursive: true });
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
  await writeFile(
    join(projectsRoot, "Alpha", "source.txt"),
    "Source evidence\n",
    "utf8"
  );
  const executable = join(bin, "copilot");
  await writeFile(executable, FAKE_COPILOT, "utf8");
  await chmod(executable, 0o755);

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GUPPI_HOME: configHome,
    GUPPI_FAKE_LOG: log,
    COPILOT_HOME: join(root, "ambient-copilot"),
    PATH: `${bin}:${process.env.PATH || ""}`,
    COPILOT_ALLOW_ALL: "true",
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "/unsafe/instructions",
    COPILOT_SKILLS_DIRS: "/unsafe/skills",
    COPILOT_OFFLINE: "true",
    COPILOT_PROVIDER_BASE_URL: "https://unsafe.example",
    COPILOT_OTEL_ENABLED: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://unsafe.example/otel",
    NODE_OPTIONS: "--trace-warnings",
    NODE_PATH: "/unsafe/modules",
    Copilot_Allow_All: "true",
    Copilot_Home: "/unsafe/copilot-home",
    Copilot_Mcp_Config: "/unsafe/mcp.json",
    Copilot_Provider_Base_Url: "https://unsafe.example/mixed",
    Node_Options: "--require=/unsafe/module"
  };
  const stdout: string[] = [];
  const stderr: string[] = [];

  assert.equal(
    await main(["Capture source-backed work"], io(stdout, stderr), env),
    0
  );
  assert.match(stdout.join(""), / -> Alpha\n$/);
  assert.equal(stderr.join(""), "");
  await waitForJob(guppiHome, "done");

  const calls = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as FakeCall);
  assert.equal(calls.length, 2);
  const [router, project] = calls;
  const realCopilotHome = await realpath(join(guppiHome, "_copilot"));
  const realSourceRoot = await realpath(join(projectsRoot, "Alpha"));
  const realBetaRoot = await realpath(join(projectsRoot, "Beta"));
  const realStateRoot = await realpath(join(guppiHome, "Alpha"));
  const routerSkillRoot = await realpath(
    join(guppiHome, ".agents", "skills", "router")
  );
  const projectSkillRoot = await realpath(
    join(guppiHome, ".agents", "skills", "project")
  );
  const routerContract = await readFile(
    join(routerSkillRoot, "SKILL.md"),
    "utf8"
  );
  const projectSkill = await readFile(
    join(projectSkillRoot, "SKILL.md"),
    "utf8"
  );
  const projectTemplates = await Promise.all(
    [
      join(projectSkillRoot, "templates", "agents-template.md"),
      join(projectSkillRoot, "templates", "project.md"),
      join(projectSkillRoot, "templates", "archive.md"),
      join(projectSkillRoot, "templates", "research.md"),
      join(projectSkillRoot, "templates", "plan.md")
    ].map((path) => readFile(path, "utf8"))
  );
  const shippedProjectSkillAndTemplates = [projectSkill, ...projectTemplates].join("\n");

  assert.equal(dirname(router.cwd), realCopilotHome);
  assert.match(router.cwd, /\/router-[^/]+$/);
  assert.deepEqual(
    router.args.reduce<string[]>((roots, argument, index) => {
      if (argument === "--add-dir") roots.push(router.args[index + 1]);
      return roots;
    }, []),
    [realSourceRoot, realBetaRoot]
  );
  assert.ok(
    router.args.includes("--available-tools=skill,view,glob,grep,edit")
  );
  assert.ok(router.args.includes("--allow-tool=skill"));
  assert.ok(router.args.includes("--allow-tool=view"));
  assert.ok(router.args.includes("--allow-tool=glob"));
  assert.ok(router.args.includes("--allow-tool=grep"));
  assert.ok(router.args.includes("--deny-tool=shell"));
  assert.ok(router.args.includes("--deny-tool=url"));
  assert.ok(router.args.includes("--deny-tool=memory"));
  assert.ok(router.args.includes("--deny-tool=task"));
  assert.deepEqual(
    router.args.slice(
      router.args.indexOf("--output-format"),
      router.args.indexOf("--output-format") + 2
    ),
    ["--output-format", "json"]
  );
  assert.match(
    router.args.find((argument) => argument.startsWith("--allow-tool=write(")) ||
      "",
    /\/_copilot\/router-[^/]+\/agents\.md\)$/
  );
  assert.equal(router.env.skills, routerSkillRoot);
  assert.match(
    router.prompt,
    /Before taking any other action.*`router` skill.*`skill` tool/
  );
  assert.doesNotMatch(router.prompt, /<guppi-contract>|<guppi-template>/);
  assert.equal(router.prompt.includes(routerContract.trim()), false);
  assert.equal(router.args.includes("--yolo"), false);
  assert.ok(router.args.includes("--no-ask-user"));
  assert.equal(router.payload.projectsRoot, await realpath(projectsRoot));
  assert.equal(router.payload.guppiRoot, await realpath(guppiHome));
  assert.equal(router.payload.routerMemoryPath, "agents.md");
  assert.equal(router.payload.priorAttemptError, null);
  assert.deepEqual(router.payload.sourceProjects, [
    { project: "Alpha", sourceRoot: realSourceRoot },
    { project: "Beta", sourceRoot: realBetaRoot }
  ]);
  assert.deepEqual(router.payload.guppiProjects, []);
  assert.equal("catalog" in router.payload, false);
  assert.match(routerContract, /must\s+gain one valid entry during the turn/);
  assert.match(
    routerContract,
    /Do not inspect or edit `<guppiRoot>\/agents\.md`/
  );
  assert.match(
    routerContract,
    /only the staged file in the current working\s+directory will be published/
  );
  assert.match(
    routerContract,
    /When `priorAttemptError` is non-null, do not merely repeat/
  );

  assert.equal(dirname(project.cwd), realCopilotHome);
  assert.match(project.cwd, /\/project-[^/]+$/);
  assert.notEqual(project.cwd, realStateRoot);
  assert.deepEqual(
    project.args.slice(
      project.args.indexOf("--add-dir"),
      project.args.indexOf("--add-dir") + 2
    ),
    ["--add-dir", realSourceRoot]
  );
  assert.ok(
    project.args.includes(
      "--available-tools=skill,view,glob,grep,edit,create,web_fetch,task,bash"
    )
  );
  assert.ok(project.args.includes("--allow-tool=skill"));
  assert.ok(project.args.includes("--allow-tool=write"));
  assert.ok(project.args.includes("--allow-tool=shell"));
  assert.ok(project.args.includes("--yolo"));
  assert.ok(project.args.includes("--no-ask-user"));
  assert.equal(project.payload.sourceRoot, realSourceRoot);
  assert.equal(project.payload.sourceGit, null);
  assert.ok(
    project.cwd === project.payload.guppiProjectRoot ||
      project.cwd.endsWith(project.payload.guppiProjectRoot || "\0")
  );
  assert.equal(project.payload.projectDescription, null);
  assert.equal("projectMemory" in project.payload, false);
  assert.equal(project.payload.isInteractive, false);
  assert.equal(project.env.skills, projectSkillRoot);
  assert.match(
    project.prompt,
    /Before taking any other action.*`project` skill.*`skill` tool/
  );
  assert.doesNotMatch(project.prompt, /<guppi-contract>|<guppi-template>/);
  assert.equal(project.prompt.includes(projectSkill.trim()), false);
  assert.equal(project.prompt.includes(projectTemplates[0].trim()), false);
  assert.equal("phase" in project.payload, false);
  assert.equal("sourceFindings" in project.payload, false);
  assert.equal("state" in project.payload, false);
  assert.match(
    shippedProjectSkillAndTemplates,
    /Optional shape templates are available relative to this skill's base directory/
  );
  for (const heading of [
    "Project Context",
    "Tasks",
    "Workstreams",
    "Ideas",
    "Decisions",
    "Open Questions",
    "Artifacts"
  ]) {
    assert.match(shippedProjectSkillAndTemplates, new RegExp(`## ${heading}`));
  }
  for (const retiredHeading of [
    "Current Summary",
    "Next Actions",
    "Active Work",
    "Blocked Or Waiting",
    "Important, Not Actionable Yet",
    "Research And Plans"
  ]) {
    assert.doesNotMatch(
      shippedProjectSkillAndTemplates,
      new RegExp(`\\n## ${retiredHeading}\\n`)
    );
  }
  assert.match(
    shippedProjectSkillAndTemplates,
    /omit sections with no durable content/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /current `rawInput` and the files directly beneath\s+`guppiProjectRoot`.*are authoritative/s
  );
  assert.match(shippedProjectSkillAndTemplates, /Prior session turns are continuity only/);
  assert.match(
    shippedProjectSkillAndTemplates,
    /failed turn whose disposable workspace was discarded/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Classify both the input's scope and kind/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Do not infer Project Context\s+from the current input alone/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Tasks:.*one canonical globally ranked action surface/s
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /A source-owned plan may own its intended sequence without owning a new Guppi\s+assessment/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Access to `sourceRoot` should be treated carefully/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /current `rawInput` to clearly authorize that specific action/
  );
  assert.match(shippedProjectSkillAndTemplates, /Authorization is\s+action-specific/);
  assert.match(
    shippedProjectSkillAndTemplates,
    /cannot independently\s+authorize it\. Apply the same\s+boundary to subagents/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /non-mutating shell\s+commands needed to inspect exact named refs/
  );
  assert.match(shippedProjectSkillAndTemplates, /Do not fetch or contact\s+a remote/);
  assert.match(
    shippedProjectSkillAndTemplates,
    /running project code, builds, tests, or package\s+scripts/
  );
  assert.match(shippedProjectSkillAndTemplates, /\.guppi-commit-message/);
  assert.match(shippedProjectSkillAndTemplates, /one trimmed,\s+non-empty line of at most 100 characters/);
  assert.match(
    shippedProjectSkillAndTemplates,
    /may appear in durable project\s+state when provenance matters/
  );
  assert.match(shippedProjectSkillAndTemplates, /host records and commits the completion receipt/);
  assert.match(shippedProjectSkillAndTemplates, /localOriginMain.*locally stored ref/s);
  assert.match(
    shippedProjectSkillAndTemplates,
    /Use the descendant when ancestry establishes which is newer/
  );
  assert.match(shippedProjectSkillAndTemplates, /modified and untracked paths.*in-progress/s);
  assert.match(
    shippedProjectSkillAndTemplates,
    /Keep estimates or conclusions provisional/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Distinguish observed facts, inferences, and hypotheses/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Reconcile\s+an enumerated breakdown against any known aggregate total/
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /exact source URL or command.*observation date/s
  );
  assert.match(
    shippedProjectSkillAndTemplates,
    /Before writing the commit subject, re-read the changed durable state/
  );
  assert.match(shippedProjectSkillAndTemplates, /- Source snapshot: <checkout or named ref/);
  assert.doesNotMatch(shippedProjectSkillAndTemplates, /## Processed Jobs/);

  assert.notEqual(sessionId(router.args), sessionId(project.args));
  for (const call of calls) {
    assert.deepEqual(call.settings, { disableAllHooks: true });
    assert.equal(call.env.allowAll, null);
    assert.equal(call.env.instructions, null);
    assert.equal(call.env.offline, null);
    assert.equal(call.env.provider, null);
    assert.equal(call.env.otel, null);
    assert.equal(call.env.nodeOptions, null);
    assert.equal(call.env.nodePath, null);
    assert.equal(call.env.copilotHome, realCopilotHome);
    assert.deepEqual(call.env.mixedCapabilityKeys, []);
  }

  const sessions = JSON.parse(
    await readFile(join(guppiHome, "sessions.json"), "utf8")
  ) as { sessions: Record<string, string> };
  assert.deepEqual(
    Object.keys(sessions.sessions).sort(),
    ["project:alpha", "router"]
  );
  assert.match(
    await readFile(join(guppiHome, "Alpha", "project.md"), "utf8"),
    /Incorporated/
  );
  assert.match(
    await readFile(join(guppiHome, "agents.md"), "utf8"),
    /- Source project: Alpha/
  );
  assert.deepEqual(await readdir(configHome), ["config.json"]);
});

test("the production adapter reports Copilot signal exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-agent-signal-"));
  const home = join(root, "home");
  const guppiHome = join(home, ".guppi");
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "copilot");
  await writeFile(executable, FAKE_COPILOT, "utf8");
  await chmod(executable, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GUPPI_HOME: guppiHome,
    GUPPI_FAKE_SIGNAL: "SIGTERM",
    PATH: `${bin}:${process.env.PATH || ""}`
  };
  await createConfig("~/Projects", env);
  const stderr: string[] = [];

  assert.equal(
    await main(
      ["Capture interrupted work"],
      io([], stderr),
      env
    ),
    1
  );
  assert.match(stderr.join(""), /copilot exited with signal SIGTERM/);
});

test("the launch gate exits when child tracking fails", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-agent-track-"));
  const queue = new RejectTrackingQueue(join(root, "locks"));
  const runAgent = createAgent(
    join(root, "sessions.json"),
    join(root, "_copilot"),
    join(root, ".agents", "skills"),
    queue,
    undefined,
    process.env
  );

  await assert.rejects(
    runAgent({
      workerKey: "router",
      persistSession: false,
      profile: "router",
      cwd: root,
      prompt: "{}",
      interactive: false
    }),
    /tracking failed/
  );
});

class RejectTrackingQueue extends Queue {
  override async trackChild(
    _workerKey: string,
    _child: ProcessIdentity | null
  ): Promise<void> {
    throw new Error("tracking failed");
  }
}

async function waitForJob(
  guppiHome: string,
  status: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await readdir(join(guppiHome, "_jobs"));
    const [file] = files.filter((candidate) => candidate.endsWith(".json"));
    if (file) {
      const job = JSON.parse(
        await readFile(join(guppiHome, "_jobs", file), "utf8")
      ) as { status: string };
      if (job.status === status) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`job did not reach ${status}`);
}

type FakeCall = {
  args: string[];
  cwd: string;
  prompt: string;
  settings: {
    disableAllHooks: boolean;
  };
  env: {
    skills: string | null;
    allowAll: string | null;
    instructions: string | null;
    offline: string | null;
    provider: string | null;
    otel: string | null;
    nodeOptions: string | null;
    nodePath: string | null;
    copilotHome: string | null;
    mixedCapabilityKeys: string[];
  };
  payload: {
    projectsRoot?: string;
    guppiRoot?: string;
    routerMemoryPath?: string;
    priorAttemptError?: string | null;
    sourceProjects?: Array<{ project: string; sourceRoot: string }>;
    guppiProjects?: string[];
    sourceRoot?: string | null;
    sourceGit?: {
      branch: string | null;
      head: string | null;
    } | null;
    guppiProjectRoot?: string;
    projectDescription?: string | null;
    isInteractive?: boolean;
  };
};

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

const FAKE_COPILOT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const promptFlag = args.includes("-p") ? "-p" : "--interactive";
const prompt = args[args.indexOf(promptFlag) + 1];
const inputStart = prompt.indexOf("<guppi-input>\\n") + "<guppi-input>\\n".length;
const inputEnd = prompt.indexOf("\\n</guppi-input>", inputStart);
const payload = JSON.parse(prompt.slice(inputStart, inputEnd));
const call = {
  args,
  cwd: process.cwd(),
  prompt,
  settings: JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github", "copilot", "settings.local.json"),
      "utf8"
    )
  ),
  env: {
    skills: process.env.COPILOT_SKILLS_DIRS || null,
    allowAll: process.env.COPILOT_ALLOW_ALL || null,
    instructions: process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS || null,
    offline: process.env.COPILOT_OFFLINE || null,
    provider: process.env.COPILOT_PROVIDER_BASE_URL || null,
    otel: process.env.COPILOT_OTEL_ENABLED || null,
    nodeOptions: process.env.NODE_OPTIONS || null,
    nodePath: process.env.NODE_PATH || null,
    copilotHome: process.env.COPILOT_HOME || null,
    mixedCapabilityKeys: Object.keys(process.env).filter((key) => {
      const normalized = key.toUpperCase();
      return key !== normalized && (
        normalized === "COPILOT_ALLOW_ALL" ||
        normalized === "COPILOT_HOME" ||
        normalized === "NODE_OPTIONS" ||
        normalized.startsWith("COPILOT_PROVIDER_") ||
        normalized.includes("MCP") ||
        normalized.includes("PLUGIN") ||
        normalized.includes("EXTENSION")
      );
    })
  },
  payload
};
if (process.env.GUPPI_FAKE_LOG) {
  fs.appendFileSync(process.env.GUPPI_FAKE_LOG, JSON.stringify(call) + "\\n");
}

let output = "";
const isRouter = args.includes("--available-tools=skill,view,glob,grep,edit");

if (process.env.GUPPI_FAKE_SIGNAL) {
  process.kill(process.pid, process.env.GUPPI_FAKE_SIGNAL);
}

if (isRouter) {
  const source = payload.sourceProjects[0];
  fs.appendFileSync(
    path.join(process.cwd(), "agents.md"),
    "## Source Project Summaries\\n\\n" +
      "- Source project: " + source.project + "\\n" +
      "  - observedAt: 2026-01-01T00:00:00.000Z\\n" +
      "  - Summary: Test fixture source project.\\n"
  );
  output = JSON.stringify({
    project: "Alpha",
    sourceRoot: source.sourceRoot,
    reason: "The model chose Alpha.",
    question: null
  });
} else {
  fs.appendFileSync(
    path.join(process.cwd(), "project.md"),
    "- Incorporated " + payload.jobId + "\\n"
  );
  fs.writeFileSync(
    path.join(process.cwd(), ".guppi-commit-message"),
    "Incorporate project job\\n"
  );
}
if (args.includes("--output-format")) {
  process.stdout.write(JSON.stringify({
    type: "assistant.message",
    data: { content: output }
  }) + "\\n");
} else {
  process.stdout.write(output);
}
`;
