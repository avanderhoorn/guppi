import { randomBytes } from "crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { basename, dirname, join } from "path";
import type { RunAgent } from "./agent";
import {
  canonicalPath,
  containsPath,
  pathsOverlap,
  rejectSymlink,
  samePath,
  type GuppiPaths
} from "./config";
import { ProjectHistory } from "./git";
import type { Job } from "./jobs";
import { visibleMarkdown } from "./util";

const RESERVED_PROJECT_NAMES = new Set([
  "agents.md",
  "config.json",
  "sessions.json"
]);
const COMMIT_MESSAGE_FILE = ".guppi-commit-message";
const RECEIPTS_FILE = ".guppi-receipts";
const RECEIPTS_TEMP_PREFIX = ".guppi-receipts.tmp-";
const AGENTS_MIGRATION_TEMP_PREFIX = ".guppi-agents-migration.tmp-";
const JOB_ID_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[0-9a-f]{8}$/;

export type SourceProjectEntry = {
  project: string;
  sourceRoot: string;
};

export type RouterCatalog = {
  projectsRoot: string;
  guppiRoot: string;
  sourceProjects: SourceProjectEntry[];
  guppiProjects: string[];
};

type ProjectFiles = {
  root: string;
  memory: string;
  journal: string;
  archive: string;
  research: string;
  plans: string;
};

export type ProjectState = ProjectFiles & {
  receipts: string;
};

type ProjectWorkspace = ProjectFiles & {
  commitMessage: string;
};

/** Owns project discovery, identity, state initialization, and agent handoff. */
export class Projects {
  constructor(
    private readonly paths: GuppiPaths,
    private readonly projectsRoot: string,
    private readonly runAgent: RunAgent,
    private readonly history?: ProjectHistory
  ) {}

  /** Returns the canonical key shared by a project's queue and session. */
  workerKey(project: string): string {
    return `project:${canonicalProjectId(project)}`;
  }

  /** Builds the router's separate source and durable project catalogs. */
  async catalog(pendingJobs: Job[] = []): Promise<RouterCatalog> {
    const sourceProjects = new Map<string, SourceProjectEntry>();
    const guppiProjects = new Map<string, string>();

    for (const project of await childDirectories(this.projectsRoot)) {
      if (!isSafeProjectName(project)) continue;
      addSourceProject(sourceProjects, {
        project,
        sourceRoot: join(this.projectsRoot, project)
      });
    }

    for (const project of await childDirectories(this.paths.guppiRoot)) {
      if (!isSafeProjectName(project)) continue;
      addGuppiProject(guppiProjects, project);
    }

    for (const job of pendingJobs) {
      if (
        (job.status !== "queued-project" && job.status !== "working") ||
        !job.route?.project
      ) {
        continue;
      }
      const projectId = canonicalProjectId(job.route.project);
      if (!projectId) {
        throw new Error(
          `project name has no canonical identity: ${job.route.project}`
        );
      }
      if (!guppiProjects.has(projectId)) {
        guppiProjects.set(projectId, job.route.project);
      }
    }

    return {
      projectsRoot: this.projectsRoot,
      guppiRoot: this.paths.guppiRoot,
      sourceProjects: [...sourceProjects.values()].sort((left, right) =>
        left.project.localeCompare(right.project)
      ),
      guppiProjects: [...guppiProjects.values()].sort((left, right) =>
        left.localeCompare(right)
      )
    };
  }

  /** Lists project worker keys that have queued or recoverable active jobs. */
  pendingWorkerKeys(jobs: Job[]): string[] {
    const workerKeys = new Set<string>();
    for (const job of jobs) {
      if (
        (job.status === "queued-project" || job.status === "working") &&
        job.route?.project
      ) {
        workerKeys.add(this.workerKey(job.route.project));
      }
    }
    return [...workerKeys].sort();
  }

  /** Tests whether a routed job belongs to one canonical project worker. */
  belongsTo(job: Job, workerKey: string): boolean {
    return (
      typeof job.route?.project === "string" &&
      this.workerKey(job.route.project) === workerKey
    );
  }

