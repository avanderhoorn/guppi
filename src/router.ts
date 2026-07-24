import { randomBytes } from "crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { join } from "path";
import type { RunAgent } from "./agent";
import { rejectSymlink } from "./config";
import type { Job, Route } from "./jobs";
import { visibleMarkdownLines } from "./util";
import {
  authorizeSourceRoot,
  canonicalProjectId,
  isSafeProjectName,
  type RouterCatalog
} from "./project";

type RouterPrompt = {
  jobId: string;
  rawInput: string;
  projectHint: string | null;
  originalCwd: string;
  priorAttemptError: string | null;
  routerMemory: string;
  routerMemoryPath: "agents.md";
  projectsRoot: string;
  guppiRoot: string;
  sourceProjects: RouterCatalog["sourceProjects"];
  guppiProjects: string[];
};

/** Builds router turns and validates that their output stays within host authority. */
export class Router {
  readonly workerKey = "router";

  constructor(
    private readonly runAgent: RunAgent,
    private readonly memoryPath: string,
    private readonly copilotRoot: string
  ) {}

  /** Runs one persistent router turn and returns its validated project decision. */
  async route(job: Job, catalog: RouterCatalog): Promise<Route> {
    const authorizedCatalog: RouterCatalog = {
      ...catalog,
      sourceProjects: await Promise.all(
        catalog.sourceProjects.map(async (entry) => ({
          ...entry,
          sourceRoot: await authorizeSourceRoot(
            catalog.projectsRoot,
            entry.sourceRoot,
            entry.project
          )
        }))
      )
    };
    const workspace = await mkdtemp(join(this.copilotRoot, "router-"));
    const stagedMemory = join(workspace, "agents.md");
    const routerMemory = await readFile(this.memoryPath, "utf8");
    await writeFile(stagedMemory, routerMemory, { encoding: "utf8", flag: "wx" });
    const prompt: RouterPrompt = {
      jobId: job.id,
      rawInput: job.input.raw,
      projectHint: job.input.projectHint,
      originalCwd: job.input.cwd,
      priorAttemptError: job.error,
      routerMemory,
      routerMemoryPath: "agents.md",
      projectsRoot: authorizedCatalog.projectsRoot,
      guppiRoot: authorizedCatalog.guppiRoot,
      sourceProjects: authorizedCatalog.sourceProjects,
      guppiProjects: authorizedCatalog.guppiProjects
    };
    try {
      const output = await this.runAgent({
        workerKey: this.workerKey,
        persistSession: true,
        profile: "router",
        cwd: workspace,
        routerSourceRoots: authorizedCatalog.sourceProjects.map(
          (entry) => entry.sourceRoot
        ),
        prompt: JSON.stringify(prompt, null, 2),
        interactive: false
      });
      const route = validateRoute(parseJson(output), authorizedCatalog);
      await validateRouterWorkspace(workspace, stagedMemory);
      await validateSelectedSourceSummary(
        routerMemory,
        await readFile(stagedMemory, "utf8"),
        route,
        authorizedCatalog
      );
      await publishRouterMemory(workspace, stagedMemory, this.memoryPath);
      return route;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function validateRouterWorkspace(
  workspace: string,
  stagedMemory: string
): Promise<void> {
  const entries = await readdir(workspace, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".github" && entry.isDirectory()) continue;
    if (entry.name === "agents.md" && entry.isFile()) continue;
    throw new Error(`router wrote outside agents.md: ${entry.name}`);
  }
  if (!(await lstat(stagedMemory)).isFile()) {
    throw new Error("router removed agents.md");
  }
}

async function publishRouterMemory(
  workspace: string,
  stagedMemory: string,
  memoryPath: string
): Promise<void> {
  await validateRouterWorkspace(workspace, stagedMemory);
  await rejectSymlink(memoryPath, "Router memory");
  const temporary = `${memoryPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, await readFile(stagedMemory), { flag: "wx" });
    await rename(temporary, memoryPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function validateSelectedSourceSummary(
  before: string,
  staged: string,
  route: Route,
  catalog: RouterCatalog
): Promise<void> {
  if (!route.sourceRoot) return;
  const sourceProject = catalog.sourceProjects.find(
    (entry) => entry.sourceRoot === route.sourceRoot
  );
  if (!sourceProject) {
    throw new Error("validated route lost its selected source project");
  }
  const beforeStats = sourceSummaryStats(before, sourceProject.project);
  const stagedStats = sourceSummaryStats(staged, sourceProject.project);
  if (stagedStats.entries > 1) {
    throw new Error(
      `router memory duplicates the source summary for ${sourceProject.project}`
    );
  }
  if (stagedStats.entries !== 1 || stagedStats.valid !== 1) {
    throw new Error(
      beforeStats.valid === 0
        ? `router did not record a source summary for ${sourceProject.project}`
        : `router removed the source summary for ${sourceProject.project}`
    );
  }
}

function sourceSummaryStats(
  contents: string,
  project: string
): { entries: number; valid: number } {
  let inSection = false;
  let entry: {
    project: string;
    observedAt: number;
    summary: number;
  } | null = null;
  let entries = 0;
  let valid = 0;
  const finishEntry = () => {
    if (
      entry &&
      (entry.project === project ||
        (project === project.trim() && entry.project.trim() === project))
    ) {
      entries += 1;
      if (entry.observedAt === 1 && entry.summary === 1) {
        valid += 1;
      }
    }
    entry = null;
  };

  for (const line of visibleMarkdownLines(contents)) {
    const heading = markdownHeading(line);
    if (heading) {
      finishEntry();
      inSection =
        heading.level === 2 && heading.text === "Source Project Summaries";
      continue;
    }
    if (!inSection) continue;

    const source = line.match(/^\s{0,3}[-*+] Source project: (.*)$/);
    if (source && source[1]) {
      finishEntry();
      entry = {
        project: source[1],
        observedAt: 0,
        summary: 0
      };
      continue;
    }
    if (!entry) continue;

    const observedAt = line.match(/^\s{1,}[-*+] observedAt:\s*(.*?)\s*$/);
    if (observedAt) {
      if (observedAt[1].trim()) entry.observedAt += 1;
      continue;
    }
    const summary = line.match(/^\s{1,}[-*+] Summary:\s*(.*?)\s*$/);
    if (summary) {
      if (summary[1].trim()) entry.summary += 1;
      continue;
    }
    if (line && !/^\s/.test(line)) finishEntry();
  }
  finishEntry();
  return { entries, valid };
}

function markdownHeading(
  line: string
): { level: number; text: string } | null {
  const match = line.match(/^\s{0,3}(#{1,6})[ \t]+(.*)$/);
  if (!match) return null;
  return {
    level: match[1].length,
    text: match[2].replace(/[ \t]+#+[ \t]*$/, "").trim()
  };
}

function parseJson(output: string): unknown {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

function validateRoute(value: unknown, catalog: RouterCatalog): Route {
  if (typeof value !== "object" || value === null) {
    throw new Error("router response must be an object");
  }

  const decision = value as Record<string, unknown>;
  if (typeof decision.reason !== "string" || !decision.reason.trim()) {
    throw new Error("router response must include a non-empty reason");
  }

  if (decision.project === null) {
    if (decision.sourceRoot !== null) {
      throw new Error("an ambiguous route must use sourceRoot null");
    }
    if (typeof decision.question !== "string" || !decision.question.trim()) {
      throw new Error("an ambiguous route must include a non-empty question");
    }
    return {
      project: null,
      sourceRoot: null,
      reason: decision.reason,
      question: decision.question
    };
  }

  if (
    typeof decision.project !== "string" ||
    !isSafeProjectName(decision.project)
  ) {
    throw new Error("router response must include a safe project name");
  }
  if (decision.question !== null) {
    throw new Error("a routed project must use question null");
  }
  if (
    decision.sourceRoot !== null &&
    typeof decision.sourceRoot !== "string"
  ) {
    throw new Error("router sourceRoot must be a string or null");
  }

  const projectId = canonicalProjectId(decision.project);
  const exactGuppiProject = catalog.guppiProjects.find(
    (project) => project === decision.project
  );
  const exactSourceProject = catalog.sourceProjects.find(
    (entry) => entry.project === decision.project
  );
  const canonicalGuppiProject = catalog.guppiProjects.find(
    (project) => canonicalProjectId(project) === projectId
  );
  const canonicalSourceProject = catalog.sourceProjects.find(
    (entry) => canonicalProjectId(entry.project) === projectId
  );
  if (
    !exactGuppiProject &&
    canonicalGuppiProject &&
    exactSourceProject
  ) {
    throw new Error(
      "router project identity is ambiguous across sourceProjects and guppiProjects"
    );
  }
  if (
    !exactGuppiProject &&
    !exactSourceProject &&
    canonicalGuppiProject &&
    canonicalSourceProject &&
    canonicalGuppiProject !== canonicalSourceProject.project
  ) {
    throw new Error(
      "router project identity is ambiguous across sourceProjects and guppiProjects"
    );
  }
  const guppiProject =
    exactGuppiProject ||
    (exactSourceProject ? undefined : canonicalGuppiProject);
  const sourceProject =
    exactSourceProject ||
    (exactGuppiProject ? undefined : canonicalSourceProject);
  const suppliedSource =
    decision.sourceRoot === null
      ? null
      : catalog.sourceProjects.find(
          (entry) => entry.sourceRoot === decision.sourceRoot
        );
  if (decision.sourceRoot !== null && !suppliedSource) {
    throw new Error("router sourceRoot was not supplied in sourceProjects");
  }

  if (guppiProject) {
    return {
      project: guppiProject,
      sourceRoot: decision.sourceRoot,
      reason: decision.reason,
      question: null
    };
  }
  if (sourceProject) {
    if (decision.sourceRoot !== sourceProject.sourceRoot) {
      throw new Error("router sourceRoot does not belong to the selected project");
    }
    return {
      project: sourceProject.project,
      sourceRoot: sourceProject.sourceRoot,
      reason: decision.reason,
      question: null
    };
  }
  if (decision.sourceRoot !== null) {
    throw new Error("a new project cannot claim a catalog sourceRoot");
  }

  return {
    project: decision.project,
    sourceRoot: null,
    reason: decision.reason,
    question: null
  };
}
