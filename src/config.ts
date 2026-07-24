import {
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { randomBytes } from "crypto";
import { homedir } from "os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "path";

type StoredGuppiConfig = {
  version: 1;
  projectsRoot: string;
  guppiRoot?: string;
};

export type GuppiConfig = {
  version: 1;
  projectsRoot: string;
  guppiRoot: string;
};

export type GuppiPaths = {
  guppiRoot: string;
  config: string;
  routerMemory: string;
  sessions: string;
  jobs: string;
  locks: string;
  copilot: string;
  skills: string;
};

export type Runtime = {
  config: GuppiConfig;
  paths: GuppiPaths;
};

export const DEFAULT_PROJECTS_ROOT = "~/Projects";
const SHIPPED_AGENTS_ROOT = resolve(
  __dirname,
  "..",
  "..",
  "share",
  "guppi-home",
  ".agents"
);

export class MissingConfigError extends Error {
  constructor(readonly configPath: string) {
    super(`Guppi configuration is missing: ${configPath}`);
    this.name = "MissingConfigError";
  }
}

/** Creates first-run config without initializing Guppi runtime state. */
export async function createConfig(
  projectsRootInput: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): Promise<void> {
  const configHome = await resolveConfigHome(env);
  const configPath = join(configHome, "config.json");
  const entered = projectsRootInput.trim() || DEFAULT_PROJECTS_ROOT;
  const storedProjectsRoot = isConfiguredRoot(entered)
    ? entered
    : resolve(cwd, entered);
  const projectsRoot = await resolveConfiguredRoot(
    storedProjectsRoot,
    "projectsRoot",
    env
  );

  await assertSeparateRoots(configHome, configHome, projectsRoot);
  await mkdir(configHome, { recursive: true });
  await rejectSymlink(configHome, "Guppi config home");
  await rejectSymlink(configPath, "Guppi config");
  await ensureFile(
    configPath,
    `${JSON.stringify(
      { version: 1, projectsRoot: storedProjectsRoot },
      null,
      2
    )}\n`
  );
  if (!(await readConfig(configPath))) {
    throw new Error("config.json could not be created");
  }
}

/** Initializes the configured Guppi root and returns resolved runtime paths. */
export async function loadRuntime(
  env: NodeJS.ProcessEnv = process.env
): Promise<Runtime> {
  const configHome = await resolveConfigHome(env);
  const configPath = join(configHome, "config.json");
  await rejectSymlink(configPath, "Guppi config");
  const stored = await readConfig(configPath);
  if (!stored) throw new MissingConfigError(configPath);

  const projectsRoot = await resolveConfiguredRoot(
    stored.projectsRoot,
    "projectsRoot",
    env
  );
  const guppiRoot = stored.guppiRoot
    ? await resolveConfiguredRoot(
        stored.guppiRoot,
        "guppiRoot",
        env
      )
    : configHome;
  await assertSeparateRoots(configHome, guppiRoot, projectsRoot);

  const paths: GuppiPaths = {
    guppiRoot,
    config: configPath,
    routerMemory: join(guppiRoot, "agents.md"),
    sessions: join(guppiRoot, "sessions.json"),
    jobs: join(guppiRoot, "_jobs"),
    locks: join(guppiRoot, "_locks"),
    copilot: join(guppiRoot, "_copilot"),
    skills: join(guppiRoot, ".agents", "skills")
  };

  await rejectSymlink(paths.guppiRoot, "guppiRoot");
  await mkdir(paths.guppiRoot, { recursive: true });
  await rejectSymlink(paths.guppiRoot, "guppiRoot");
  await ensureShippedAgents(paths.guppiRoot);
  await rejectSymlink(paths.config, "Guppi config");
  await rejectSymlink(paths.sessions, "Guppi sessions");
  await rejectSymlink(paths.jobs, "Guppi jobs directory");
  await rejectSymlink(paths.locks, "Guppi locks directory");
  await rejectSymlink(paths.copilot, "Guppi Copilot directory");
  await rejectSymlink(paths.routerMemory, "Router memory");
  await mkdir(paths.jobs, { recursive: true });
  await mkdir(paths.locks, { recursive: true });
  await mkdir(paths.copilot, { recursive: true });
  await rejectSymlink(paths.jobs, "Guppi jobs directory");
  await rejectSymlink(paths.locks, "Guppi locks directory");
  await rejectSymlink(paths.copilot, "Guppi Copilot directory");
  await ensureFile(paths.routerMemory, "# Router Working Memory\n\n");
  await rejectSymlink(paths.routerMemory, "Router memory");

  return {
    paths,
    config: {
      version: 1,
      projectsRoot,
      guppiRoot
    }
  };
}

/** Expands a leading home marker using the supplied environment. */
export function expandHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

async function readConfig(path: string): Promise<StoredGuppiConfig | null> {
  try {
    return validateConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return null;
  }
}

function validateConfig(value: unknown): StoredGuppiConfig {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { projectsRoot?: unknown }).projectsRoot !== "string" ||
    !(value as { projectsRoot: string }).projectsRoot.trim()
  ) {
    throw new Error(
      "config.json must contain version 1 and a non-empty projectsRoot string"
    );
  }
  const guppiRoot = (value as { guppiRoot?: unknown }).guppiRoot;
  if (
    guppiRoot !== undefined &&
    (typeof guppiRoot !== "string" || !guppiRoot.trim())
  ) {
    throw new Error("config.json guppiRoot must be a non-empty string");
  }
  return {
    version: 1,
    projectsRoot: (value as { projectsRoot: string }).projectsRoot.trim(),
    ...(typeof guppiRoot === "string"
      ? { guppiRoot: guppiRoot.trim() }
      : {})
  };
}

