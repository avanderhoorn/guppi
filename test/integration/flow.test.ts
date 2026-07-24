import assert from "node:assert/strict";
import { spawn } from "child_process";
import { once } from "events";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile
} from "fs/promises";
import test from "node:test";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { AgentTurn, InvokeAgent } from "../../src/agent";
import { main } from "../../src/cli";
import {
  createConfig,
  loadRuntime
} from "../../src/config";
import { Jobs } from "../../src/jobs";
import { Orchestrator } from "../../src/orchestrator";
import { Projects } from "../../src/project";
import { identityFor } from "../../src/queue";
import { Router } from "../../src/router";

test("routes raw jobs into project state and reuses persistent sessions", async () => {
  const fixture = await createFixture(["Alpha", "Beta"]);
  await mkdir(join(fixture.guppiHome, "Gamma"), { recursive: true });
  const turns: AgentTurn[] = [];
  const invoke: InvokeAgent = async (turn) => {
    turns.push(turn);
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Beta",
        sourceRoot: join(fixture.projectsRoot, "Beta"),
        reason: "The model chose Beta from the supplied catalog.",
        question: null
      });
    }
    return completeProject(turn);
  };

  const firstRaw = "Capture the first release idea";
  const first = await execute(fixture.env, firstRaw, invoke, "Alpha");
  assert.equal(first.status, "done");
  assert.equal(first.route?.project, "Beta");
  assert.equal(
    (
      await execute(
        fixture.env,
        "Capture the second release idea",
        invoke,
        "Alpha"
      )
    ).status,
    "done"
  );

  const routerTurns = turns.filter((turn) => turn.profile === "router");
  const projectTurns = turns.filter((turn) => turn.profile === "project");
  assert.equal(routerTurns.length, 2);
  assert.equal(projectTurns.length, 2);
  assert.equal(routerTurns[0].session, "create");
  assert.equal(routerTurns[1].session, "resume");
  assert.equal(routerTurns[1].sessionId, routerTurns[0].sessionId);
  assert.equal(projectTurns[0].session, "create");
  assert.equal(projectTurns[1].session, "resume");
  assert.equal(projectTurns[1].sessionId, projectTurns[0].sessionId);

  const routerPrompt = JSON.parse(routerTurns[0].prompt) as {
    projectHint: string | null;
    priorAttemptError: string | null;
    projectsRoot: string;
    guppiRoot: string;
    routerMemoryPath: string;
    sourceProjects: Array<{ project: string; sourceRoot: string }>;
    guppiProjects: string[];
    catalog?: unknown;
  };
  const projectPrompt = JSON.parse(projectTurns[0].prompt) as {
    sourceRoot: string | null;
    sourceGit: unknown;
    projectDescription: string | null;
    guppiProjectRoot: string;
    isInteractive: boolean;
  };
  assert.equal(routerPrompt.projectHint, "Alpha");
  assert.equal(routerPrompt.priorAttemptError, null);
  assert.equal(routerPrompt.projectsRoot, fixture.projectsRoot);
  assert.equal(routerPrompt.guppiRoot, await realpath(fixture.guppiHome));
  assert.equal(routerPrompt.routerMemoryPath, "agents.md");
  assert.deepEqual(routerPrompt.sourceProjects, [
    {
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha")
    },
    {
      project: "Beta",
      sourceRoot: join(fixture.projectsRoot, "Beta")
    }
  ]);
  assert.deepEqual(routerPrompt.guppiProjects, ["Gamma"]);
  assert.equal(routerPrompt.catalog, undefined);
  assert.deepEqual(routerTurns[0].routerSourceRoots, [
    join(fixture.projectsRoot, "Alpha"),
    join(fixture.projectsRoot, "Beta")
  ]);
  assert.equal(
    projectPrompt.sourceRoot,
    await realpath(join(fixture.projectsRoot, "Beta"))
  );
  assert.equal(projectPrompt.sourceGit, null);
  assert.equal(projectPrompt.projectDescription, null);
  assert.equal(projectPrompt.guppiProjectRoot, projectTurns[0].cwd);
  assert.equal("projectMemory" in projectPrompt, false);
  assert.equal(projectPrompt.isInteractive, false);

  const jobs = await readJobs(fixture.guppiHome);
  assert.equal(jobs.length, 2);
  assert.ok(jobs.every((job) => job.status === "done"));
  const receipts = await readFile(
    join(fixture.guppiHome, "Beta", ".guppi-receipts"),
    "utf8"
  );
  for (const job of jobs) {
    assert.equal(receipts.split(job.id).length - 1, 1);
  }
  assert.equal(await countText(fixture.guppiHome, firstRaw), 1);
});

test("existing Guppi projects may select any supplied source relationship", async () => {
  const fixture = await createFixture(["Marketing Site", "website-redesign"]);
  await mkdir(join(fixture.guppiHome, "Marketing Site"), { recursive: true });
  const sourceRoot = join(fixture.projectsRoot, "website-redesign");
  const job = await execute(fixture.env, "Capture the launch checklist", async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Marketing Site",
        sourceRoot,
        reason: "The input links the durable project to the redesign source.",
        question: null
      });
    }
    return completeProject(turn);
  });

  assert.equal(job.status, "done");
  assert.equal(job.route?.project, "Marketing Site");
  assert.equal(job.route?.sourceRoot, sourceRoot);
});

test("accepts an explicit Guppi relationship across canonical catalog aliases", async () => {
  const fixture = await createFixture(["C++"]);
  await mkdir(join(fixture.guppiHome, "C#"), { recursive: true });
  const sourceRoot = join(fixture.projectsRoot, "C++");
  const job = await execute(fixture.env, "Capture the compiler notes", async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "C#",
        sourceRoot,
        reason: "The input explicitly relates the source to the durable project.",
        question: null
      });
    }
    return completeProject(turn);
  });

  assert.equal(job.status, "done");
  assert.equal(job.route?.project, "C#");
  assert.equal(job.route?.sourceRoot, sourceRoot);
});

