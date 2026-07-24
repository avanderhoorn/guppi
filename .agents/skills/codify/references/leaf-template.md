# Leaf Template

```md
# <Leaf Subsystem Name>

<Intro: concrete value first, then the owned model/vocabulary that makes the subsystem legible.>

## Design Notes

- **<First central model or contract>.** <Explain the value, mechanism, and consequence.>
- **<Next learning-path concept>.** <Explain the next meaningful behavior, boundary, risk, or tradeoff.>
- **<Another distinct concept if needed>.** <Keep only notes that earn their place.>

## Change Playbooks

| Change | Route | Prove |
|---|---|---|
| <Repeated change type this leaf owns> | <Canonical owner or reference, not a duplicated procedure.> | <Validation, review, or safety evidence.> |

## State Contract

<Only when this leaf owns durable markdown, registry metadata, config defaults, migrations, or audit logs. State what is source of truth and what must stay derived or operational.>

## Orchestration Contract

<Only when this leaf owns routing, queues, locks, retries, Copilot session resume/recreate behavior, background mode, or interactive attach. Preserve exact loop and failure rules.>

## Safety Contract

<Only when this leaf owns automatic research, user interruption, plan-then-ask execution, filesystem mutations, terminal execution, or other autonomy boundaries. Preserve exact safety rules.>

## Subsystem Map

- `<primary-entry-or-folder>` owns ...
- `<supporting-folder>` owns ...
- `<shared-contract-file>` owns ...
```

Add `Change Playbooks`, `State Contract`, `Orchestration Contract`, `Safety Contract`, `Carve-out Contract`, or `Known Limitations` only when the standards say the guide has an exceptional reason.