async function ensureFile(path: string, contents: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(temporary, contents, {
      encoding: "utf8",
      flag: "wx"
    });
    await link(temporary, path);
  } catch (error) {
    if (!isExists(error)) throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function ensureShippedAgents(guppiRoot: string): Promise<void> {
  const target = join(guppiRoot, ".agents");
  try {
    if (!(await lstat(target)).isDirectory()) {
      throw new Error(`Guppi agents path must be a directory: ${target}`);
    }
    return;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await cp(SHIPPED_AGENTS_ROOT, temporary, { recursive: true });
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!isDirectoryExists(error)) throw error;
      if (!(await lstat(target)).isDirectory()) {
        throw new Error(`Guppi agents path must be a directory: ${target}`);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Resolves symlinks while preserving missing trailing path segments. */
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}

/** Tests whether one canonical path is equal to or contains another. */
export function containsPath(parent: string, child: string): boolean {
  const relation = relative(comparisonPath(parent), comparisonPath(child));
  return (
    relation === "" ||
    (relation !== ".." &&
      !relation.startsWith(`..${sep}`) &&
      !isAbsolute(relation))
  );
}

/** Tests filesystem identity using the host platform's path case semantics. */
export function samePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right);
}

/** Tests canonical equality or ancestry in either direction. */
export async function pathsOverlap(
  left: string,
  right: string
): Promise<boolean> {
  const [canonicalLeft, canonicalRight] = await Promise.all([
    canonicalPath(left),
    canonicalPath(right)
  ]);
  return (
    containsPath(canonicalLeft, canonicalRight) ||
    containsPath(canonicalRight, canonicalLeft)
  );
}

/** Rejects a symbolic link at one host-managed path. */
export async function rejectSymlink(
  path: string,
  label: string
): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new Error(`${label} cannot be a symbolic link: ${path}`);
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function resolveConfigHome(env: NodeJS.ProcessEnv): Promise<string> {
  const requested = resolve(
    expandHome(env.GUPPI_HOME?.trim() || "~/.guppi", env)
  );
  await rejectUnsafePathSymlinks(requested, "Guppi config home");
  return canonicalPath(requested);
}

async function resolveConfiguredRoot(
  input: string,
  label: string,
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (!isConfiguredRoot(input)) {
    throw new Error(`${label} must be absolute or start with ~/`);
  }
  const requested = resolve(expandHome(input, env));
  await rejectUnsafePathSymlinks(requested, label);
  return canonicalPath(requested);
}

function isConfiguredRoot(input: string): boolean {
  return input === "~" || input.startsWith("~/") || isAbsolute(input);
}

async function rejectUnsafePathSymlinks(
  path: string,
  label: string,
  configuredRoot = path
): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) {
    await rejectUnsafePathSymlinks(parent, label, configuredRoot);
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      if (path === configuredRoot) {
        throw new Error(`${label} cannot be a symbolic link: ${path}`);
      }
      try {
        await realpath(path);
      } catch (error) {
        if (isNotFound(error)) {
          throw new Error(
            `${label} cannot contain dangling symbolic links: ${path}`
          );
        }
        throw error;
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function assertSeparateRoots(
  configHome: string,
  guppiRoot: string,
  projectsRoot: string
): Promise<void> {
  if (await pathsOverlap(configHome, projectsRoot)) {
    throw new Error("GUPPI_HOME must not overlap projectsRoot");
  }
  if (samePath(configHome, guppiRoot)) return;
  if (await pathsOverlap(configHome, guppiRoot)) {
    throw new Error("guppiRoot must be equal to or disjoint from GUPPI_HOME");
  }
  if (await pathsOverlap(guppiRoot, projectsRoot)) {
    throw new Error("guppiRoot must not overlap projectsRoot");
  }
}

function comparisonPath(path: string): string {
  const normalized = path.normalize("NFC");
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function isExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isDirectoryExists(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
