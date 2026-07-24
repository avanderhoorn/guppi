import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "fs/promises";
import { join, resolve } from "path";
import {
  canonicalPath,
  rejectSymlink,
  samePath
} from "./config";
import {
  runCommand,
  runTrackedCommand,
  type CommandResult
} from "./process";
import type { Queue } from "./queue";

const MANAGED_PATHS = [
  ".guppi-receipts",
  "agents.md",
  "project.md",
  "archive.md",
  "research",
  "plans"
] as const;
const SOURCE_STATUS_MAX_ENTRIES = 100;
const SOURCE_STATUS_MAX_BYTES = 16 * 1024;

export type GitRequest = {
  workerKey: string;
  root: string;
  args: string[];
  mutating: boolean;
  operation: string;
};

export type RunGit = (request: GitRequest) => Promise<CommandResult>;

export type GitHead = {
  oid: string;
  message: string;
  receipts: string | null;
  agents: string | null;
};

export type SourceGitSnapshot = {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  statusPorcelain: string[];
  statusTruncated: boolean;
  localOriginMain: string | null;
  /** Commits reachable from HEAD but not from local origin/main. */
  aheadOfOriginMain: number | null;
  /** Commits reachable from local origin/main but not from HEAD. */
  behindOriginMain: number | null;
};

/** Creates the fixed-environment Git process adapter. */
export function createGitRunner(
  queue: Queue,
  operationalRoot: string,
  sourceEnv: NodeJS.ProcessEnv = process.env
): RunGit {
  return async (request) => {
    await rejectSymlink(operationalRoot, "Guppi Copilot directory");
    await mkdir(operationalRoot, { recursive: true });
    await rejectSymlink(operationalRoot, "Guppi Copilot directory");
    const control = await mkdtemp(join(operationalRoot, "git-"));
    const hooks = join(control, "hooks");
    const config = join(control, "config");
    const attributes = join(control, "attributes");
    await mkdir(hooks);
    await writeFile(config, "", { flag: "wx" });
    await writeFile(attributes, "", { flag: "wx" });
    const command = {
      command: "git",
      args: [
        "--no-pager",
        "--literal-pathspecs",
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.attributesFile=${attributes}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "commit.cleanup=verbatim",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "-c",
        "user.name=Guppi",
        "-c",
        "user.email=guppi@localhost",
        "-C",
        request.root,
        ...request.args
      ],
      cwd: request.root,
      env: gitEnvironment(sourceEnv, request.root, config)
    };
    try {
      return request.mutating
        ? await runTrackedCommand(
            request.workerKey,
            command,
            queue,
            "Git"
          )
        : await runCommand(command);
    } finally {
      await rm(control, { recursive: true, force: true });
    }
  };
}

/** Owns project history and bounded read-only source Git mechanics. */
export class ProjectHistory {
  constructor(private readonly runGit: RunGit) {}

  async sourceSnapshot(
    root: string,
    workerKey: string
  ): Promise<SourceGitSnapshot | null> {
    const top = await this.runGit({
      workerKey,
      root,
      args: ["rev-parse", "--show-toplevel"],
      mutating: false,
      operation: "inspect source worktree root"
    });
    if (isExpectedNonWorktree(top)) return null;
    if (top.code !== 0) throw gitError("inspect source worktree root", top);
    const [canonicalRoot, canonicalTop] = await Promise.all([
      canonicalPath(root),
      canonicalPath(resolve(root, oneLine(top.stdout, "source worktree root")))
    ]);
    if (!samePath(canonicalRoot, canonicalTop)) return null;

    const [
      branchResult,
      headResult,
      trackedStatusResult,
      fullStatusResult,
      originResult
    ] =
      await Promise.all([
        this.runGit({
          workerKey,
          root,
          args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
          mutating: false,
          operation: "inspect source branch"
        }),
        this.runGit({
          workerKey,
          root,
          args: ["rev-parse", "--verify", "--quiet", "HEAD"],
          mutating: false,
          operation: "inspect source HEAD"
        }),
        this.runGit({
          workerKey,
          root,
          args: ["status", "--porcelain=v1", "--untracked-files=no"],
          mutating: false,
          operation: "inspect tracked source status"
        }),
        this.runGit({
          workerKey,
          root,
          args: ["status", "--porcelain=v1", "--untracked-files=all"],
          mutating: false,
          operation: "inspect untracked source status"
        }),
        this.runGit({
          workerKey,
          root,
          args: [
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/main"
          ],
          mutating: false,
          operation: "inspect local origin/main"
        })
      ]);
    const branch = optionalLine(branchResult, "inspect source branch");
    const head = optionalLine(headResult, "inspect source HEAD");
    const localOriginMain = optionalLine(
      originResult,
      "inspect local origin/main"
    );
    if (trackedStatusResult.code !== 0) {
      throw gitError("inspect tracked source status", trackedStatusResult);
    }
    if (fullStatusResult.code !== 0) {
      throw gitError("inspect untracked source status", fullStatusResult);
    }
    const trackedStatus = statusLines(trackedStatusResult.stdout);
    const untrackedStatus = statusLines(fullStatusResult.stdout).filter(
      (line) => line.startsWith("?? ")
    );
    const allStatus = prioritizeSourceStatus(trackedStatus, untrackedStatus);
    const status = boundSourceStatus(allStatus);
    const relation = await this.sourceRelation(
      root,
      workerKey,
      head,
      localOriginMain
    );

    return {
      branch,
      head,
      dirty: allStatus.length > 0,
      statusPorcelain: status.entries,
      statusTruncated: status.truncated,
      localOriginMain,
      aheadOfOriginMain: relation?.ahead ?? null,
      behindOriginMain: relation?.behind ?? null
    };
  }

