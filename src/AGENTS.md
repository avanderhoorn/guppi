# Guppi Runtime

Guppi preserves one raw thought as a durable job and turns it into compact
project markdown through persistent router and project sessions. Read the
runtime in that order. Host code owns persistence, queue progression, session
cache, cross-process ownership, and path or response validation. Skills and
models own routing judgment, research, planning, and curation.

## Design Notes

- **The call path stays linear across process lifetimes.** One-shot `cli.ts`
  intake registers once, then asks `Orchestrator` to route, drive, or wake
  existing work. The attached service registers each accepted request and
  schedules that job's `drive()` in-process. Detached `__worker` processes,
  service work, and foreground interactive work use the same object graph and
  queue drains.
- **Models decide meaning.** TypeScript supplies raw input, memory, configured
  roots, separate source and Guppi catalogs, and paths, then validates authority
  boundaries. It must not choose a project, score evidence, classify work,
  decide when to research, or synthesize plans.
- **Installed skills govern every provider turn.** Packaged `.agents` assets are
  copied into `<guppiRoot>/.agents` on first initialization. Each bootstrap
  requires the profile's installed primary skill before any other action.
- **One job file owns raw input.** `_jobs/<jobId>.json` is the only
  Guppi-managed durable copy. Project markdown may reference the job ID but must
  not copy the raw message.
- **Worker identity joins draining and sessions.** The router and project owners
  each define one worker key. The same key selects FIFO jobs, owns one filesystem
  lock, and reuses one session.
- **One persistent project turn owns the routed job.** It works from a disposable
  project-state snapshot and receives the exact matched source project when one
  exists. The skill decides whether the user's raw input calls for inspection,
  curation, planning, or source action.
- **Guppi publishes disposable workspaces, not model-selected state.** Router and
  project turns work from host-created snapshots under `_copilot/`. The host
  validates those snapshots and publishes only router memory or managed project
  Markdown. Project turns run with `--yolo`, so their filesystem authority is
  intentionally broader than the publication boundary. Router turns instead use
  an explicit read-tool set and one path-scoped write grant.
- **Project completion is durable evidence.** A project turn completes only
  when the model writes one valid commit subject, then the host publishes state,
  records the job in `.guppi-receipts`, and commits both. Only a current `HEAD`
  containing the exact receipt and exact `Guppi-Job` trailer can authorize
  `done`. The one-time strict legacy fallback may prove a paired receipt from
  `HEAD:agents.md` only when that commit predates `.guppi-receipts`; migration
  removes it from working state and the next checkpoint commits the new file.
  Project `agents.md` remains instructions-only.

## State Contract

1. Durable project meaning lives in `project.md`, `archive.md`, `research/`,
   `plans/`, and project `agents.md`.
2. Root `agents.md` is reusable router working memory.
3. Raw input and job lifecycle live only in `_jobs/`.
4. Session IDs, lock directories, the schema-free lock mutation database,
   isolated Copilot state, disposable workspaces, per-project `.git/` history,
   `.guppi-receipts`, and host-written safety settings are operational or audit
   state. They are not project memory or job lifecycle truth.
5. `$GUPPI_HOME/config.json` owns consumed runtime preferences.
   `projectsRoot` is required after first-run setup; optional `guppiRoot`
   selects the durable and operational state root and defaults to
   `GUPPI_HOME`.

## Orchestration Contract

1. Registration and execution stay separate so detached workers or the attached
   service can drive an existing job without creating another one. Registration
   uses the same short lock primitive to assign strictly increasing FIFO
   timestamps.
2. `Queue` supplies the same recover, select, and handle drain for the router and
   every project. A short built-in SQLite transaction serializes only canonical
   lock directory changes. Model work never runs inside that transaction.
   Targeted waits release the lock as soon as their requested job leaves the
   current stage; `wake()` owns backlog draining.
3. `--project` is router context, not a host-selected destination.
4. Non-interactive router and project turns retry at most three times. One
   failed job then becomes terminal so later FIFO work can advance. Router
   retries receive the host-sanitized prior error so the persistent session can
   correct an actionable staged-file/response failure or rerun cleanly after
   owner-exit recovery.