test("rejects host inference across canonical catalog aliases", async () => {
  const fixture = await createFixture(["C++"]);
  await mkdir(join(fixture.guppiHome, "C#"), { recursive: true });
  let projectInvoked = false;
  const job = await execute(fixture.env, "Capture the compiler notes", async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    return JSON.stringify({
      project: "C++",
      sourceRoot: join(fixture.projectsRoot, "C++"),
      reason: "The model selected only the source catalog entry.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /identity is ambiguous across/);
  assert.equal(projectInvoked, false);
  assert.equal(job.route, null);
});

test("assigns strictly increasing FIFO times to sequential registrations", async () => {
  const fixture = await createFixture([]);
  const orchestrator = await Orchestrator.create(fixture.env, async () => "");
  const first = await orchestrator.register(submission("first"));
  const second = await orchestrator.register(submission("second"));

  assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));
  assert.deepEqual(
    (await readJobs(fixture.guppiHome)).map((job) => job.id),
    [first.id, second.id]
  );
});

test("rejects a sourceRoot that does not belong to the selected project", async () => {
  const fixture = await createFixture(["Alpha", "Beta"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Beta"),
      reason: "Invalid test route.",
      question: null
    });
  };
  const job = await execute(fixture.env, "message", invoke);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /sourceRoot does not belong/);
  assert.equal(projectInvoked, false);
  assert.equal(job.route, null);
});

test("rejects a router sourceRoot that was not supplied", async () => {
  const fixture = await createFixture(["Alpha"]);
  const outside = join(dirname(fixture.projectsRoot), "outside-source");
  await mkdir(outside);
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: outside,
      reason: "Invalid test route.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /sourceRoot was not supplied/);
  assert.equal(job.route, null);
});

test("rejects a new project that claims a supplied sourceRoot", async () => {
  const fixture = await createFixture(["Alpha"]);
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    return JSON.stringify({
      project: "New Project",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "Invalid test route.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /new project cannot claim/);
  assert.equal(job.route, null);
});

test(
  "revalidates router source roots before granting access",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture(["Alpha"]);
    const runtime = await loadRuntime(fixture.env);
    const projects = new Projects(
      runtime.paths,
      runtime.config.projectsRoot,
      async () => ""
    );
    const catalog = await projects.catalog();
    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await rename(sourceRoot, join(fixture.projectsRoot, "Alpha-original"));
    const outside = join(dirname(fixture.projectsRoot), "outside-router-source");
    await mkdir(outside);
    await symlink(outside, sourceRoot, "dir");
    const job = await new Jobs(runtime.paths).register(submission("message"));
    let invoked = false;
    const router = new Router(
      async () => {
        invoked = true;
        return "";
      },
      runtime.paths.routerMemory,
      runtime.paths.copilot
    );

    await assert.rejects(
      router.route(job, catalog),
      /sourceRoot is no longer a real directory/
    );
    assert.equal(invoked, false);
  }
);

test(
  "rejects a projectsRoot rebound before granting router access",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture(["Alpha"]);
    const runtime = await loadRuntime(fixture.env);
    const projects = new Projects(
      runtime.paths,
      runtime.config.projectsRoot,
      async () => ""
    );
    const catalog = await projects.catalog();
    const originalRoot = `${fixture.projectsRoot}-original`;
    await rename(fixture.projectsRoot, originalRoot);
    const outsideRoot = join(dirname(fixture.projectsRoot), "outside-projects-root");
    await mkdir(join(outsideRoot, "Alpha"), { recursive: true });
    await symlink(outsideRoot, fixture.projectsRoot, "dir");
    const job = await new Jobs(runtime.paths).register(submission("message"));
    let invoked = false;
    const router = new Router(
      async () => {
        invoked = true;
        return "";
      },
      runtime.paths.routerMemory,
      runtime.paths.copilot
    );

    await assert.rejects(
      router.route(job, catalog),
      /projectsRoot no longer resolves to its configured location/
    );
    assert.equal(invoked, false);
  }
);

test("rejects overlapping runtime roots before writing Guppi state", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-overlap-"));
  const projectsRoot = join(root, "Projects");
  const sourceRoot = join(projectsRoot, "Alpha");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "source.txt"), "source\n", "utf8");
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GUPPI_HOME: projectsRoot
  };

  await assert.rejects(
    createConfig(projectsRoot, env),
    /GUPPI_HOME must not overlap projectsRoot/
  );
  await assert.rejects(readFile(join(projectsRoot, "config.json"), "utf8"));
  await assert.rejects(readFile(join(projectsRoot, "agents.md"), "utf8"));
  await assert.rejects(readdir(join(projectsRoot, "_jobs")));
  await assert.rejects(readdir(join(projectsRoot, "_locks")));
});

test("rejects GUPPI_HOME nested inside a source before creating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "guppi-nested-home-"));
  const projectsRoot = join(root, "Projects");
  const guppiHome = join(projectsRoot, "Alpha", ".guppi");
  await mkdir(join(projectsRoot, "Alpha"), { recursive: true });

  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GUPPI_HOME: guppiHome
  };
  await assert.rejects(
    createConfig(projectsRoot, env),
    /GUPPI_HOME must not overlap projectsRoot/
  );
  await assert.rejects(readdir(guppiHome));
});

test(
  "rejects case aliases between missing runtime roots before writing",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "guppi-case-roots-"));
    const home = join(root, "home");
    await mkdir(home);
    const guppiHome = join(home, "projects");

    await assert.rejects(
      createConfig("~/Projects", {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        GUPPI_HOME: guppiHome
      }),
      /GUPPI_HOME must not overlap projectsRoot/
    );
    await assert.rejects(readdir(guppiHome), { code: "ENOENT" });
  }
);