  /** Runs one idempotent project turn and requires its durable completion marker. */
  async incorporate(job: Job): Promise<void> {
    if (!job.route?.project) throw new Error("project job has no route");

    const sourceRoot = job.route.sourceRoot
      ? await authorizeSourceRoot(
          this.projectsRoot,
          job.route.sourceRoot,
          job.route.project
        )
      : null;
    const history = this.projectHistory();
    const workerKey = this.workerKey(job.route.project);
    const sourceGit = sourceRoot
      ? await history.sourceSnapshot(sourceRoot, workerKey)
      : null;
    const state = await this.stateFor(job);
    const before = await countReceipt(state.receipts, job.id);
    if (before > 1) {
      throw new Error(`project receipt is duplicated for ${job.id}`);
    }
    if (await this.hasCommittedReceipt(state, job)) return;
    if (before === 1) {
      if (!(await this.recoverCompletionState(state, job))) {
        throw new Error(`project completion could not be recovered for ${job.id}`);
      }
      return;
    }
    await history.checkpoint(
      state.root,
      workerKey,
      `Checkpoint Guppi state before ${job.id}`
    );

    const staged = await stageState(this.paths.copilot, state);
    try {
      const prompt = {
        jobId: job.id,
        rawInput: job.input.raw,
        originalCwd: job.input.cwd,
        sourceRoot,
        sourceGit,
        projectDescription: null,
        guppiProjectRoot: staged.root,
        isInteractive: job.input.mode === "interactive"
      };
      let invocationError: unknown;
      try {
        await this.runAgent({
          workerKey,
          persistSession: true,
          profile: "project",
          cwd: staged.root,
          sourceRoot: sourceRoot || undefined,
          prompt: JSON.stringify(prompt, null, 2),
          interactive: job.input.mode === "interactive"
        });
      } catch (error) {
        invocationError = error;
      }

      let commitSubject: string;
      try {
        commitSubject = await validateProjectResult(staged);
      } catch (error) {
        if (invocationError) throw invocationError;
        throw error;
      }
      await publishState(staged, state);
      await addReceipt(state.receipts, job.id);
      await history.commitJob(
        state.root,
        workerKey,
        commitSubject,
        job.id
      );
      if (!(await this.hasCommittedReceipt(state, job))) {
        throw new Error(`project commit did not prove completion for ${job.id}`);
      }
    } finally {
      await rm(staged.root, { recursive: true, force: true });
    }
  }

  /** Recovers a published completion without launching another project turn. */
  async recoverCompletion(job: Job): Promise<boolean> {
    if (!job.route?.project) throw new Error("project job has no route");
    const state = this.projectState(job.route.project);
    await assertStateLocation(this.paths.guppiRoot, state.root, job.route.project);
    await rejectSymlink(state.root, "project state root");
    const count = await countExistingReceipt(state, job.id);
    if (count > 1) {
      throw new Error(`project receipt is duplicated for ${job.id}`);
    }
    if (count === 0) return false;
    const prepared = await this.stateFor(job);
    return this.recoverCompletionState(prepared, job);
  }

  private async recoverCompletionState(
    state: ProjectState,
    job: Job
  ): Promise<boolean> {
    const count = await countReceipt(state.receipts, job.id);
    if (count > 1) {
      throw new Error(`project receipt is duplicated for ${job.id}`);
    }
    if (await this.hasCommittedReceipt(state, job)) return true;
    if (count !== 1) return false;

    await this.projectHistory().commitJob(
      state.root,
      this.workerKey(job.route!.project!),
      `Recover completed Guppi job ${job.id}`,
      job.id,
      true
    );
    if (!(await this.hasCommittedReceipt(state, job))) {
      throw new Error(`project recovery did not prove completion for ${job.id}`);
    }
    return true;
  }

  private async hasCommittedReceipt(
    state: ProjectState,
    job: Job
  ): Promise<boolean> {
    const head = await this.projectHistory().head(
      state.root,
      this.workerKey(job.route!.project!)
    );
    if (!head || !isJobCommit(head.message, job.id)) return false;
    const count = head.receipts !== null
      ? countReceiptContents(head.receipts, job.id)
      : head.agents !== null
        ? countLegacyReceiptContents(head.agents, job.id)
        : 0;
    if (count > 1) {
      throw new Error(`committed project receipt is duplicated for ${job.id}`);
    }
    return count === 1;
  }

  private projectHistory(): ProjectHistory {
    if (!this.history) {
      throw new Error("project Git history is unavailable");
    }
    return this.history;
  }

