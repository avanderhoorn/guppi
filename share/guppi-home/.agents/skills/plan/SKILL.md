---
name: plan
description: Use when planning a non-trivial project change by researching current behavior, drafting a precise implementation proposal, and iterating with the review team before implementation.
---

# Planning Workflow

1. Research the provided topic, relevant project areas, and nearby conventions
   until you understand the current behavior. Prefer local source, tests,
   `AGENTS.md` files, package manifests, entrypoints, handlers, schemas or
   migrations, config loaders, state helpers, runtime adapters, skill files,
   documentation, and representative call sites when they exist.

1. Write a precise proposal for surgically introducing the requested change on
   top of current behavior. Cover ownership boundaries, affected modules,
   user-facing surfaces, runtime and data flow, state or persistence impact,
   config defaults, validation strategy, autonomy and safety posture, and any
   assumptions or decisions that remain open.

1. Write the initial plan to the location owned by the current project
   workflow. Prefer an existing plan directory, template, or session artifact
   convention. Do not add planning files to a source repository unless the user
   or project conventions explicitly require it.

   Follow an existing project plan template when one is available. Otherwise
   include at least:
   - Goal
   - Current Context
   - Proposed Design
   - State And Data Impact
   - User-Facing Impact
   - Implementation Sequence
   - Assumptions And Decisions
   - Dependencies And Blockers
   - Risks, Mitigations, And Alternatives
   - Validation Or Done Criteria
   - Open Questions Or Follow-Up Debt

   Quality bar:
   - Separate design components from execution order.
   - Use milestones for substantial work, with a clear minimum valuable
     milestone when scope may be cut.
   - For each implementation step, state what changes, why it happens then,
     the main risk or self-critique, and how that step will be validated.
   - End every implementation phase by validating the owning entrypoints,
     invoking the `review` skill, and addressing blockers before
     declaring the phase complete.
   - Resolve ownership, source-of-truth, authorization, and proof-surface
     decisions before designing helpers around them.
   - Include anti-goals when duplicated truth, durable state hidden in
     ephemeral sessions, unbounded automation, unlogged external research,
     authorization drift, or scope creep are realistic risks.
   - Include opportunistic cleanup only when it is local to touched files or
     contracts and makes the current change safer. Do not grow the plan merely
     to tidy unrelated areas.
   - Validate behavior, not just structure. Name the observable outcome or
     invariant that proves the change is correct.

   Self-checks before review:
   - Every step is executable when reached, with inputs supplied by earlier
     steps rather than later artifacts.
   - Pinned decisions state actual values, owners, modes, and defaults.
   - When preserving existing behavior, distinguish intended behavior from
     behavior that is merely current and unverified. Record the unverified kind
     in Open Questions instead of silently canonizing it.
   - Open questions name the alternatives considered and deferred.
   - Plans that touch user or project state explain how tests isolate real data
     with temporary locations.
   - Plans that invoke external agents or services explain how tests use a
     mocked runner or client unless live behavior is explicitly required.

1. Provide the plan file path and a concise summary. Do not create planning
   files in a source repository unless the user requested that location.

1. Read `../../team.md`, choose the applicable reviewers, and spin up subagents
   for honest critique of the plan. Run as many critique and revision rounds as
   needed until the plan has converged. A plan has converged when a review round
   surfaces only cosmetic changes or trivia, with no blockers and no new
   sequencing, ownership, or source-of-truth questions.

   Keep iterating while reviews produce material design improvements, clearer
   ownership, safer validation, or meaningful sequencing changes. Stop when
   rounds mostly repeat prior concerns or produce only local wording churn.
   Batch material fixes before re-reviewing.