test(
  "rejects project state symlinked into source",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture(["Alpha"]);
    await mkdir(fixture.guppiHome, { recursive: true });
    await symlink(
      join(fixture.projectsRoot, "Alpha"),
      join(fixture.guppiHome, "Alpha"),
      "dir"
    );
    let projectInvoked = false;
    const invoke: InvokeAgent = async (turn) => {
      if (turn.profile === "project") {
        projectInvoked = true;
        return "";
      }
      return routeTo(fixture, "Alpha");
    };
    const job = await execute(fixture.env, "message", invoke);
    assert.equal(job.status, "failed");
    assert.match(job.error || "", /project state escapes guppiRoot/);
    assert.equal(projectInvoked, false);
    await assert.rejects(
      readFile(join(fixture.projectsRoot, "Alpha", "agents.md"), "utf8")
    );
  }
);

test(
  "rejects new project state symlinked outside guppiRoot",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture([]);
    const outside = join(dirname(fixture.guppiHome), "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(fixture.guppiHome, { recursive: true });
    await symlink(outside, join(fixture.guppiHome, "New Project"), "dir");
    const invoke: InvokeAgent = async (turn) => {
      if (turn.profile === "project") return "";
      return JSON.stringify({
        project: "New Project",
        sourceRoot: null,
        reason: "The model chose a new project.",
        question: null
      });
    };

    const job = await execute(fixture.env, "message", invoke);
    assert.equal(job.status, "failed");
    assert.match(job.error || "", /project state escapes guppiRoot/);
    await assert.rejects(readFile(join(outside, "agents.md"), "utf8"));
  }
);

test(
  "rejects managed project files symlinked outside guppiRoot",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture(["Alpha"]);
    const outside = join(dirname(fixture.guppiHome), "outside-agents.md");
    await writeFile(outside, "outside\n", "utf8");
    const stateRoot = join(fixture.guppiHome, "Alpha");
    await mkdir(stateRoot, { recursive: true });
    await symlink(outside, join(stateRoot, "agents.md"), "file");

    const job = await execute(
      fixture.env,
      "message",
      completingProvider(fixture, [])
    );
    assert.equal(job.status, "failed");
    assert.match(job.error || "", /project memory cannot be a symbolic link/);
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  }
);

test(
  "rejects root operational directories symlinked outside guppiRoot",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture([]);
    const outside = join(dirname(fixture.guppiHome), "outside-jobs");
    await mkdir(outside, { recursive: true });
    await mkdir(fixture.guppiHome, { recursive: true });
    await symlink(outside, join(fixture.guppiHome, "_jobs"), "dir");

    await assert.rejects(
      Orchestrator.create(fixture.env),
      /Guppi jobs directory cannot be a symbolic link/
    );
    assert.deepEqual(await readdir(outside), []);
  }
);

test(
  "rejects a queued sourceRoot rebound to a symlink",
  { skip: process.platform === "win32" },
  async () => {
    const fixture = await createFixture(["Alpha"]);
    let projectInvoked = false;
    const invoke: InvokeAgent = async (turn) => {
      if (turn.profile === "router") return routeTo(fixture, "Alpha");
      projectInvoked = true;
      return "";
    };
    const orchestrator = await Orchestrator.create(fixture.env, invoke);
    const registered = await orchestrator.register(submission("message"));
    assert.equal((await orchestrator.route(registered.id)).status, "queued-project");

    const sourceRoot = join(fixture.projectsRoot, "Alpha");
    await rename(sourceRoot, join(fixture.projectsRoot, "Alpha-original"));
    const outside = join(dirname(fixture.projectsRoot), "outside-source");
    await mkdir(outside, { recursive: true });
    await symlink(outside, sourceRoot, "dir");

    const job = await orchestrator.drive(registered.id);
    assert.equal(job.status, "failed");
    assert.match(job.error || "", /sourceRoot is no longer a real directory/);
    assert.equal(projectInvoked, false);
    await assert.rejects(readdir(join(fixture.guppiHome, "Alpha")));
  }
);

test("accepts one fenced router JSON object", async () => {
  const fixture = await createFixture(["Alpha"]);
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      return `\`\`\`json\n${routeTo(fixture, "Alpha")}\n\`\`\``;
    }
    return completeProject(turn);
  };

  const job = await execute(fixture.env, "message", invoke);
  assert.equal(job.status, "done");
});

test("rejects router prose wrapped around otherwise valid JSON", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    return `Route follows:\n${routeTo(fixture, "Alpha")}`;
  };

  const job = await execute(fixture.env, "message", invoke);
  assert.equal(job.status, "failed");
  assert.equal(projectInvoked, false);
  assert.equal(job.attempts.router, 3);
});

test("rejects router writes outside staged agents.md", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    await writeFile(join(turn.cwd, "notes.md"), "unexpected\n", "utf8");
    return routeTo(fixture, "Alpha");
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /router wrote outside agents\.md/);
  assert.equal(projectInvoked, false);
});

test("requires and publishes a summary for a newly selected source", async () => {
  const fixture = await createFixture(["Alpha"]);
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    "# Router Working Memory\n\n",
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      sourceSummary("Alpha"),
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "done");
  assert.match(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    /- Source project: Alpha/
  );
});

test("accepts equivalent Markdown bullets and spacing for a source summary", async () => {
  const fixture = await createFixture(["Alpha"]);
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    "# Router Working Memory\n\n",
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      "## Source Project Summaries   \n\n* Source project:  Alpha  \n - observedAt: 2026-01-01T00:00:00.000Z\n + Summary: Test fixture source project.\n",
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "done");
});

