import assert from "node:assert/strict";
import {
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
import {
  createConfig,
  loadRuntime,
  MissingConfigError
} from "../../src/config";

test("missing config creates no runtime state", async () => {
  const fixture = await createFixture();

  await assert.rejects(loadRuntime(fixture.env), MissingConfigError);
  await assert.rejects(readdir(fixture.configHome), { code: "ENOENT" });
});

test("first-run config creation is exclusive and creates no runtime state", async () => {
  const fixture = await createFixture();
  const first = join(fixture.home, "First");
  const second = join(fixture.home, "Second");

  await Promise.all([
    createConfig(first, fixture.env),
    createConfig(second, fixture.env)
  ]);

  const stored = JSON.parse(
    await readFile(join(fixture.configHome, "config.json"), "utf8")
  ) as { projectsRoot: string };
  assert.ok(stored.projectsRoot === first || stored.projectsRoot === second);
  assert.deepEqual(await readdir(fixture.configHome), ["config.json"]);
});

test("relative first-run input is persisted as an absolute path", async () => {
  const fixture = await createFixture();

  await createConfig("Repositories", fixture.env, fixture.home);

  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.configHome, "config.json"), "utf8")),
    {
      version: 1,
      projectsRoot: join(fixture.home, "Repositories")
    }
  );
});

test("custom guppiRoot relocates all initialized runtime paths", async () => {
  const fixture = await createFixture();
  await writeConfig(fixture, {
    version: 1,
    projectsRoot: fixture.projectsRoot,
    guppiRoot: fixture.guppiRoot
  });

  const [runtime] = await Promise.all([
    loadRuntime(fixture.env),
    loadRuntime(fixture.env)
  ]);
  assert.equal(runtime.config.guppiRoot, await realpath(fixture.guppiRoot));
  assert.equal(runtime.paths.guppiRoot, await realpath(fixture.guppiRoot));
  assert.equal(
    runtime.paths.config,
    join(await realpath(fixture.configHome), "config.json")
  );
  assert.deepEqual(await readdir(fixture.configHome), ["config.json"]);
  assert.deepEqual((await readdir(fixture.guppiRoot)).sort(), [
    ".agents",
    "_copilot",
    "_jobs",
    "_locks",
    "agents.md"
  ]);
  const skills = join(fixture.guppiRoot, ".agents", "skills");
  assert.equal(runtime.paths.skills, await realpath(skills));
  assert.deepEqual((await readdir(skills)).sort(), [
    "plan",
    "project",
    "research",
    "review",
    "router"
  ]);
  assert.match(
    await readFile(join(skills, "router", "SKILL.md"), "utf8"),
    /name: router/
  );
  assert.match(
    await readFile(join(skills, "project", "SKILL.md"), "utf8"),
    /name: project/
  );
  assert.match(
    await readFile(join(skills, "plan", "SKILL.md"), "utf8"),
    /name: plan/
  );
  assert.match(
    await readFile(join(skills, "research", "SKILL.md"), "utf8"),
    /name: research/
  );
  assert.match(
    await readFile(join(skills, "review", "SKILL.md"), "utf8"),
    /name: review/
  );
  assert.match(
    await readFile(join(fixture.guppiRoot, ".agents", "team.md"), "utf8"),
    /# Review Team/
  );
});

test("manual config roots must be absolute or home-relative", async () => {
  const fixture = await createFixture();
  await writeConfig(fixture, {
    version: 1,
    projectsRoot: "Projects"
  });

  await assert.rejects(
    loadRuntime(fixture.env),
    /projectsRoot must be absolute or start with ~\//
  );
  assert.deepEqual(await readdir(fixture.configHome), ["config.json"]);
});

test("custom guppiRoot simply uses the configured directory", async () => {
  const fixture = await createFixture();
  await writeConfig(fixture, {
    version: 1,
    projectsRoot: fixture.projectsRoot,
    guppiRoot: fixture.guppiRoot
  });
  await writeFile(
    join(fixture.configHome, "agents.md"),
    "# Previous Default State\n",
    "utf8"
  );
  await mkdir(fixture.guppiRoot, { recursive: true });
  await writeFile(
    join(fixture.guppiRoot, "notes.txt"),
    "existing contents\n",
    "utf8"
  );

  const runtime = await loadRuntime(fixture.env);
  assert.equal(runtime.paths.guppiRoot, await realpath(fixture.guppiRoot));
  assert.equal(
    await readFile(join(fixture.configHome, "agents.md"), "utf8"),
    "# Previous Default State\n"
  );
  assert.deepEqual((await readdir(fixture.guppiRoot)).sort(), [
    ".agents",
    "_copilot",
    "_jobs",
    "_locks",
    "agents.md",
    "notes.txt"
  ]);
});

test("custom guppiRoot must not overlap projectsRoot", async () => {
  const fixture = await createFixture();
  await writeConfig(fixture, {
    version: 1,
    projectsRoot: fixture.projectsRoot,
    guppiRoot: fixture.projectsRoot
  });

  await assert.rejects(
    loadRuntime(fixture.env),
    /guppiRoot must not overlap projectsRoot/
  );
});

test(
  "bootstrap and custom roots cannot be symbolic links",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture();
    const configTarget = join(fixture.home, "config-target");
    await mkdir(configTarget, { recursive: true });
    await symlink(configTarget, fixture.configHome);

    await assert.rejects(
      loadRuntime(fixture.env),
      /Guppi config home cannot be a symbolic link/
    );

    const second = await createFixture();
    const stateTarget = join(second.home, "state-target");
    await mkdir(stateTarget, { recursive: true });
    await symlink(stateTarget, second.guppiRoot);
    await writeConfig(second, {
      version: 1,
      projectsRoot: second.projectsRoot,
      guppiRoot: second.guppiRoot
    });
    await assert.rejects(
      loadRuntime(second.env),
      /guppiRoot cannot be a symbolic link/
    );

    const third = await createFixture();
    const projectsLink = join(third.home, "ProjectsLink");
    await mkdir(third.home, { recursive: true });
    await symlink(third.guppiRoot, projectsLink);
    await writeConfig(third, {
      version: 1,
      projectsRoot: projectsLink,
      guppiRoot: third.guppiRoot
    });
    await assert.rejects(
      loadRuntime(third.env),
      /projectsRoot cannot be a symbolic link/
    );
    await assert.rejects(readdir(third.guppiRoot), { code: "ENOENT" });

    const fourth = await createFixture();
    const projectsParent = join(fourth.home, "ProjectsParent");
    await mkdir(fourth.home, { recursive: true });
    await symlink(fourth.guppiRoot, projectsParent);
    await writeConfig(fourth, {
      version: 1,
      projectsRoot: join(projectsParent, "Projects"),
      guppiRoot: fourth.guppiRoot
    });
    await assert.rejects(
      loadRuntime(fourth.env),
      /projectsRoot cannot contain dangling symbolic links/
    );
    await assert.rejects(readdir(fourth.guppiRoot), { code: "ENOENT" });
  }
);

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "guppi-config-"));
  const home = join(root, "home");
  return {
    home,
    configHome: join(home, ".guppi"),
    projectsRoot: join(home, "Projects"),
    guppiRoot: join(home, "guppi-state"),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      GUPPI_HOME: join(home, ".guppi")
    }
  };
}

async function writeConfig(
  fixture: Fixture,
  config: {
    version: 1;
    projectsRoot: string;
    guppiRoot?: string;
  }
): Promise<void> {
  await mkdir(fixture.configHome, { recursive: true });
  await writeFile(
    join(fixture.configHome, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
}
