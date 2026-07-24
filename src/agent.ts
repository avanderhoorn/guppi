import { randomBytes, randomUUID } from "crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { join } from "path";
import {
  canonicalPath,
  containsPath,
  rejectSymlink
} from "./config";
import { runTrackedCommand } from "./process";
import type { Queue } from "./queue";

export type AgentProfile = "router" | "project";

export type AgentTurn = {
  workerKey: string;
  sessionId: string;
  session: "create" | "resume";
  persistSession: boolean;
  profile: AgentProfile;
  cwd: string;
  sourceRoot?: string;
  routerSourceRoots?: string[];
  prompt: string;
  interactive: boolean;
};

export type InvokeAgent = (turn: AgentTurn) => Promise<string>;

export type RunAgent = (
  turn: Omit<AgentTurn, "sessionId" | "session">
) => Promise<string>;

type SessionFile = {
  version: 1;
  sessions: Record<string, string>;
};

/** Wraps the provider with persistent, concurrency-safe session behavior. */
export function createAgent(
  sessionsPath: string,
  copilotHome: string,
  skillsRoot: string,
  queue: Queue,
  invoke?: InvokeAgent,
  env: NodeJS.ProcessEnv = process.env
): RunAgent {
  const invokeTurn =
    invoke || createCopilotInvoker(queue, env, copilotHome, skillsRoot);
  return async (turn) => {
    const reservation = turn.persistSession
      ? await queue.exclusive("sessions", async () => {
          const latest = await readSessions(sessionsPath);
          const existing = latest.sessions[turn.workerKey];
          if (existing) return { sessionId: existing, created: false };
          const sessionId = randomUUID();
          latest.sessions[turn.workerKey] = sessionId;
          await writeSessions(sessionsPath, latest);
          return { sessionId, created: true };
        })
      : { sessionId: randomUUID(), created: true };
    return invokeTurn({
      ...turn,
      sessionId: reservation.sessionId,
      session: reservation.created ? "create" : "resume"
    });
  };
}

function createCopilotInvoker(
  queue: Queue,
  env: NodeJS.ProcessEnv,
  copilotHome: string,
  skillsRoot: string
): InvokeAgent {
  return async (turn) => {
    await ensureCopilotHome(copilotHome);
    await ensureCopilotSettings(turn.cwd);
    const skillRoot = join(skillsRoot, turn.profile);
    const command = buildCommand(turn);
    const environment = copilotEnvironment(
      env,
      turn.cwd,
      copilotHome,
      skillRoot
    );
    return runTracked(command, turn, environment, queue);
  };
}

function buildCommand(turn: AgentTurn): string[] {
  const prompt = [
    "<guppi-bootstrap>",
    `Before taking any other action in this turn, invoke the \`${turn.profile}\` skill with the \`skill\` tool. Follow the loaded skill as the governing contract. Do not continue if it cannot be loaded.`,
    "</guppi-bootstrap>",
    "",
    "<guppi-input>",
    turn.prompt,
    "</guppi-input>"
  ].join("\n");
  const common = [
    "--no-auto-update",
    "--no-color",
    "--stream",
    "off",
    "--no-custom-instructions",
    ...(turn.profile === "project" ? ["--yolo"] : []),
    ...(turn.interactive ? [] : ["--no-ask-user"]),
    "--no-remote",
    "--no-remote-export",
    "--disallow-temp-dir",
    "--disable-builtin-mcps",
    "--session-id",
    turn.sessionId
  ];

  const profile =
    turn.profile === "router"
      ? routerProfile(turn.cwd, turn.routerSourceRoots || [])
      : projectProfile(turn.sourceRoot, turn.interactive);
  return [
    "copilot",
    ...common,
    ...profile,
    ...(turn.interactive
      ? ["--interactive", prompt]
      : ["--output-format", "json", "--silent", "-p", prompt])
  ];
}

function routerProfile(cwd: string, sourceRoots: string[]): string[] {
  return [
    ...sourceRoots.flatMap((sourceRoot) => ["--add-dir", sourceRoot]),
    "--available-tools=skill,view,glob,grep,edit",
    "--allow-tool=skill",
    "--allow-tool=view",
    "--allow-tool=glob",
    "--allow-tool=grep",
    `--allow-tool=write(${join(cwd, "agents.md")})`,
    "--deny-tool=shell",
    "--deny-tool=url",
    "--deny-tool=memory",
    "--deny-tool=task"
  ];
}

function projectProfile(sourceRoot: string | undefined, interactive: boolean): string[] {
  // Copilot exposes the model tool as "bash", but permission patterns use "shell".
  const sourceAccess = sourceRoot
    ? ["--add-dir", sourceRoot, "--allow-tool=shell"]
    : ["--deny-tool=shell"];
  return [
    ...sourceAccess,
    `--available-tools=skill,view,glob,grep,edit,create,web_fetch,task${sourceRoot ? ",bash" : ""}${interactive ? ",ask_user" : ""}`,
    "--allow-tool=skill",
    "--allow-tool=view",
    "--allow-tool=glob",
    "--allow-tool=grep",
    "--allow-tool=write",
    "--allow-tool=task",
    "--allow-all-urls",
    "--deny-tool=memory"
  ];
}