test("keeps an existing selected-source summary without rewriting it", async () => {
  const fixture = await createFixture(["Alpha"]);
  const original = await readFile(
    join(fixture.guppiHome, "agents.md"),
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "done");
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("rejects a selected source when its summary is missing", async () => {
  const fixture = await createFixture(["Alpha"]);
  const original = "# Router Working Memory\n\n";
  await writeFile(join(fixture.guppiHome, "agents.md"), original, "utf8");
  let projectInvoked = false;
  const priorErrors: Array<string | null> = [];
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    priorErrors.push(
      (
        JSON.parse(turn.prompt) as {
          priorAttemptError: string | null;
        }
      ).priorAttemptError
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.equal(job.attempts.router, 3);
  assert.match(job.error || "", /did not record a source summary for Alpha/);
  assert.deepEqual(priorErrors, [
    null,
    "router did not record a source summary for Alpha",
    "router did not record a source summary for Alpha"
  ]);
  assert.equal(projectInvoked, false);
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("rejects duplicate summaries for the selected source", async () => {
  const fixture = await createFixture(["Alpha"]);
  const original = "# Router Working Memory\n\n";
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    original,
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      `${sourceSummary("Alpha")}\n${sourceSummary("Alpha")}`,
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /duplicates the source summary for Alpha/);
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("allows the router to repair duplicate selected-source summaries", async () => {
  const fixture = await createFixture(["Alpha"]);
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    `# Router Working Memory\n\n${sourceSummary("Alpha")}\n${sourceSummary("Alpha")}`,
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await writeFile(join(turn.cwd, "agents.md"), routerMemory(["Alpha"]), "utf8");
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "done");
  assert.equal(
    (
      await readFile(join(fixture.guppiHome, "agents.md"), "utf8")
    ).split("- Source project: Alpha").length - 1,
    1
  );
});

test("rejects an incomplete selected-source summary", async () => {
  const fixture = await createFixture(["Alpha"]);
  const original = "# Router Working Memory\n\n";
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    original,
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      "## Source Project Summaries\n\n- Source project: Alpha\n  - observedAt: 2026-01-01T00:00:00.000Z\n  - Summary:   \n",
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /did not record a source summary for Alpha/);
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("ignores source summaries inside comments and fences", async () => {
  const fixture = await createFixture(["Alpha"]);
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    "# Router Working Memory\n\n",
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    const summary = sourceSummary("Alpha");
    await appendFile(
      join(turn.cwd, "agents.md"),
      `\`\`\`markdown\n${summary}\`\`\`\n\n<!--\n${summary}-->\n`,
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /did not record a source summary for Alpha/);
});

test("ignores source-summary examples nested beneath another heading", async () => {
  const fixture = await createFixture(["Alpha"]);
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    "# Router Working Memory\n\n",
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      "## Source Project Summaries\n\n### Example\n\n- Source project: Alpha\n  - observedAt: 2026-01-01T00:00:00.000Z\n  - Summary: Example only.\n",
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Alpha"),
      reason: "The model chose Alpha.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /did not record a source summary for Alpha/);
});

test("requires the selected source name for cross-name routes", async () => {
  const fixture = await createFixture(["website-redesign"]);
  await mkdir(join(fixture.guppiHome, "Marketing Site"), { recursive: true });
  const original = "# Router Working Memory\n\n";
  await writeFile(
    join(fixture.guppiHome, "agents.md"),
    original,
    "utf8"
  );
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      sourceSummary("Marketing Site"),
      "utf8"
    );
    return JSON.stringify({
      project: "Marketing Site",
      sourceRoot: join(fixture.projectsRoot, "website-redesign"),
      reason: "The input connects the durable and source projects.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(
    job.error || "",
    /did not record a source summary for website-redesign/
  );
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("does not publish router learning from an invalid route", async () => {
  const fixture = await createFixture(["Alpha", "Beta"]);
  const original = "# Router Working Memory\n\n";
  await writeFile(join(fixture.guppiHome, "agents.md"), original, "utf8");
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      sourceSummary("Beta"),
      "utf8"
    );
    return JSON.stringify({
      project: "Alpha",
      sourceRoot: join(fixture.projectsRoot, "Beta"),
      reason: "Invalid source relationship.",
      question: null
    });
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /sourceRoot does not belong/);
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("does not publish router learning from a failed provider turn", async () => {
  const fixture = await createFixture(["Alpha"]);
  const original = "# Router Working Memory\n\n";
  await writeFile(join(fixture.guppiHome, "agents.md"), original, "utf8");
  const job = await execute(fixture.env, "message", async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    await appendFile(
      join(turn.cwd, "agents.md"),
      sourceSummary("Alpha"),
      "utf8"
    );
    throw new Error("provider teardown failed");
  });

  assert.equal(job.status, "failed");
  assert.match(job.error || "", /provider teardown failed/);
  assert.equal(
    await readFile(join(fixture.guppiHome, "agents.md"), "utf8"),
    original
  );
});

test("rejects model-authored lifecycle receipts in agents.md", async () => {
  const fixture = await createFixture(["Alpha"]);
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      return JSON.stringify({
        project: "Alpha",
        sourceRoot: join(fixture.projectsRoot, "Alpha"),
        reason: "The model chose Alpha.",
        question: null
      });
    }
    await appendFile(
      join(turn.cwd, "agents.md"),
      "## Processed Jobs\n\n- 2026-01-01T00-00-00.000Z-00000000\n",
      "utf8"
    );
    await writeFile(
      join(turn.cwd, ".guppi-commit-message"),
      "Incorporate project job\n",
      "utf8"
    );
    return "";
  };
  const job = await execute(fixture.env, "message", invoke);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /cannot contain processed-job receipts/);
});

test("registers before a missing Copilot executable fails", async () => {
  const fixture = await createFixture(["Alpha"]);
  const raw = "Persist this before provider failure";
  const stderr: string[] = [];
  const env = { ...fixture.env, PATH: "/usr/bin:/bin" };

  assert.equal(await main([raw], io([], stderr), env), 1);
  assert.match(stderr.join(""), /spawn copilot ENOENT/);

  const [job] = await readJobs(fixture.guppiHome);
  assert.equal(job.status, "failed");
  assert.equal(job.input.raw, raw);
  assert.equal(job.route, null);
  const sessions = JSON.parse(
    await readFile(join(fixture.guppiHome, "sessions.json"), "utf8")
  ) as { sessions: Record<string, string> };
  assert.deepEqual(Object.keys(sessions.sessions), ["router"]);
  await assert.rejects(readdir(join(fixture.guppiHome, "Alpha")), {
    code: "ENOENT"
  });
});

test("canonicalizes pending new projects before their shared project drain", async () => {
  const fixture = await createFixture([]);
  const turns: AgentTurn[] = [];
  let routerCall = 0;
  const invoke: InvokeAgent = async (turn) => {
    turns.push(turn);
    if (turn.profile === "router") {
      routerCall += 1;
      return JSON.stringify({
        project: routerCall === 1 ? "New Project" : "New-Project",
        sourceRoot: null,
        reason: "The model chose a new project.",
        question: null
      });
    }
    return completeProject(turn);
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const first = await orchestrator.register(submission("first"));
  await orchestrator.register(submission("second"));

  assert.equal((await orchestrator.drive(first.id)).status, "done");
  await orchestrator.wake();
  const jobs = await readJobs(fixture.guppiHome);
  assert.deepEqual(
    jobs.map((job) => job.route?.project),
    ["New Project", "New Project"]
  );
  const projectTurns = turns.filter((turn) => turn.profile === "project");
  assert.equal(projectTurns.length, 2);
  assert.equal(projectTurns[1].session, "resume");
  assert.equal(projectTurns[1].sessionId, projectTurns[0].sessionId);
});

test("rejects duplicate host-owned project receipts", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    projectInvoked = true;
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register(submission("message"));
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, ".guppi-receipts"),
    `v1\n${registered.id}\n${registered.id}\n`,
    "utf8"
  );

  const job = await orchestrator.drive(registered.id);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /duplicate job ID/);
  assert.equal(projectInvoked, false);
});

test("rejects ambiguous legacy receipt sections", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    projectInvoked = true;
    return completeProject(turn);
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register(submission("message"));
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\n\n## Processed Jobs\n\n\`\`\`\n- ${registered.id}\n\`\`\`\n\n<!--\n- ${registered.id}\n-->\n`,
    "utf8"
  );

  const job = await orchestrator.drive(registered.id);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /ambiguous comments or fenced content/);
  assert.equal(projectInvoked, false);
});