5. The agent invocation callback receives a host-assigned session ID and
   create-or-resume intent. Guppi atomically reserves the worker's stable ID
   before provider work, so retries keep it even when Copilot fails during
   teardown.
6. One-shot async starts a detached worker after registration. Standard routes
   in the foreground, then starts one for project work. Interactive owns the
   router and selected project FIFOs in the terminal, but leaves unrelated
   project queues for the worker it starts afterward. Service requests use async
   job semantics but schedule `drive(jobId)` in the attached service instead of
   launching one worker per request.
7. A detached worker acknowledges startup before its parent reports success. It
   drives the requested job, then best-effort drains every pending router and
   project worker. The service returns `202` only after registration, drives
   each accepted job through targeted waits, requests one best-effort wake after
   that drive settles, and requests another after listener startup.
8. Interactive ownership uses a PID plus process-start fingerprint. A live
   foreign owner blocks the project FIFO, while a dead owner fails visibly and
   is never replayed headlessly.
9. A tracked launch-gate process keeps the worker lock live before Copilot
   starts. If the Guppi owner disappears, the gate stops its Copilot child before
   stale recovery can replay the turn.
10. Visible CLI commands prompt for `projectsRoot` only when `config.json` is
    absent. Setup completes before registration, worker launch, or opening the
    service listener. Non-TTY first runs fail visibly, and hidden workers never
    prompt.
11. The canonical project worker lock covers Git initialization, dirty-state
    checkpointing, the project turn, publication, final commit, and completion
    recovery. Mutating Git children use the same tracked launch gate as Copilot
    so stale recovery cannot race an orphaned commit.
12. `Orchestrator` alone changes job lifecycle. It marks a project job done only
    after normal incorporation or explicit completion recovery verifies the
    paired current commit.
13. `service.ts` is a transport owner only. It accepts bounded loopback JSON,
    constructs the existing async `Submission` field-by-field, calls
    `register()`, and schedules `drive(jobId)`. It never reads or mutates job
    files, locks, sessions, router memory, project state, or Git directly.

## Safety Contract

1. Router turns bootstrap the installed `router` skill, receive configured
   roots, separate source and Guppi catalogs, and read tools for exact source
   roots revalidated immediately before invocation. The skill instructs them to
   inspect source read-only and update only the supplied disposable
   `routerMemoryPath`; they must not inspect or edit durable root `agents.md`,
   and the host publishes only the staged file. Router turns do not use `--yolo`;
   their available-tool filter and scoped write permission enforce the
   staged-file boundary.
2. Project turns run from a disposable project-state snapshot. When a
   `sourceRoot` exists, the host revalidates that it remains a real direct child
   of canonical `projectsRoot`, supplies that exact path, and reports bounded
   read-only Git facts only when that path is itself the worktree root. The skill
   owns whether the raw input authorizes source inspection, edits, or commands
   and must distinguish checkout, local-ref, and dirty-worktree evidence.
   `--yolo` disables Copilot path confirmation, so this is a contract boundary
   rather than an operating-system restriction.
3. Project turns may research the web and delegate focused work. They read
   staged Guppi state from their disposable workspace; their installed skill may
   separately read optional artifact templates relative to its own base
   directory. Router turns use a separate installed skill. The host rejects
   unmanaged Guppi-state output and publishes only `agents.md`, `project.md`,
   `archive.md`, and Markdown beneath `research/` and `plans/`.
4. The project model emits one trimmed commit subject through the disposable
   `.guppi-commit-message` file but never owns Git. The host validates the
   subject, writes the host-owned `.guppi-receipts` entry, commits only managed
   Guppi paths, appends the job trailer, and never targets the matched source
   repository.
5. Project Git commands use a fixed environment, exact direct repository and
   common-directory checks, disabled hooks/signing/maintenance, controlled
   staging, and tracked mutation children. Unsafe Git metadata or redirection
   fails visibly.
