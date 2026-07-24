---
name: plan
description: Use when planning a non-trivial Guppi change by researching current behavior, drafting a precise implementation proposal, and iterating with the review team in .agents/team.md before implementation.
---

# Planning Workflow

1. Research the provided topic, codebase subsystems, and relevant files until you have a deep understanding of the current behavior. Prefer local source, tests, subsystem `AGENTS.md` files, package manifests, CLI entrypoints, router/project handlers, registry schema or migrations, config loaders, markdown state helpers, Copilot runtime adapters, skill files, README sections, and existing call sites over assumptions.

1. Write a precise proposal for surgically introducing the requested change on top of current behavior. Include ownership boundaries, affected modules, CLI surface, routing flow, markdown state impact, registry metadata impact, session orchestration behavior, config defaults, validation strategy, autonomy and safety posture, and the assumptions or key decisions you have made or still need to make.

1. Write the initial plan to a markdown file in the session state, not into the repository unless the user explicitly asks for a repo file. Include at least:
   - Goal
   - Current Behavior
   - Proposed Design
   - State And Registry Impact
   - CLI And Interaction Impact
   - Implementation Sequence
   - Assumptions And Decisions
   - Validation Plan
   - Open Questions Or Follow-Up Debt

   Quality bar:
   - Separate design components from execution order.
   - Use milestones for substantial work, with a clear minimum valuable milestone when scope may be cut.
   - For each implementation step, briefly state: what changes, why now, self-critique/risk, and validation.
   - Every implementation phase must end with this gate: validate the owning entrypoints, invoke the `review` skill and applicable personas, then address blockers before declaring the phase complete.
   - Resolve owner, source-of-truth, and proof-surface decisions before designing helpers around them.
   - Include anti-goals when CLI-owned project meaning, session-owned durable state, duplicated registry and markdown truth, unbounded routing loops, unlogged autonomous research, or scope creep are realistic risks.
   - Consider opportunistic cleanup only when it is local to files or contracts the change already touches and makes the current or likely next change safer. Do not grow the plan just to tidy unrelated areas.
   - Validate behavior, not just structure: name the outcome or invariant that proves the change is correct. For behavior-preserving refactors, name the observable that proves behavior was preserved.

   Self-checks before review:
   - Every step is executable when reached: its inputs come from earlier steps, and no step depends on an artifact introduced later.
   - Pinned decisions state actual values, owners, modes, and defaults. "A canonical policy" is not actionable.
   - When a step preserves existing behavior, decide whether that behavior is intended or merely current and unverified, and route the unverified kind to Open Questions instead of silently canonizing it.
   - Open Questions name the alternatives you considered and deferred, not only unknowns.
   - Plans that touch `~/.guppi` state explain how tests isolate user data with a temporary Guppi home.
   - Plans that invoke Copilot explain how tests use a mocked runner unless live behavior is explicitly required.

1. Provide the plan file path and a concise summary. Do not create planning markdown in the repository unless the user requested that exact file or path.

1. Read `../../team.md`, choose the applicable reviewers, and spin up subagents for honest critique of the plan file. Run as many critique/revision rounds as needed until the plan has converged. The plan has converged when a round surfaces only cosmetic deltas or trivia, with no blockers and no new sequencing or source-of-truth questions. When that happens, stop: more planning is then worth less than executing the minimum valuable milestone.

   Watch the shape of the review loop. Keep iterating while reviews are producing material design improvements, clearer ownership, safer validation, or meaningful changes to the plan. If successive rounds mostly repeat the same concerns or trigger only small wording changes, use judgment, break out of the loop, and continue with the next planned step. Batch material fixes before re-reviewing.