test("skips an already processed project job", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    projectInvoked = true;
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register(submission("message"));
  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\n\n## Processed Jobs\n\n- ${registered.id}\n`,
    "utf8"
  );

  assert.equal((await orchestrator.drive(registered.id)).status, "done");
  assert.equal(projectInvoked, false);
  assert.equal(
    await readFile(join(projectRoot, ".guppi-receipts"), "utf8"),
    `v1\n${registered.id}\n`
  );
  assert.doesNotMatch(
    await readFile(join(projectRoot, "agents.md"), "utf8"),
    /Processed Jobs/
  );
});

test("redacts raw input from persisted errors", async () => {
  const fixture = await createFixture(["Alpha"]);
  const raw = "do not duplicate this raw message";
  const invoke: InvokeAgent = async () => {
    throw new Error(`provider echoed: ${raw}`);
  };

  const job = await execute(fixture.env, raw, invoke);
  assert.equal(job.status, "failed");
  assert.doesNotMatch(job.error || "", new RegExp(raw));
  assert.equal(await countText(fixture.guppiHome, raw), 1);
});

test("keeps and reuses the project session when provider teardown fails", async () => {
  const fixture = await createFixture(["Alpha"]);
  const projectTurns: AgentTurn[] = [];
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    projectTurns.push(turn);
    await incorporate(turn);
    if (projectTurns.length === 1) {
      throw new Error("provider teardown failed after durable output");
    }
    return "";
  };

  assert.equal((await execute(fixture.env, "first", invoke)).status, "done");
  assert.equal((await execute(fixture.env, "second", invoke)).status, "done");
  assert.equal(projectTurns.length, 2);
  assert.equal(projectTurns[0].session, "create");
  assert.equal(projectTurns[1].session, "resume");
  assert.equal(projectTurns[1].sessionId, projectTurns[0].sessionId);
  const sessions = JSON.parse(
    await readFile(join(fixture.guppiHome, "sessions.json"), "utf8")
  ) as { sessions: Record<string, string> };
  assert.equal(sessions.sessions["project:alpha"], projectTurns[0].sessionId);
});

test("rejects control characters in a project name", async () => {
  const fixture = await createFixture([]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "project") {
      projectInvoked = true;
      return "";
    }
    const prompt = JSON.parse(turn.prompt) as { jobId: string };
    return JSON.stringify({
      project: `Bad\n## Processed Jobs\n- ${prompt.jobId}`,
      sourceRoot: null,
      reason: "Invalid project name.",
      question: null
    });
  };

  const job = await execute(fixture.env, "message", invoke);
  assert.equal(job.status, "failed");
  assert.equal(projectInvoked, false);
});