6. Canonical `GUPPI_HOME` and `projectsRoot` must be disjoint before setup
   writes config. A custom `guppiRoot` must be disjoint from both, and must be
   equal to or disjoint from `GUPPI_HOME`. Root symlinks and dangling symlink
   components are rejected before runtime writes.
7. Canonical project state must not overlap its `sourceRoot` or the configured
   `projectsRoot` layout. Reject equality, ancestry, and symlink overlap before
   initializing state, including for new projects without a source match.
8. Each project root must remain a real child of canonical `guppiRoot`.
   Project roots and managed memory, journal, archive, research, and plan paths
   must not be symbolic links.
9. Copilot uses an isolated host-owned `_copilot/` home instead of ambient user
   plugins or MCP configuration. Before every launch, the host atomically
   rewrites global and workspace settings with hooks disabled. Children also
   ignore ambient capability grants, custom instruction paths, provider
   overrides, Node injection, and content-capturing telemetry, including
   mixed-case environment aliases on Windows. The `skill` tool is the deliberate
   exception: each profile explicitly exposes it and supplies its installed
   primary skill directory through `COPILOT_SKILLS_DIRS`. Native discovery is
   additive, so Copilot may also expose user or built-in skills; the bootstrap
   requires the Guppi primary skill first.
10. The attached HTTP service listens only on `127.0.0.1`. Tailscale Serve may
   publish it externally, but Tailscale configuration and admission policy are
   operator-owned. Every reachable caller has the same authority as trusted
   async raw input and can request source or external effects under the project
   skill contract. The service must not log request bodies, trust forwarded
   identity headers, or be described as safe for untrusted webhook content.

## Known Limitations

Guppi installs no daemon. Detached workers are responsible one-shot processes,
and `guppi service` is an explicitly attached process. If an unrelated worker
is killed after startup acknowledgement but before it takes a queue lock,
pending work waits for a later command or service request to wake it. Stopping
the service immediately stops intake and its process; tracked launch gates stop
active children when possible, but cannot roll back partial filesystem or
external effects. Project Copilot turns run with `--yolo`, so tools, paths, and
URLs are auto-approved and shell commands are not an operating-system sandbox.
Project artifact publication is merge-only, so removing an old research or plan
file requires a later explicit host capability if real use demonstrates that
need. Changing `guppiRoot` selects a different state directory; Guppi does not
migrate existing state. Project Git history is local mutable audit data, not a
tamper-proof ledger, and Guppi does not push or rewrite it.

## Subsystem Map

- `cli.ts` owns Commander parsing, visible mode behavior, hidden worker startup,
  startup acknowledgement, and terminal output.
- `service.ts` owns loopback HTTP parsing, bounded validation, responses,
  listener lifecycle, and scheduling attached job progression.
- `orchestrator.ts` owns composition, registration, router draining, and project
  draining.
- `router.ts` owns the router prompt, worker key, and strict route authority
  validation, selected-source summary postcondition, and staged router-memory
  publication.
- `project.ts` owns separate source and Guppi catalog discovery, project
  identity, source-root authority, state paths, the project prompt, disposable
  state snapshots, approved Markdown publication, source handoff, Git lifecycle
  decisions, and completion validation.
- `agent.ts` owns native-skill bootstrap, concurrency-safe session reuse,
  Copilot profiles, environment hardening, isolated Copilot state, and tracked
  child execution.
- `git.ts` owns fixed-environment Git invocation, exact direct-repository
  validation, managed staging, checkpoints, commits, current-HEAD reads, and
  bounded read-only source-worktree facts.
- `process.ts` owns the reusable launch-gate process lifecycle used by Copilot
  and mutating Git commands.
- `jobs.ts` owns the job schema, raw input, monotonic FIFO selection, and status
  changes.
- `queue.ts` owns worker locks, process identity, stale recovery, waiting, and
  the shared drain loop.
- `config.ts` owns the stable `$GUPPI_HOME/config.json` bootstrap, resolved
  `projectsRoot` and `guppiRoot`, filesystem comparisons, first-run installation
  of packaged `.agents`, and first-writer-wins config creation.
