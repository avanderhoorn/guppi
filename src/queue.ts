import { execFile as execFileCallback } from "child_process";
import { randomBytes } from "crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "path";
import { promisify } from "util";
import { rejectSymlink } from "./config";

const execFile = promisify(execFileCallback);
const WAIT_MS = 100;
const MUTATION_WAIT_MS = 30_000;
const PROCESS_PROBE_TIMEOUT_MS = 5_000;

export type ProcessIdentity = {
  pid: number;
  startFingerprint: string;
};

export type QueueResult = "continue" | "stop";

export type QueueWork<T> = {
  recover: () => Promise<void>;
  next: () => Promise<T | null>;
  handle: (item: T) => Promise<QueueResult | void>;
};

export type ActiveLock = {
  workerKey: string;
  pid: number;
  childPid: number | null;
  acquiredAt: string;
};

type LockOwner = {
  version: 1;
  workerKey: string;
  token: string;
  owner: ProcessIdentity;
  child: ProcessIdentity | null;
  acquiredAt: string;
};

type Lease = {
  path: string;
  owner: LockOwner;
};

/** Owns cross-process worker exclusion, stale takeover, waiting, and draining. */
export class Queue {
  constructor(private readonly root: string) {}

  /** Returns the current process identity used for interactive ownership. */
  currentIdentity(): Promise<ProcessIdentity> {
    return identityFor(process.pid);
  }

  /** Tests whether a recorded PID still represents the same live process. */
  async isLive(identity: ProcessIdentity | null | undefined): Promise<boolean> {
    return Boolean(
      identity &&
      (await fingerprintFor(identity.pid)) === identity.startFingerprint
    );
  }

  /** Attempts one exclusive drain and returns whether this process acquired it. */
  async drain<T>(workerKey: string, work: QueueWork<T>): Promise<boolean> {
    const lease = await this.acquire(workerKey);
    if (!lease) return false;

    try {
      await work.recover();
      while (true) {
        const item = await work.next();
        if (!item) return true;
        if ((await work.handle(item)) === "stop") return true;
      }
    } finally {
      await this.release(lease);
    }
  }

  /** Waits until the caller's item leaves a stage, draining whenever possible. */
  async waitOrDrain<T>(
    workerKey: string,
    done: () => Promise<boolean>,
    work: QueueWork<T>
  ): Promise<void> {
    const targeted: QueueWork<T> = {
      recover: work.recover,
      next: async () => ((await done()) ? null : work.next()),
      handle: work.handle
    };
    while (!(await done())) {
      await this.drain(workerKey, targeted);
      if (!(await done())) await delay(WAIT_MS);
    }
  }

  /** Runs a short operational mutation under the same lock primitive. */
  async exclusive<T>(workerKey: string, action: () => Promise<T>): Promise<T> {
    while (true) {
      const lease = await this.acquire(workerKey);
      if (!lease) {
        await delay(WAIT_MS);
        continue;
      }
      try {
        return await action();
      } finally {
        await this.release(lease);
      }
    }
  }

  /** Tracks the launch-gate process whose lifetime keeps a worker lock live. */
  async trackChild(
    workerKey: string,
    child: ProcessIdentity | null
  ): Promise<void> {
    const current = await this.currentIdentity();
    await this.mutate(async () => {
      const path = this.pathFor(workerKey);
      const owner = await readJson<LockOwner>(join(path, "owner.json"));
      if (!owner || !sameIdentity(owner.owner, current)) {
        throw new Error(`cannot track child without owning ${workerKey}`);
      }
      await writeJsonAtomic(join(path, "owner.json"), { ...owner, child });
    });
  }