async function runTracked(
  command: string[],
  turn: AgentTurn,
  environment: NodeJS.ProcessEnv,
  queue: Queue
): Promise<string> {
  const result = await runTrackedCommand(
    turn.workerKey,
    {
      command: command[0],
      args: command.slice(1),
      cwd: turn.cwd,
      env: environment,
      interactive: turn.interactive
    },
    queue,
    "Copilot"
  );
  if (result.code !== 0) {
    const detail = (
      result.gateError ||
      result.stderr.trim() ||
      result.stdout.trim()
    ).slice(-4096);
    const exit = result.signal
      ? `signal ${result.signal}`
      : `code ${result.code ?? "unknown"}`;
    throw new Error(
      `copilot exited with ${exit}${detail ? `: ${detail}` : ""}`
    );
  }
  return turn.interactive ? "" : assistantOutput(result.stdout);
}

function assistantOutput(output: string): string {
  let content: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("copilot returned malformed JSONL output");
    }
    if (
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "assistant.message" &&
      "data" in event &&
      typeof event.data === "object" &&
      event.data !== null &&
      "content" in event.data &&
      typeof event.data.content === "string"
    ) {
      content = event.data.content;
    }
  }
  if (content === undefined) {
    throw new Error("copilot returned no assistant message");
  }
  return content.trim();
}

async function ensureCopilotSettings(cwd: string): Promise<void> {
  const github = join(cwd, ".github");
  const directory = join(github, "copilot");
  const path = join(directory, "settings.local.json");
  await rejectSymlink(github, "Copilot settings directory");
  await mkdir(github, { recursive: true });
  await rejectSymlink(github, "Copilot settings directory");
  await rejectSymlink(directory, "Copilot settings directory");
  await mkdir(directory, { recursive: true });
  await rejectSymlink(directory, "Copilot settings directory");
  await rejectSymlink(path, "Copilot settings file");

  const [canonicalCwd, canonicalDirectory] = await Promise.all([
    canonicalPath(cwd),
    canonicalPath(directory)
  ]);
  if (!containsPath(canonicalCwd, canonicalDirectory)) {
    throw new Error("Copilot settings escaped the agent working directory");
  }

  await writeJsonAtomic(path, { disableAllHooks: true });
}

async function ensureCopilotHome(home: string): Promise<void> {
  await rejectSymlink(home, "Guppi Copilot directory");
  await mkdir(home, { recursive: true });
  await rejectSymlink(home, "Guppi Copilot directory");
  for (const name of ["mcp-config.json", "extensions", "plugin-data"]) {
    const path = join(home, name);
    try {
      await lstat(path);
      throw new Error(`Guppi Copilot home contains ambient plugins: ${path}`);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  const config = join(home, "config.json");
  await rejectSymlink(config, "Guppi Copilot config");
  await writeJsonAtomic(config, {
    disableAllHooks: true,
    memory: false,
    experimental: false,
    ide: { autoConnect: false },
    customAgents: { defaultLocalOnly: true }
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(value, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function copilotEnvironment(
  source: NodeJS.ProcessEnv,
  cwd: string,
  copilotHome: string,
  skillRoot: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...source
  };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "PWD" ||
      normalized === "COPILOT_ALLOW_ALL" ||
      normalized === "COPILOT_CUSTOM_INSTRUCTIONS_DIRS" ||
      normalized === "COPILOT_HOME" ||
      normalized === "COPILOT_OFFLINE" ||
      normalized === "COPILOT_SKILLS_DIRS" ||
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH" ||
      normalized.startsWith("COPILOT_PROVIDER_") ||
      (normalized.startsWith("COPILOT_") &&
        (normalized.includes("MCP") ||
          normalized.includes("PLUGIN") ||
          normalized.includes("EXTENSION"))) ||
      normalized.startsWith("COPILOT_OTEL_") ||
      normalized.startsWith("OTEL_")
    ) {
      delete environment[key];
    }
  }
  environment.PWD = cwd;
  environment.COPILOT_HOME = copilotHome;
  environment.COPILOT_SKILLS_DIRS = skillRoot;
  return environment;
}

async function readSessions(path: string): Promise<SessionFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SessionFile>;
    if (
      parsed.version === 1 &&
      typeof parsed.sessions === "object" &&
      parsed.sessions !== null
    ) {
      return parsed as SessionFile;
    }
    return { version: 1, sessions: {} };
  } catch (error) {
    if (isNotFound(error)) return { version: 1, sessions: {} };
    throw error;
  }
}

async function writeSessions(path: string, sessions: SessionFile): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(sessions, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" }
    );
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