  private async ensure(project: string): Promise<ProjectState> {
    if (!isSafeProjectName(project)) {
      throw new Error(`router returned unsafe project name: ${project}`);
    }

    const state = this.projectState(project);

    await mkdir(state.root, { recursive: true });
    await assertStateLocation(this.paths.guppiRoot, state.root, project);
    await rejectSymlink(state.root, "project state root");
    await rejectSymlink(state.memory, "project memory");
    await rejectSymlink(state.journal, "project journal");
    await rejectSymlink(state.archive, "project archive");
    await rejectSymlink(state.receipts, "project receipts");
    await rejectSymlink(state.research, "project research");
    await rejectSymlink(state.plans, "project plans");
    await mkdir(state.research, { recursive: true });
    await mkdir(state.plans, { recursive: true });
    await cleanupMigrationTemps(state.root);
    await ensureFile(
      state.memory,
      `# ${project} Agent Guidance\n\n`
    );
    await migrateLegacyState(state, project);
    await ensureFile(state.journal, `# ${project}\n\n`);
    await ensureFile(state.archive, "# Archive\n\n");
    await validateDurableState(state, false);
    await this.projectHistory().ensure(state.root, this.workerKey(project));
    await validateDurableState(state);
    return state;
  }

  private async stateFor(job: Job): Promise<ProjectState> {
    const route = job.route;
    if (!route?.project) throw new Error("project job has no route");
    const project = route.project;
    if (!isSafeProjectName(project)) {
      throw new Error(`router returned unsafe project name: ${project}`);
    }
    const state = this.projectState(project);
    await assertStateLocation(this.paths.guppiRoot, state.root, project);
    await rejectSymlink(state.root, "project state root");
    if (
      route.sourceRoot &&
      (await pathsOverlap(state.root, route.sourceRoot))
    ) {
      throw new Error(`project state overlaps sourceRoot for ${project}`);
    }
    if (await pathsOverlap(state.root, this.projectsRoot)) {
      throw new Error(`project state overlaps projectsRoot for ${project}`);
    }
    return this.ensure(project);
  }

  private projectState(project: string): ProjectState {
    const root = join(this.paths.guppiRoot, project);
    return {
      root,
      memory: join(root, "agents.md"),
      journal: join(root, "project.md"),
      archive: join(root, "archive.md"),
      receipts: join(root, RECEIPTS_FILE),
      research: join(root, "research"),
      plans: join(root, "plans")
    };
  }
}