test("targeted routing stops before a later router turn", async () => {
  const fixture = await createFixture(["Alpha"]);
  let laterStarted = false;
  let releaseLater!: () => void;
  const laterGate = new Promise<void>((resolvePromise) => {
    releaseLater = resolvePromise;
  });
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "project") return completeProject(turn);
    const prompt = JSON.parse(turn.prompt) as { rawInput: string };
    if (prompt.rawInput === "later") {
      laterStarted = true;
      await laterGate;
    }
    return routeTo(fixture, "Alpha");
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const first = await orchestrator.register(submission("first"));
  await delay(2);
  const later = await orchestrator.register(submission("later"));
  const routing = orchestrator.route(first.id);

  try {
    const routed = await Promise.race([
      routing,
      delay(500).then(() => {
        throw new Error("targeted routing did not return");
      })
    ]);
    assert.equal(routed.status, "queued-project");
    assert.equal(laterStarted, false);
    assert.equal(
      (await orchestrator.status(later.id) as { status: string }).status,
      "queued-router"
    );
  } finally {
    releaseLater();
    await routing;
  }

  await orchestrator.wake();
  assert.equal(
    (await orchestrator.status(later.id) as { status: string }).status,
    "done"
  );
});

test("fails a poison router job after three attempts and advances FIFO", async () => {
  const fixture = await createFixture(["Alpha"]);
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      const prompt = JSON.parse(turn.prompt) as { rawInput: string };
      if (prompt.rawInput === "poison router") {
        throw new Error("router poison");
      }
      return routeTo(fixture, "Alpha");
    }
    return completeProject(turn);
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const poison = await orchestrator.register(submission("poison router"));
  const healthy = await orchestrator.register(submission("healthy"));

  assert.equal((await orchestrator.drive(healthy.id)).status, "done");
  await orchestrator.wake();
  const jobs = await readJobs(fixture.guppiHome);
  const failed = jobs.find((job) => job.id === poison.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempts.router, 3);
  assert.match(failed?.error || "", /router poison/);
});

test("rejects unmanaged project output without publishing it", async () => {
  const fixture = await createFixture(["Alpha"]);
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    await writeFile(join(turn.cwd, ".mcp.json"), "{}\n", "utf8");
    await incorporate(turn);
    return "";
  };

  const job = await execute(fixture.env, "unsafe project output", invoke);
  assert.equal(job.status, "failed");
  assert.equal(job.attempts.project, 3);
  assert.match(job.error || "", /unmanaged path: \.mcp\.json/);
  await assert.rejects(
    readFile(join(fixture.guppiHome, "Alpha", ".mcp.json"), "utf8"),
    { code: "ENOENT" }
  );
  assert.doesNotMatch(
    await readFile(join(fixture.guppiHome, "Alpha", "project.md"), "utf8"),
    /Incorporated job/
  );
});

test("rejects a model-authored host receipt file", async () => {
  const fixture = await createFixture(["Alpha"]);
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    await writeFile(join(turn.cwd, ".guppi-receipts"), "v1\n", "utf8");
    await incorporate(turn);
    return "";
  };

  const job = await execute(fixture.env, "forge receipt", invoke);
  assert.equal(job.status, "failed");
  assert.match(job.error || "", /unmanaged path: \.guppi-receipts/);
  assert.equal(
    await readFile(join(fixture.guppiHome, "Alpha", ".guppi-receipts"), "utf8"),
    "v1\n"
  );
});

test("fails a poison project job after three attempts and advances FIFO", async () => {
  const fixture = await createFixture(["Alpha"]);
  const poisonTurns: AgentTurn[] = [];
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    const prompt = JSON.parse(turn.prompt) as {
      rawInput: string;
    };
    if (prompt.rawInput === "poison project") {
      poisonTurns.push(turn);
      throw new Error("project poison");
    }
    return completeProject(turn);
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const poison = await orchestrator.register(submission("poison project"));
  const healthy = await orchestrator.register(submission("healthy"));

  assert.equal((await orchestrator.drive(healthy.id)).status, "done");
  const jobs = await readJobs(fixture.guppiHome);
  const failed = jobs.find((job) => job.id === poison.id);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.attempts.project, 3);
  assert.match(failed?.error || "", /project poison/);
  assert.equal(poisonTurns.length, 3);
  assert.equal(poisonTurns[0].session, "create");
  assert.ok(poisonTurns.slice(1).every((turn) => turn.session === "resume"));
  assert.ok(
    poisonTurns.every((turn) => turn.sessionId === poisonTurns[0].sessionId)
  );
});

test("background work waits for a live interactive owner", async () => {
  const fixture = await createFixture(["Alpha"]);
  const turns: AgentTurn[] = [];
  const invoke = completingProvider(fixture, turns);
  const runtime = await loadRuntime(fixture.env);
  const jobs = new Jobs(runtime.paths);
  const sleeper = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore" }
  );
  assert.ok(sleeper.pid);

  try {
    const interactive = await jobs.register(
      {
        raw: "interactive work",
        mode: "interactive",
        projectHint: null,
        cwd: "/original/cwd"
      },
      await identityFor(sleeper.pid)
    );
    await delay(2);
    const standard = await jobs.register(submission("standard work"));
    const orchestrator = await Orchestrator.create(fixture.env, invoke);

    await orchestrator.wake();
    assert.equal((await jobs.read(interactive.id)).status, "queued-project");
    assert.equal((await jobs.read(standard.id)).status, "queued-project");
    assert.equal(
      turns.some((turn) => turn.profile === "project"),
      false
    );

    const exited = once(sleeper, "exit");
    sleeper.kill("SIGTERM");
    await exited;
    await orchestrator.wake();
    assert.equal((await jobs.read(interactive.id)).status, "failed");
    assert.equal((await jobs.read(standard.id)).status, "done");
  } finally {
    if (sleeper.exitCode === null && sleeper.signalCode === null) {
      const exited = once(sleeper, "exit");
      sleeper.kill("SIGTERM");
      await exited;
    }
  }
});

