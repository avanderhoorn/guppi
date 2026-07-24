# Aggregate Template

```md
# <Aggregate Subsystem Name>

<Intro: aggregate value first, then the central role/vocabulary that makes the child subsystem relationships legible.>

## Design Notes

- **<First central aggregate contract>.** <Explain the aggregate-level value, orchestration, or boundary.>
- **<Next learning-path concept>.** <Explain how child subsystems interact without restating their leaf-level implementation details.>
- **<Another distinct concept if needed>.** <Keep only notes that earn their place at aggregate altitude.>

## Change Playbooks

| Change | Route | Prove |
|---|---|---|
| <Repeated change type this aggregate owns> | <Canonical owner or reference, not a duplicated procedure.> | <Validation, review, or safety evidence.> |

## State Contract

<Only when this aggregate owns durable markdown, registry metadata, config defaults, migrations, or audit logs. State what is source of truth and what must stay derived or operational.>

## Orchestration Contract

<Only when this aggregate owns routing, queues, locks, retries, Copilot session resume/recreate behavior, background mode, or interactive attach. Preserve exact loop and failure rules.>

## Safety Contract

<Only when this aggregate owns automatic research, user interruption, plan-then-ask execution, filesystem mutations, terminal execution, or other autonomy boundaries. Preserve exact safety rules.>

## Subsystem Map

- `<main-entry-file>` owns ...
- [`child-a/`](child-a/AGENTS.md) owns ...
- [`child-b/`](child-b/AGENTS.md) owns ...
- `<shared-folder>` owns ...
```

Add `Change Playbooks`, `State Contract`, `Orchestration Contract`, `Safety Contract`, `Carve-out Contract`, or `Known Limitations` only when the standards say the guide has an exceptional reason.
