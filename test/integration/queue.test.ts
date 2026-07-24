import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile
} from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { join } from "path";
import {
  fingerprintFor,
  identityFor,
  Queue,
  type QueueWork
} from "../../src/queue";

test("one worker lock serializes competing drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-queue-"));
  const locks = join(root, "_locks");
  const first = new Queue(locks);
  const second = new Queue(locks);
  const entered = deferred();
  const release = deferred();
  let firstHandled = 0;
  let secondHandled = 0;

  const firstDrain = first.drain(
    "router",
    oneItemWork(async () => {
      firstHandled += 1;
      entered.resolve();
      await release.promise;
    })
  );
  await entered.promise;
  const secondAcquired = await second.drain(
    "router",
    oneItemWork(async () => {
      secondHandled += 1;
    })
  );

  assert.equal(secondAcquired, false);
  assert.equal(secondHandled, 0);
  release.resolve();
  assert.equal(await firstDrain, true);
  assert.equal(firstHandled, 1);
  assert.deepEqual(await first.activeLocks(), []);
});

test(
  "lock mutation database cannot be a symbolic link",
  { skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "guppi-queue-db-"));
    const locks = join(root, "_locks");
    const outside = join(root, "outside.sqlite");
    await mkdir(locks, { recursive: true });
    await writeFile(outside, "outside\n", "utf8");
    await symlink(outside, join(locks, ".mutations.sqlite"));

    await assert.rejects(
      new Queue(locks).exclusive("jobs", async () => undefined),
      /Lock mutation database cannot be a symbolic link/
    );
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  }
);

test("competing workers recover one dead canonical lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-stale-"));
  const locks = join(root, "_locks");
  const router = join(locks, "router");
  await mkdir(router, { recursive: true });
  await writeFile(
    join(router, "owner.json"),
    `${JSON.stringify({
      version: 1,
      workerKey: "router",
      token: "dead-owner",
      owner: { pid: 999_999, startFingerprint: "dead" },
      child: null,
      acquiredAt: new Date(0).toISOString()
    })}\n`,
    "utf8"
  );

  const first = new Queue(locks);
  const second = new Queue(locks);
  const entered = deferred();
  const release = deferred();
  let recoveries = 0;
  let handled = 0;
  const firstDrain = first.drain("router", {
    ...oneItemWork(async () => {
      handled += 1;
      await release.promise;
    }),
    recover: async () => {
      recoveries += 1;
      entered.resolve();
    }
  });
  await entered.promise;
  const secondAcquired = await second.drain(
    "router",
    oneItemWork(async () => {
      handled += 1;
    })
  );

  assert.equal(secondAcquired, false);
  release.resolve();
  assert.equal(await firstDrain, true);
  assert.equal(recoveries, 1);
  assert.equal(handled, 1);
  assert.deepEqual(await new Queue(locks).activeLocks(), []);
});

test(
  "stale takeover preserves a child tracked after its liveness probe",
  {
    skip: process.platform === "linux" || process.platform === "win32",
    timeout: 5000
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "guppi-child-race-"));
    const bin = join(root, "bin");
    const locks = join(root, "_locks");
    const router = join(locks, "router");
    const probeEntered = join(root, "probe-entered");
    const probeRelease = join(root, "probe-release");
    await mkdir(bin);
    await mkdir(router, { recursive: true });
    const owner = {
      version: 1,
      workerKey: "router",
      token: "tracked-child-race",
      owner: { pid: 999_999, startFingerprint: "dead" },
      child: null,
      acquiredAt: new Date(0).toISOString()
    };
    await writeFile(
      join(router, "owner.json"),
      `${JSON.stringify(owner, null, 2)}\n`,
      "utf8"
    );
    const ps = join(bin, "ps");
    await writeFile(
      ps,
      `#!/bin/sh
if [ "$2" = "999999" ]; then
  : > "$GUPPI_TEST_PROBE_ENTERED"
  while [ ! -f "$GUPPI_TEST_PROBE_RELEASE" ]; do
    sleep 0.01
  done
  exit 1
fi
exec /bin/ps "$@"
`,
      "utf8"
    );
    await chmod(ps, 0o755);

    const previous = {
      path: process.env.PATH,
      entered: process.env.GUPPI_TEST_PROBE_ENTERED,
      release: process.env.GUPPI_TEST_PROBE_RELEASE
    };
    process.env.PATH = `${bin}:${previous.path || ""}`;
    process.env.GUPPI_TEST_PROBE_ENTERED = probeEntered;
    process.env.GUPPI_TEST_PROBE_RELEASE = probeRelease;
    let drain: Promise<boolean> | undefined;
    try {
      let handled = 0;
      drain = new Queue(locks).drain(
        "router",
        oneItemWork(async () => {
          handled += 1;
        })
      );
      await waitForFile(probeEntered);
      const child = await identityFor(process.pid);
      await writeFile(
        join(router, "owner.json"),
        `${JSON.stringify({ ...owner, child }, null, 2)}\n`,
        "utf8"
      );
      await writeFile(probeRelease, "release\n", "utf8");

      assert.equal(await drain, false);
      assert.equal(handled, 0);
      const retained = JSON.parse(
        await readFile(join(router, "owner.json"), "utf8")
      ) as { token: string; child: { pid: number } | null };
      assert.equal(retained.token, owner.token);
      assert.equal(retained.child?.pid, process.pid);
    } finally {
      await writeFile(probeRelease, "release\n", "utf8");
      if (drain) await Promise.allSettled([drain]);
      restoreEnvironment("PATH", previous.path);
      restoreEnvironment("GUPPI_TEST_PROBE_ENTERED", previous.entered);
      restoreEnvironment("GUPPI_TEST_PROBE_RELEASE", previous.release);
    }
  }
);