  async ensure(root: string, workerKey: string): Promise<void> {
    const git = join(root, ".git");
    try {
      const metadata = await lstat(git);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`project Git metadata must be a direct directory: ${git}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.execute(
        root,
        workerKey,
        ["init", "--quiet", "--initial-branch=main"],
        true,
        "init"
      );
    }

    await this.validateRepository(root, workerKey);
    if (!(await this.hasHead(root, workerKey))) {
      await this.commitManaged(
        root,
        workerKey,
        "Initialize Guppi project state",
        null,
        false
      );
    }
  }

  async checkpoint(
    root: string,
    workerKey: string,
    subject: string
  ): Promise<boolean> {
    if (!(await this.isDirty(root, workerKey))) return false;
    await this.commitManaged(root, workerKey, subject, null, false);
    return true;
  }

  async commitJob(
    root: string,
    workerKey: string,
    subject: string,
    jobId: string,
    allowEmpty = false
  ): Promise<void> {
    await this.commitManaged(
      root,
      workerKey,
      subject,
      jobId,
      allowEmpty
    );
  }

  async isDirty(root: string, workerKey: string): Promise<boolean> {
    await this.validateRepository(root, workerKey);
    const output = await this.execute(
      root,
      workerKey,
      [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--",
        ...MANAGED_PATHS
      ],
      false,
      "status"
    );
    return output.length > 0;
  }

  async head(root: string, workerKey: string): Promise<GitHead | null> {
    await this.validateRepository(root, workerKey);
    if (!(await this.hasHead(root, workerKey))) return null;
    const oid = (
      await this.execute(
        root,
        workerKey,
        ["rev-parse", "--verify", "HEAD"],
        false,
        "resolve HEAD"
      )
    ).trim();
    const message = await this.execute(
      root,
      workerKey,
      ["show", "-s", "--format=%B", oid],
      false,
      "read HEAD message"
    );
    const [receipts, agents] = await Promise.all([
      this.readBlob(root, workerKey, oid, ".guppi-receipts"),
      this.readBlob(root, workerKey, oid, "agents.md")
    ]);
    const current = (
      await this.execute(
        root,
        workerKey,
        ["rev-parse", "--verify", "HEAD"],
        false,
        "confirm HEAD"
      )
    ).trim();
    if (current !== oid) {
      throw new Error("project HEAD changed while reading completion proof");
    }
    return {
      oid,
      message,
      receipts,
      agents
    };
  }

  private async readBlob(
    root: string,
    workerKey: string,
    oid: string,
    path: string
  ): Promise<string | null> {
    const entry = await this.execute(
      root,
      workerKey,
      ["ls-tree", "-z", "--full-tree", oid, "--", path],
      false,
      `locate committed ${path}`
    );
    if (!entry) return null;
    const match = entry.match(/^[0-7]{6} blob [0-9a-f]+\t([^\0]+)\0$/);
    if (!match || match[1] !== path) {
      throw new Error(`committed project path is not a regular blob: ${path}`);
    }
    return this.execute(
      root,
      workerKey,
      ["show", `${oid}:${path}`],
      false,
      `read committed ${path}`
    );
  }

  private async sourceRelation(
    root: string,
    workerKey: string,
    head: string | null,
    localOriginMain: string | null
  ): Promise<{ ahead: number; behind: number } | null> {
    if (!head || !localOriginMain) return null;
    const mergeBase = await this.runGit({
      workerKey,
      root,
      args: ["merge-base", head, localOriginMain],
      mutating: false,
      operation: "compare source history"
    });
    if (isExpectedEmptyResult(mergeBase)) return null;
    if (mergeBase.code !== 0) {
      throw gitError("compare source history", mergeBase);
    }
    oneLine(mergeBase.stdout, "source merge base");

    const counts = await this.runGit({
      workerKey,
      root,
      args: [
        "rev-list",
        "--left-right",
        "--count",
        `${head}...${localOriginMain}`
      ],
      mutating: false,
      operation: "count source divergence"
    });
    if (counts.code !== 0) {
      throw gitError("count source divergence", counts);
    }
    const match = counts.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      throw new Error("git count source divergence returned malformed output");
    }
    return {
      ahead: Number(match[1]),
      behind: Number(match[2])
    };
  }

  private async commitManaged(
    root: string,
    workerKey: string,
    subject: string,
    jobId: string | null,
    allowEmpty: boolean
  ): Promise<void> {
    await this.validateRepository(root, workerKey);
    if (await this.hasHead(root, workerKey)) {
      await this.execute(
        root,
        workerKey,
        ["reset", "--mixed", "--quiet", "HEAD"],
        true,
        "reset index"
      );
    } else {
      await this.execute(
        root,
        workerKey,
        ["read-tree", "--empty"],
        true,
        "clear index"
      );
    }
    await this.execute(
      root,
      workerKey,
      ["add", "--force", "--all", "--", ...MANAGED_PATHS],
      true,
      "stage project state"
    );
    const staged = (
      await this.execute(
        root,
        workerKey,
        [
          "diff",
          "--cached",
          "--name-only",
          "-z",
          "--diff-filter=ACDMRTUXB"
        ],
        false,
        "inspect staged project state"
      )
    )
      .split("\0")
      .filter(Boolean);
    for (const path of staged) {
      if (!isManagedPath(path)) {
        throw new Error(`Git staged an unmanaged project path: ${path}`);
      }
    }
    if (staged.length === 0 && !allowEmpty) {
      throw new Error(`Git found no managed project changes to commit`);
    }

    const args = [
      "commit",
      "--quiet",
      "--no-verify",
      ...(allowEmpty ? ["--allow-empty"] : []),
      "-m",
      subject,
      ...(jobId ? ["-m", `Guppi-Job: ${jobId}`] : [])
    ];
    await this.execute(root, workerKey, args, true, "commit project state");
    if (await this.isDirty(root, workerKey)) {
      throw new Error("Git project state remained dirty after commit");
    }
  }

  private async hasHead(root: string, workerKey: string): Promise<boolean> {
    const result = await this.runGit({
      workerKey,
      root,
      args: ["rev-parse", "--verify", "--quiet", "HEAD"],
      mutating: false,
      operation: "verify HEAD"
    });
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw gitError("verify HEAD", result);
  }

  private async validateRepository(
    root: string,
    workerKey: string
  ): Promise<void> {
    const git = join(root, ".git");
    const metadata = await lstat(git);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`project Git metadata must be a direct directory: ${git}`);
    }

    const [canonicalRoot, canonicalGit, top, gitDirectory, commonDirectory] =
      await Promise.all([
        canonicalPath(root),
        canonicalPath(git),
        this.execute(
          root,
          workerKey,
          ["rev-parse", "--show-toplevel"],
          false,
          "verify worktree root"
        ),
        this.execute(
          root,
          workerKey,
          ["rev-parse", "--absolute-git-dir"],
          false,
          "verify Git directory"
        ),
        this.execute(
          root,
          workerKey,
          ["rev-parse", "--git-common-dir"],
          false,
          "verify Git common directory"
        )
      ]);
    const actualTop = await canonicalPath(resolve(root, top.trim()));
    const actualGit = await canonicalPath(resolve(root, gitDirectory.trim()));
    const actualCommon = await canonicalPath(
      resolve(root, commonDirectory.trim())
    );
    if (!samePath(actualTop, canonicalRoot)) {
      throw new Error("project Git worktree escaped its durable root");
    }
    if (
      !samePath(actualGit, canonicalGit) ||
      !samePath(actualCommon, canonicalGit)
    ) {
      throw new Error("project Git metadata escaped its durable root");
    }

    for (const forbidden of [
      join(git, "commondir"),
      join(git, "objects", "info", "alternates"),
      join(git, "info", "attributes"),
      join(git, "info", "grafts")
    ]) {
      try {
        await lstat(forbidden);
        throw new Error(`project Git metadata contains unsafe path: ${forbidden}`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
    await validateMetadataTree(git);
  }

  private async execute(
    root: string,
    workerKey: string,
    args: string[],
    mutating: boolean,
    operation: string
  ): Promise<string> {
    const result = await this.runGit({
      workerKey,
      root,
      args,
      mutating,
      operation
    });
    if (result.code !== 0) throw gitError(operation, result);
    return result.stdout;
  }
}

function gitEnvironment(
  source: NodeJS.ProcessEnv,
  root: string,
  globalConfig: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...source };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("GIT_") ||
      normalized === "EMAIL" ||
      normalized === "NODE_OPTIONS" ||
      normalized === "NODE_PATH"
    ) {
      delete environment[key];
    }
  }
  environment.PWD = root;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = globalConfig;
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_PAGER = "cat";
  environment.LC_ALL = "C";
  environment.LANG = "C";
  return environment;
}

async function validateMetadataTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`project Git metadata cannot contain symlinks: ${path}`);
    }
    if (metadata.isDirectory()) {
      await validateMetadataTree(path);
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`project Git metadata has unsupported path: ${path}`);
    }
    if (metadata.nlink !== 1) {
      throw new Error(`project Git metadata cannot contain hard links: ${path}`);
    }
  }
}

function isManagedPath(path: string): boolean {
  return (
    path === ".guppi-receipts" ||
    path === "agents.md" ||
    path === "project.md" ||
    path === "archive.md" ||
    path === "research" ||
    path.startsWith("research/") ||
    path === "plans" ||
    path.startsWith("plans/")
  );
}

function optionalLine(result: CommandResult, operation: string): string | null {
  if (isExpectedEmptyResult(result)) return null;
  if (result.code !== 0) throw gitError(operation, result);
  return oneLine(result.stdout, operation);
}

function isExpectedEmptyResult(result: CommandResult): boolean {
  return (
    result.code === 1 &&
    result.signal === null &&
    result.gateError === null &&
    !result.stdout.trim() &&
    !result.stderr.trim()
  );
}

function oneLine(output: string, label: string): string {
  const value = output.trim();
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`git ${label} returned malformed output`);
  }
  return value;
}

function isExpectedNonWorktree(result: CommandResult): boolean {
  if (result.code !== 128) return false;
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    detail.includes("not a git repository") ||
    detail.includes("must be run in a work tree")
  );
}

function statusLines(output: string): string[] {
  return output
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter(Boolean);
}

function prioritizeSourceStatus(
  tracked: string[],
  untracked: string[]
): string[] {
  // Preserve one example from each category before applying shared bounds.
  return [
    ...tracked.slice(0, 1),
    ...untracked.slice(0, 1),
    ...tracked.slice(1),
    ...untracked.slice(1)
  ];
}

function boundSourceStatus(lines: string[]): {
  entries: string[];
  truncated: boolean;
} {
  const entries: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    if (entries.length >= SOURCE_STATUS_MAX_ENTRIES) {
      return { entries, truncated: true };
    }
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > SOURCE_STATUS_MAX_BYTES) {
      return { entries, truncated: true };
    }
    entries.push(line);
    bytes += lineBytes;
  }
  return { entries, truncated: false };
}

function gitError(operation: string, result: CommandResult): Error {
  const detail = (
    result.gateError ||
    result.stderr.trim() ||
    result.stdout.trim()
  ).slice(-4096);
  const exit = result.signal
    ? `signal ${result.signal}`
    : `code ${result.code ?? "unknown"}`;
  return new Error(
    `git ${operation} exited with ${exit}${detail ? `: ${detail}` : ""}`
  );
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