/** Normalizes a display name for project identity and worker ownership. */
export function canonicalProjectId(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Checks whether a router-supplied name is safe as a Guppi state directory. */
export function isSafeProjectName(project: string): boolean {
  return (
    project.length > 0 &&
    project.length <= 100 &&
    basename(project) === project &&
    !project.startsWith(".") &&
    !project.startsWith("_") &&
    !/[\u0000-\u001f\u007f]/.test(project) &&
    !RESERVED_PROJECT_NAMES.has(project.toLowerCase()) &&
    canonicalProjectId(project).length > 0
  );
}

function isJobCommit(message: string, jobId: string): boolean {
  const lines = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  return (
    lines.length === 3 &&
    Boolean(lines[0]) &&
    lines[1] === "" &&
    lines[2] === `Guppi-Job: ${jobId}`
  );
}

type LegacyReceiptSection = {
  start: number;
  end: number;
  ids: string[];
};

async function migrateLegacyState(
  state: ProjectState,
  project: string
): Promise<void> {
  const agents = await readRegularFile(state.memory, "project agent guidance");
  const legacy = parseLegacyReceiptSection(agents);
  const existing = await readReceiptIdsIfPresent(state.receipts);
  const receipts = existing ? [...existing] : [];
  const known = new Set(receipts);
  for (const id of legacy?.ids || []) {
    if (!known.has(id)) {
      receipts.push(id);
      known.add(id);
    }
  }
  if (!existing || receipts.length !== existing.length) {
    await writeAtomicFile(
      state.receipts,
      serializeReceipts(receipts),
      RECEIPTS_TEMP_PREFIX,
      "project receipts"
    );
  }

  let guidance = legacy
    ? `${agents.slice(0, legacy.start)}${agents.slice(legacy.end)}`
    : agents;
  const oldTitle = `# ${project} Agent Working Memory`;
  const newTitle = `# ${project} Agent Guidance`;
  if (guidance === oldTitle || guidance.startsWith(`${oldTitle}\n`)) {
    guidance = `${newTitle}${guidance.slice(oldTitle.length)}`;
  } else if (guidance.startsWith(`${oldTitle}\r\n`)) {
    guidance = `${newTitle}${guidance.slice(oldTitle.length)}`;
  }
  if (guidance !== agents) {
    await writeAtomicFile(
      state.memory,
      guidance,
      AGENTS_MIGRATION_TEMP_PREFIX,
      "project agent guidance"
    );
  }
}

async function countExistingReceipt(
  state: ProjectState,
  jobId: string
): Promise<number> {
  const receipts = await readReceiptIdsIfPresent(state.receipts);
  if (receipts) return countId(receipts, jobId);
  try {
    const agents = await readRegularFile(state.memory, "project agent guidance");
    return countLegacyReceiptContents(agents, jobId);
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
}

async function countReceipt(path: string, jobId: string): Promise<number> {
  return countId(await readReceiptIds(path), jobId);
}

function countReceiptContents(contents: string, jobId: string): number {
  return countId(parseReceiptContents(contents), jobId);
}

function countLegacyReceiptContents(contents: string, jobId: string): number {
  return countId(parseLegacyReceiptSection(contents)?.ids || [], jobId);
}

function countId(ids: string[], jobId: string): number {
  return ids.filter((id) => id === jobId).length;
}

async function addReceipt(path: string, jobId: string): Promise<void> {
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new Error(`invalid Guppi job ID for project receipt: ${jobId}`);
  }
  const receipts = await readReceiptIds(path);
  if (receipts.includes(jobId)) {
    throw new Error(`project receipt is duplicated for ${jobId}`);
  }
  await writeAtomicFile(
    path,
    serializeReceipts([...receipts, jobId]),
    RECEIPTS_TEMP_PREFIX,
    "project receipts"
  );
}

async function readReceiptIds(path: string): Promise<string[]> {
  return parseReceiptContents(await readRegularFile(path, "project receipts"));
}

async function readReceiptIdsIfPresent(path: string): Promise<string[] | null> {
  try {
    return await readReceiptIds(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function parseReceiptContents(contents: string): string[] {
  if (!contents.endsWith("\n")) {
    throw new Error("project receipts must end with a newline");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines[0] !== "v1") {
    throw new Error("project receipts must use version v1");
  }
  const ids = lines.slice(1);
  const seen = new Set<string>();
  for (const id of ids) {
    if (!JOB_ID_PATTERN.test(id)) {
      throw new Error(`project receipts contain an invalid job ID: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`project receipts duplicate job ID: ${id}`);
    }
    seen.add(id);
  }
  return ids;
}

function serializeReceipts(ids: string[]): string {
  return `v1\n${ids.length > 0 ? `${ids.join("\n")}\n` : ""}`;
}

function parseLegacyReceiptSection(
  contents: string
): LegacyReceiptSection | null {
  let offset = 0;
  let section: LegacyReceiptSection | null = null;
  let active = false;
  let inComment = false;
  let fence: { marker: string; length: number } | null = null;

  while (offset < contents.length) {
    const newline = contents.indexOf("\n", offset);
    const end = newline === -1 ? contents.length : newline + 1;
    const rawWithEnding = contents.slice(offset, end);
    const rawLine = rawWithEnding
      .replace(/\n$/, "")
      .replace(/\r$/, "");

    if (active) {
      if (/^#{1,2} /.test(rawLine)) {
        section!.end = offset;
        active = false;
      } else {
        if (
          rawLine.includes("<!--") ||
          /^\s{0,3}(`{3,}|~{3,})/.test(rawLine)
        ) {
          throw new Error(
            "legacy processed jobs contain ambiguous comments or fenced content"
          );
        }
        if (rawLine.trim() !== "") {
          const marker = rawLine.match(/^- (.+)$/);
          if (!marker || !JOB_ID_PATTERN.test(marker[1])) {
            throw new Error(
              "legacy processed jobs contain malformed visible content"
            );
          }
          if (section!.ids.includes(marker[1])) {
            throw new Error(`legacy processed jobs duplicate ${marker[1]}`);
          }
          section!.ids.push(marker[1]);
        }
        offset = end;
        continue;
      }
    }

    if (fence) {
      const closing = rawLine.match(/^\s{0,3}(`+|~+)\s*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      offset = end;
      continue;
    }

    const visible = visibleMarkdown(rawLine, inComment);
    inComment = visible.inComment;
    const line = visible.line;
    const opening = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = {
        marker: opening[1][0],
        length: opening[1].length
      };
      offset = end;
      continue;
    }
    if (line === "## Processed Jobs") {
      if (section) {
        throw new Error("project agent guidance has multiple processed-job sections");
      }
      section = { start: offset, end: contents.length, ids: [] };
      active = true;
    }
    offset = end;
  }
  return section;
}

function addSourceProject(
  catalog: Map<string, SourceProjectEntry>,
  entry: SourceProjectEntry
): void {
  const projectId = canonicalProjectId(entry.project);
  if (!projectId) {
    throw new Error(`project name has no canonical identity: ${entry.project}`);
  }
  const existing = catalog.get(projectId);
  if (existing) {
    if (existing.project !== entry.project) {
      throw new Error(
        `project identity collision: ${existing.project} and ${entry.project}`
      );
    }
    if (existing.sourceRoot !== entry.sourceRoot) {
      throw new Error(`project sourceRoot collision: ${entry.project}`);
    }
    return;
  }
  catalog.set(projectId, entry);
}

function addGuppiProject(
  catalog: Map<string, string>,
  project: string
): void {
  const projectId = canonicalProjectId(project);
  if (!projectId) {
    throw new Error(`project name has no canonical identity: ${project}`);
  }
  const existing = catalog.get(projectId);
  if (existing && existing !== project) {
    throw new Error(`project identity collision: ${existing} and ${project}`);
  }
  catalog.set(projectId, project);
}

async function childDirectories(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

async function assertStateLocation(
  home: string,
  stateRoot: string,
  project: string
): Promise<void> {
  const [canonicalHome, canonicalState] = await Promise.all([
    canonicalPath(home),
    canonicalPath(stateRoot)
  ]);
  if (
    samePath(canonicalHome, canonicalState) ||
    !containsPath(canonicalHome, canonicalState)
  ) {
    throw new Error(`project state escapes guppiRoot for ${project}`);
  }
}

export async function authorizeSourceRoot(
  projectsRoot: string,
  sourceRoot: string,
  project: string
): Promise<string> {
  const canonicalProjectsRoot = await canonicalPath(projectsRoot);
  if (!samePath(canonicalProjectsRoot, projectsRoot)) {
    throw new Error(`projectsRoot no longer resolves to its configured location`);
  }
  const source = await lstat(sourceRoot);
  if (source.isSymbolicLink() || !source.isDirectory()) {
    throw new Error(`sourceRoot is no longer a real directory for ${project}`);
  }
  const canonicalSourceRoot = await canonicalPath(sourceRoot);
  if (!samePath(dirname(canonicalSourceRoot), canonicalProjectsRoot)) {
    throw new Error(`sourceRoot escaped projectsRoot for ${project}`);
  }
  return canonicalSourceRoot;
}

async function stageState(
  workspaceRoot: string,
  state: ProjectState
): Promise<ProjectWorkspace> {
  await validateDurableState(state);
  const root = await mkdtemp(join(workspaceRoot, "project-"));
  const staged: ProjectWorkspace = {
    root,
    memory: join(root, "agents.md"),
    journal: join(root, "project.md"),
    archive: join(root, "archive.md"),
    research: join(root, "research"),
    plans: join(root, "plans"),
    commitMessage: join(root, COMMIT_MESSAGE_FILE)
  };
  await mkdir(staged.research);
  await mkdir(staged.plans);
  await Promise.all([
    copyFile(state.memory, staged.memory),
    copyFile(state.journal, staged.journal),
    copyFile(state.archive, staged.archive),
    copyArtifacts(state.research, staged.research),
    copyArtifacts(state.plans, staged.plans)
  ]);
  return staged;
}

async function publishState(
  staged: ProjectWorkspace,
  state: ProjectState
): Promise<void> {
  await validateWorkspace(staged);
  const publications = await Promise.allSettled([
    replaceFile(staged.journal, state.journal),
    replaceFile(staged.archive, state.archive),
    publishArtifacts(staged.research, state.research),
    publishArtifacts(staged.plans, state.plans)
  ]);
  const failures = publications
    .filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected"
    )
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "project state publication failed");
  }
  await replaceFile(staged.memory, state.memory);
}

async function validateProjectResult(staged: ProjectWorkspace): Promise<string> {
  await validateWorkspace(staged);
  return readCommitSubject(staged.commitMessage);
}

async function validateDurableState(
  state: ProjectState,
  requireGit = true
): Promise<void> {
  await validateStateShape(
    state,
    new Map([
      [".git", "directory"],
      [RECEIPTS_FILE, "file"],
      ["agents.md", "file"],
      ["project.md", "file"],
      ["archive.md", "file"],
      ["research", "directory"],
      ["plans", "directory"]
    ]),
    false,
    requireGit ? new Set() : new Set([".git"])
  );
}

async function validateWorkspace(staged: ProjectWorkspace): Promise<void> {
  await validateStateShape(
    staged,
    new Map([
      [COMMIT_MESSAGE_FILE, "file"],
      ["agents.md", "file"],
      ["project.md", "file"],
      ["archive.md", "file"],
      ["research", "directory"],
      ["plans", "directory"]
    ]),
    true,
    new Set()
  );
  if (parseLegacyReceiptSection(await readFile(staged.memory, "utf8"))) {
    throw new Error("project agents.md cannot contain processed-job receipts");
  }
}

async function validateStateShape(
  state: ProjectFiles,
  expected: Map<string, string>,
  allowCopilotSettings: boolean,
  optionalMissing: Set<string>
): Promise<void> {
  const entries = await readdir(state.root, { withFileTypes: true });
  for (const entry of entries) {
    if (
      allowCopilotSettings &&
      entry.name === ".github" &&
      entry.isDirectory()
    ) {
      await validateCopilotSettings(join(state.root, entry.name));
      continue;
    }
    const kind = expected.get(entry.name);
    if (
      !kind ||
      (kind === "file" && !entry.isFile()) ||
      (kind === "directory" && !entry.isDirectory())
    ) {
      throw new Error(`project state contains unmanaged path: ${entry.name}`);
    }
    expected.delete(entry.name);
  }
  for (const name of optionalMissing) expected.delete(name);
  if (expected.size > 0) {
    throw new Error(
      `project state is missing managed paths: ${[...expected.keys()].join(", ")}`
    );
  }
  await Promise.all([
    validateArtifacts(state.research),
    validateArtifacts(state.plans)
  ]);
}

async function readCommitSubject(path: string): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("project commit message must be a regular file");
  }
  const contents = await readFile(path, "utf8");
  const subject = contents.endsWith("\n")
    ? contents.slice(0, -1)
    : contents;
  if (
    !subject ||
    subject !== subject.trim() ||
    subject.length > 100 ||
    /[\r\n\u0000-\u001f\u007f]/.test(subject)
  ) {
    throw new Error(
      "project commit message must be one trimmed line of at most 100 characters"
    );
  }
  return subject;
}

async function validateCopilotSettings(github: string): Promise<void> {
  const entries = await readdir(github, { withFileTypes: true });
  if (
    entries.length !== 1 ||
    entries[0].name !== "copilot" ||
    !entries[0].isDirectory()
  ) {
    throw new Error("project state contains unmanaged .github content");
  }
  const settings = await readdir(join(github, "copilot"), {
    withFileTypes: true
  });
  if (
    settings.length !== 1 ||
    settings[0].name !== "settings.local.json" ||
    !settings[0].isFile()
  ) {
    throw new Error("project state contains unmanaged Copilot settings");
  }
}

async function validateArtifacts(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await validateArtifacts(path);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      throw new Error(`project artifacts must be Markdown files: ${path}`);
    }
  }
}

async function copyArtifacts(source: string, target: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to);
      await copyArtifacts(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

async function publishArtifacts(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await publishArtifacts(from, to);
    } else {
      await replaceFile(from, to);
    }
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  await rejectSymlink(target, "managed project file");
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(temporary, await readFile(source), { flag: "wx" });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function cleanupMigrationTemps(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (
      !entry.name.startsWith(RECEIPTS_TEMP_PREFIX) &&
      !entry.name.startsWith(AGENTS_MIGRATION_TEMP_PREFIX)
    ) {
      continue;
    }
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1
    ) {
      throw new Error(`unsafe stale project migration path: ${path}`);
    }
    await rm(path);
  }
}

async function readRegularFile(path: string, label: string): Promise<string> {
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1
  ) {
    throw new Error(`${label} must be a regular file`);
  }
  return readFile(path, "utf8");
}

async function writeAtomicFile(
  target: string,
  contents: string,
  prefix: string,
  label: string
): Promise<void> {
  await rejectSymlink(target, label);
  const temporary = join(
    dirname(target),
    `${prefix}${process.pid}-${randomBytes(6).toString("hex")}`
  );
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    const metadata = await lstat(temporary);
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new Error(`${label} temporary file is unsafe`);
    }
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function ensureFile(path: string, contents: string): Promise<void> {
  try {
    const handle = await open(path, "wx");
    try {
      await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isExists(error)) throw error;
  }
}

function isExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