test("interactive drive leaves unrelated projects for the wake worker", async () => {
  const fixture = await createFixture(["Alpha", "Beta"]);
  let betaStarted = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      const prompt = JSON.parse(turn.prompt) as { rawInput: string };
      return routeTo(
        fixture,
        prompt.rawInput.includes("beta") ? "Beta" : "Alpha"
      );
    }
    const prompt = JSON.parse(turn.prompt) as { rawInput: string };
    if (prompt.rawInput.includes("beta")) betaStarted = true;
    return completeProject(turn);
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const interactive = await orchestrator.register({
    raw: "alpha interactive",
    mode: "interactive",
    projectHint: null,
    cwd: "/original/cwd"
  });
  await delay(2);
  const beta = await orchestrator.register(submission("beta standard"));

  assert.equal((await orchestrator.drive(interactive.id)).status, "done");
  assert.equal(betaStarted, false);
  assert.equal(
    (await orchestrator.status(beta.id) as { status: string }).status,
    "queued-router"
  );

  await orchestrator.wake();
  assert.equal(betaStarted, true);
  assert.equal((await orchestrator.status(beta.id) as { status: string }).status, "done");
});

test("dead active interactive work fails and later FIFO work advances", async () => {
  const fixture = await createFixture(["Alpha"]);
  const runtime = await loadRuntime(fixture.env);
  const jobs = new Jobs(runtime.paths);
  const interactive = await jobs.register(
    {
      raw: "interactive work",
      mode: "interactive",
      projectHint: null,
      cwd: "/original/cwd"
    },
    { pid: 999_999, startFingerprint: "dead" }
  );
  const standard = await jobs.register(submission("standard work"));
  const orchestrator = await Orchestrator.create(
    fixture.env,
    completingProvider(fixture, [])
  );
  await orchestrator.route(interactive.id);
  await orchestrator.route(standard.id);
  await jobs.working(interactive.id);

  const lock = join(fixture.guppiHome, "_locks", "project-alpha");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({
      version: 1,
      workerKey: "project:alpha",
      token: "dead-interactive",
      owner: { pid: 999_999, startFingerprint: "dead" },
      child: null,
      acquiredAt: new Date(0).toISOString()
    })}\n`,
    "utf8"
  );

  await orchestrator.wake();
  assert.equal((await jobs.read(interactive.id)).status, "failed");
  assert.match(
    (await jobs.read(interactive.id)).error || "",
    /project owner exited/
  );
  assert.equal((await jobs.read(standard.id)).status, "done");
});

test("recovers one active router job from a dead owner", async () => {
  const fixture = await createFixture(["Alpha"]);
  const orchestrator = await Orchestrator.create(
    fixture.env,
    completingProvider(fixture, [])
  );
  const registered = await orchestrator.register(submission("recover me"));
  const jobPath = join(
    fixture.guppiHome,
    "_jobs",
    `${registered.id}.json`
  );
  const active = JSON.parse(await readFile(jobPath, "utf8"));
  active.status = "routing";
  active.attempts.router = 1;
  await writeFile(jobPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");

  const lock = join(fixture.guppiHome, "_locks", "router");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
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

  assert.equal((await orchestrator.drive(registered.id)).status, "done");
  const [job] = await readJobs(fixture.guppiHome);
  assert.equal(job.attempts.router, 2);
});

test("durable project completion wins during dead-owner recovery", async () => {
  const fixture = await createFixture(["Alpha"]);
  let projectInvoked = false;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    projectInvoked = true;
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const registered = await orchestrator.register(submission("recover marker"));
  assert.equal((await orchestrator.route(registered.id)).status, "queued-project");

  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\n\n## Processed Jobs\n\n- ${registered.id}\n`,
    "utf8"
  );

  const jobPath = join(
    fixture.guppiHome,
    "_jobs",
    `${registered.id}.json`
  );
  const active = JSON.parse(await readFile(jobPath, "utf8"));
  active.status = "working";
  active.attempts.project = 3;
  await writeFile(jobPath, `${JSON.stringify(active, null, 2)}\n`, "utf8");

  const lock = join(fixture.guppiHome, "_locks", "project-alpha");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({
      version: 1,
      workerKey: "project:alpha",
      token: "dead-owner",
      owner: { pid: 999_999, startFingerprint: "dead" },
      child: null,
      acquiredAt: new Date(0).toISOString()
    })}\n`,
    "utf8"
  );

  assert.equal((await orchestrator.drive(registered.id)).status, "done");
  assert.equal(projectInvoked, false);
});

test("corrupt legacy receipts fail later FIFO work until state is repaired", async () => {
  const fixture = await createFixture(["Alpha"]);
  const orchestrator = await Orchestrator.create(
    fixture.env,
    completingProvider(fixture, [])
  );
  const broken = await orchestrator.register(submission("broken marker"));
  const healthy = await orchestrator.register(submission("healthy"));
  await orchestrator.route(healthy.id);

  const projectRoot = join(fixture.guppiHome, "Alpha");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "agents.md"),
    `# Alpha Agent Working Memory\n\n## Processed Jobs\n\n- ${broken.id}\n- ${broken.id}\n`,
    "utf8"
  );

  const runtime = await loadRuntime(fixture.env);
  const jobs = new Jobs(runtime.paths);
  await jobs.working(broken.id);
  const lock = join(fixture.guppiHome, "_locks", "project-alpha");
  await mkdir(lock, { recursive: true });
  await writeFile(
    join(lock, "owner.json"),
    `${JSON.stringify({
      version: 1,
      workerKey: "project:alpha",
      token: "dead-invalid-marker",
      owner: { pid: 999_999, startFingerprint: "dead" },
      child: null,
      acquiredAt: new Date(0).toISOString()
    })}\n`,
    "utf8"
  );

  await orchestrator.wake();
  assert.equal((await jobs.read(broken.id)).status, "failed");
  assert.equal((await jobs.read(broken.id)).attempts.project, 3);
  assert.equal((await jobs.read(healthy.id)).status, "failed");
  assert.equal((await jobs.read(healthy.id)).attempts.project, 3);
});