  /** Lists complete canonical worker locks for status output. */
  async activeLocks(): Promise<ActiveLock[]> {
    await mkdir(this.root, { recursive: true });
    const locks: ActiveLock[] = [];
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || isTemporaryLock(entry.name)) continue;
      const owner = await readJson<LockOwner>(
        join(this.root, entry.name, "owner.json")
      );
      if (!owner) continue;
      locks.push({
        workerKey: owner.workerKey,
        pid: owner.owner.pid,
        childPid: owner.child?.pid || null,
        acquiredAt: owner.acquiredAt
      });
    }
    return locks.sort((left, right) =>
      left.workerKey.localeCompare(right.workerKey)
    );
  }

  private async acquire(workerKey: string): Promise<Lease | null> {
    const path = this.pathFor(workerKey);
    const observed = await readJson<LockOwner>(join(path, "owner.json"));
    if (observed && (await this.ownerIsLive(observed))) return null;

    const owner: LockOwner = {
      version: 1,
      workerKey,
      token: randomBytes(12).toString("hex"),
      owner: await this.currentIdentity(),
      child: null,
      acquiredAt: new Date().toISOString()
    };

    return this.mutate(async () => {
      const current = await readJson<LockOwner>(join(path, "owner.json"));
      // Never replace an owner or tracked child changed after the liveness probe.
      if (!sameOwnerRecord(current, observed)) return null;

      if (await exists(path)) {
        const stale = `${path}.stale-${owner.token}`;
        await rename(path, stale);
        await rm(stale, { recursive: true, force: true });
      }

      await installOwner(path, owner);
      return { path, owner };
    });
  }

  private async release(lease: Lease): Promise<void> {
    await this.mutate(async () => {
      const current = await readJson<LockOwner>(
        join(lease.path, "owner.json")
      );
      if (!current || current.token !== lease.owner.token) return;

      const released = `${lease.path}.release-${lease.owner.token}`;
      await rename(lease.path, released);
      const moved = await readJson<LockOwner>(join(released, "owner.json"));
      if (!moved || moved.token !== lease.owner.token) {
        throw new Error(
          `lost lock ownership while releasing ${lease.owner.workerKey}`
        );
      }
      await rm(released, { recursive: true, force: true });
    });
  }

  private async ownerIsLive(owner: LockOwner): Promise<boolean> {
    return (await this.isLive(owner.owner)) || (await this.isLive(owner.child));
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.root, { recursive: true });
    const databasePath = join(this.root, ".mutations.sqlite");
    await rejectSymlink(databasePath, "Lock mutation database");
    const database = new DatabaseSync(databasePath);
    const started = Date.now();
    try {
      while (true) {
        try {
          database.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          if (Date.now() - started >= MUTATION_WAIT_MS) {
            throw new Error("timed out waiting to mutate worker locks");
          }
          await delay(10);
        }
      }

      try {
        const result = await action();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The failed operation may already have ended the transaction.
        }
        throw error;
      }
    } finally {
      database.close();
    }
  }

  private pathFor(workerKey: string): string {
    if (
      workerKey !== "router" &&
      workerKey !== "jobs" &&
      workerKey !== "sessions" &&
      !/^project:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(workerKey)
    ) {
      throw new Error(`invalid worker key: ${workerKey}`);
    }
    return join(this.root, workerKey.replace(":", "-"));
  }
}

/** Resolves one PID to its reuse-safe process identity. */
export async function identityFor(pid: number): Promise<ProcessIdentity> {
  const startFingerprint = await fingerprintFor(pid);
  if (!startFingerprint) {
    throw new Error(`could not establish process identity for PID ${pid}`);
  }
  return { pid, startFingerprint };
}

/** Returns a platform-specific process start fingerprint, or null when dead. */
export async function fingerprintFor(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const processStat = (await readFile(`/proc/${pid}/stat`, "utf8")).trim();
      const closing = processStat.lastIndexOf(")");
      const fields =
        closing === -1
          ? []
          : processStat.slice(closing + 1).trim().split(/\s+/);
      return fields[19] ? `linux:${fields[19]}` : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFile(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`
        ],
        { timeout: PROCESS_PROBE_TIMEOUT_MS }
      );
      return stdout.trim() ? `win:${stdout.trim()}` : null;
    }
    const { stdout } = await execFile(
      "ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        env: {
          ...process.env,
          LC_ALL: "C",
          TZ: "UTC"
        },
        timeout: PROCESS_PROBE_TIMEOUT_MS
      }
    );
    return stdout.trim() ? `posix:${stdout.trim()}` : null;
  } catch (error) {
    if (processProbeTimedOut(error)) {
      throw new Error(`timed out checking process ${pid}`);
    }
    return null;
  }
}

function processProbeTimedOut(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const processError = error as { code?: unknown; killed?: unknown };
  return processError.code === "ETIMEDOUT" || processError.killed === true;
}

async function installOwner(path: string, owner: LockOwner): Promise<void> {
  const prepared = `${path}.prepare-${owner.token}`;
  try {
    await mkdir(prepared);
    await writeFile(
      join(prepared, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
      "utf8"
    );
    await rename(prepared, path);
  } finally {
    await rm(prepared, { recursive: true, force: true });
  }
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

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function sameIdentity(
  left: ProcessIdentity,
  right: ProcessIdentity
): boolean {
  return (
    left.pid === right.pid &&
    left.startFingerprint === right.startFingerprint
  );
}

function sameOwnerRecord(
  left: LockOwner | null,
  right: LockOwner | null
): boolean {
  if (!left || !right) return left === right;
  return (
    left.version === right.version &&
    left.workerKey === right.workerKey &&
    left.token === right.token &&
    sameIdentity(left.owner, right.owner) &&
    ((left.child === null && right.child === null) ||
      (left.child !== null &&
        right.child !== null &&
        sameIdentity(left.child, right.child))) &&
    left.acquiredAt === right.acquiredAt
  );
}

function isTemporaryLock(name: string): boolean {
  return (
    name.includes(".prepare-") ||
    name.includes(".stale-") ||
    name.includes(".release-")
  );
}

function isSqliteBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("database is locked") ||
      error.message.includes("database is busy"))
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
