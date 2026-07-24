# Guppi AGENTS.md Reference

Guppi guides document a small personal state-management runtime. They should
route contributors to the owner of CLI intake, durable jobs, queue ownership,
persistent agent sessions, router judgment, project curation, markdown state,
config, and behavioral proof without becoming runbooks.

## Guppi altitude

- **Aggregate guides route work.** Root and `src/` guides explain the linear
  product flow and point to the owner. They do not repeat implementation tours.
- **Leaf guides teach local invariants.** Add one only when a focused subsystem
  has rules that are not obvious from the aggregate guide, source, tests, or
  skills.
- **State, orchestration, and judgment stay separate.** Durable project meaning
  belongs in markdown. Raw input and job lifecycle belong in job files. Session
  IDs and locks are operational. Skills and models own semantic judgment.
- **Provenance stays compact.** Project state references a job ID instead of
  copying raw input. The host-owned receipt and paired Git trailer prove
  incorporation.

## Optional Guppi sections

Use optional sections only when they prevent a likely wrong change.

- **Change Playbooks** route repeated edits to their owner and proof surface.
- **State Contract** preserves exact raw-input, markdown, config, job, and
  session-cache boundaries.
- **Orchestration Contract** preserves queue keys, drain behavior, failure
  visibility, session reuse, background work, and interactive ownership.
- **Safety Contract** preserves exact source authority, staged project-state
  publication, and the boundary between inspection and explicitly requested
  source action.
- **Known Limitations** explains deliberate scaffold gaps that might otherwise
  look accidental.

## Canonical routing

When `src/AGENTS.md` exists, treat it as the repository's canonical runtime
owner map. Other guides should link or route to that map instead of copying its
file inventory. Guppi guidance should still preserve these axes:

- host mechanics versus model judgment
- durable markdown versus job and session metadata
- router choice versus project curation
- current in-process behavior versus planned concurrency or provider controls

## Contract shapes

Use numbered rules for exact state or orchestration invariants. Prefer compact
change tables for repeated edit paths. Keep commands and procedures in one owner
instead of copying them between guides.

## Review gates

Before finishing a guide change:

1. Run a source contradiction pass against owner files and nearest child guides.
2. Remove repeated state, routing, autonomy, and validation facts.
3. Challenge every optional section by naming the wrong change it prevents.
4. Confirm every local guide link resolves.