test("preserves concurrent project sessions under one atomic session cache", async () => {
  const fixture = await createFixture(["Alpha", "Beta"]);
  let activeProjects = 0;
  let maximumProjects = 0;
  const invoke: InvokeAgent = async (turn) => {
    if (turn.profile === "router") {
      const prompt = JSON.parse(turn.prompt) as { rawInput: string };
      return routeTo(
        fixture,
        prompt.rawInput.includes("beta") ? "Beta" : "Alpha"
      );
    }
    activeProjects += 1;
    maximumProjects = Math.max(maximumProjects, activeProjects);
    await delay(300);
    await incorporate(turn);
    activeProjects -= 1;
    return "";
  };
  const orchestrator = await Orchestrator.create(fixture.env, invoke);
  const alpha = await orchestrator.register(submission("alpha work"));
  const beta = await orchestrator.register(submission("beta work"));

  await orchestrator.route(alpha.id);
  await orchestrator.route(beta.id);
  await orchestrator.wake();
  assert.equal(
    (await orchestrator.status(alpha.id) as { status: string }).status,
    "done"
  );
  assert.equal(maximumProjects, 2);

  const sessions = JSON.parse(
    await readFile(join(fixture.guppiHome, "sessions.json"), "utf8")
  ) as { sessions: Record<string, string> };
  assert.deepEqual(
    Object.keys(sessions.sessions).sort(),
    ["project:alpha", "project:beta", "router"]
  );
});

async function incorporate(turn: AgentTurn): Promise<void> {
  const prompt = projectPrompt(turn);
  await appendFile(
    join(turn.cwd, "project.md"),
    `- Incorporated job ${prompt.jobId}\n`,
    "utf8"
  );
  await writeFile(
    join(turn.cwd, ".guppi-commit-message"),
    `Incorporate project job\n`,
    "utf8"
  );
}

async function createFixture(projects: string[]) {
  const root = await mkdtemp(join(tmpdir(), "guppi-flow-"));
  const home = join(root, "home");
  const projectsRoot = join(home, "Projects");
  const guppiHome = join(home, ".guppi");
  await mkdir(projectsRoot, { recursive: true });
  for (const project of projects) {
    await mkdir(join(projectsRoot, project), { recursive: true });
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GUPPI_HOME: guppiHome
  };
  await createConfig(projectsRoot, env);
  await writeFile(
    join(guppiHome, "agents.md"),
    routerMemory(projects),
    "utf8"
  );
  return {
    projectsRoot: await realpath(projectsRoot),
    guppiHome,
    env
  };
}

async function execute(
  env: NodeJS.ProcessEnv,
  raw: string,
  invoke: InvokeAgent,
  projectHint: string | null = null
) {
  const orchestrator = await Orchestrator.create(env, invoke);
  const job = await orchestrator.register({
    raw,
    mode: "standard",
    projectHint,
    cwd: "/original/cwd"
  });
  return orchestrator.drive(job.id);
}

function io(stdout: string[], stderr: string[] = []) {
  return {
    stdout: (message: string) => stdout.push(message),
    stderr: (message: string) => stderr.push(message)
  };
}

async function readJobs(guppiHome: string): Promise<Array<{
  id: string;
  status: string;
  input: { raw: string };
  route: { project: string | null } | null;
  attempts: { router: number; project: number };
  error: string | null;
}>> {
  const jobsDir = join(guppiHome, "_jobs");
  const files = (await readdir(jobsDir)).filter((file) => file.endsWith(".json"));
  return Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(join(jobsDir, file), "utf8"))
    )
  );
}

function submission(raw: string) {
  return {
    raw,
    mode: "standard" as const,
    projectHint: null,
    cwd: "/original/cwd"
  };
}

function routerMemory(projects: string[]): string {
  if (projects.length === 0) return "# Router Working Memory\n\n";
  return [
    "# Router Working Memory",
    "",
    "## Source Project Summaries",
    "",
    ...projects.flatMap((project) => [
      `- Source project: ${project}`,
      "  - observedAt: 2026-01-01T00:00:00.000Z",
      "  - Summary: Test fixture source project.",
      ""
    ])
  ].join("\n");
}

function sourceSummary(project: string): string {
  return [
    "## Source Project Summaries",
    "",
    `- Source project: ${project}`,
    "  - observedAt: 2026-01-01T00:00:00.000Z",
    "  - Summary: Test fixture source project.",
    ""
  ].join("\n");
}

function routeTo(
  fixture: { projectsRoot: string },
  project: string
): string {
  return JSON.stringify({
    project,
    sourceRoot: join(fixture.projectsRoot, project),
    reason: `The model chose ${project}.`,
    question: null
  });
}

function completingProvider(
  fixture: { projectsRoot: string },
  turns: AgentTurn[]
): InvokeAgent {
  return async (turn) => {
    turns.push(turn);
    if (turn.profile === "router") return routeTo(fixture, "Alpha");
    return completeProject(turn);
  };
}

async function completeProject(turn: AgentTurn): Promise<string> {
  await incorporate(turn);
  return "";
}

function projectPrompt(turn: AgentTurn): {
  jobId: string;
  rawInput: string;
} {
  return JSON.parse(turn.prompt) as {
    jobId: string;
    rawInput: string;
  };
}

async function countText(path: string, text: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      count += await countText(child, text);
      continue;
    }
    const contents = await readFile(child, "utf8");
    count += contents.split(text).length - 1;
  }
  return count;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