test(
  "liveness probes do not block mutations or replace a newer owner",
  {
    skip: process.platform === "linux" || process.platform === "win32",
    timeout: 5000
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "guppi-probe-race-"));
    const bin = join(root, "bin");
    const locks = join(root, "_locks");
    const router = join(locks, "router");
    const probeOwner = join(root, "probe-owner");
    const probeEntered = join(root, "probe-entered");
    const probeRelease = join(root, "probe-release");
    await mkdir(bin);
    await mkdir(router, { recursive: true });
    await writeFile(
      join(router, "owner.json"),
      `${JSON.stringify({
        version: 1,
        workerKey: "router",
        token: "dead-owner",
        owner: { pid: 999_999, startFingerprint: "dead" },
        child: null,
        acquiredAt: new Date(0).toISOString()
      })}\n`,
      "utf8"
    );
    const ps = join(bin, "ps");
    await writeFile(
      ps,
      `#!/bin/sh
if [ "$2" = "999999" ]; then
  if mkdir "$GUPPI_TEST_PROBE_OWNER" 2>/dev/null; then
    : > "$GUPPI_TEST_PROBE_ENTERED"
    while [ ! -f "$GUPPI_TEST_PROBE_RELEASE" ]; do
      sleep 0.01
    done
  fi
  exit 1
fi
exec /bin/ps "$@"
`,
      "utf8"
    );
    await chmod(ps, 0o755);

    const previous = {
      path: process.env.PATH,
      owner: process.env.GUPPI_TEST_PROBE_OWNER,
      entered: process.env.GUPPI_TEST_PROBE_ENTERED,
      release: process.env.GUPPI_TEST_PROBE_RELEASE
    };
    process.env.PATH = `${bin}:${previous.path || ""}`;
    process.env.GUPPI_TEST_PROBE_OWNER = probeOwner;
    process.env.GUPPI_TEST_PROBE_ENTERED = probeEntered;
    process.env.GUPPI_TEST_PROBE_RELEASE = probeRelease;

    const first = new Queue(locks);
    const second = new Queue(locks);
    const secondEntered = deferred();
    const secondRelease = deferred();
    let firstHandled = 0;
    let firstDrain: Promise<boolean> | undefined;
    let secondDrain: Promise<boolean> | undefined;
    try {
      firstDrain = first.drain(
        "router",
        oneItemWork(async () => {
          firstHandled += 1;
        })
      );
      await waitForFile(probeEntered);

      let unrelatedRan = false;
      await within(
        new Queue(locks).exclusive("jobs", async () => {
          unrelatedRan = true;
        }),
        500,
        "unrelated mutation was blocked by the process probe"
      );
      assert.equal(unrelatedRan, true);

      secondDrain = second.drain(
        "router",
        oneItemWork(async () => {
          secondEntered.resolve();
          await secondRelease.promise;
        })
      );
      await within(
        secondEntered.promise,
        2000,
        "second drain did not replace the stale owner"
      );
      await writeFile(probeRelease, "release\n", "utf8");

      assert.equal(await firstDrain, false);
      assert.equal(firstHandled, 0);
      secondRelease.resolve();
      assert.equal(await secondDrain, true);
    } finally {
      await writeFile(probeRelease, "release\n", "utf8");
      secondRelease.resolve();
      await Promise.allSettled(
        [firstDrain, secondDrain].filter(
          (drain): drain is Promise<boolean> => drain !== undefined
        )
      );
      restoreEnvironment("PATH", previous.path);
      restoreEnvironment("GUPPI_TEST_PROBE_OWNER", previous.owner);
      restoreEnvironment("GUPPI_TEST_PROBE_ENTERED", previous.entered);
      restoreEnvironment("GUPPI_TEST_PROBE_RELEASE", previous.release);
    }
  }
);

test(
  "POSIX process fingerprints ignore ambient timezone",
  { skip: process.platform === "linux" || process.platform === "win32" },
  async () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const first = await fingerprintFor(process.pid);
      process.env.TZ = "America/Los_Angeles";
      const second = await fingerprintFor(process.pid);
      assert.equal(second, first);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  }
);

function oneItemWork(handle: () => Promise<void>): QueueWork<string> {
  let pending = true;
  return {
    recover: async () => {},
    next: async () => {
      if (!pending) return null;
      pending = false;
      return "job";
    },
    handle
  };
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`file was not created: ${path}`);
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
