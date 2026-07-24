---
name: review
description: Use after implementing a meaningful project change to assess correctness, ownership, safety, validation, documentation, and remaining design debt with help from the shared review team.
---

# Review Workflow

1. Inspect the changed artifacts, working tree or change set, and relevant diffs
   to understand the implementation. Read the owning `AGENTS.md` files, nearby
   source, package manifests, entrypoints, handlers, schemas or migrations,
   config loaders, state helpers, runtime adapters, skills, documentation,
   tests, and representative call sites when they are relevant.

1. Build a concise mental model of the intended behavior and actual
   implementation. Identify affected owners, user-facing inputs and outputs,
   state and data flow, persistence, runtime or session behavior, concurrency
   and recovery, external effects, validation evidence, autonomy boundaries,
   and assumptions the implementation appears to make.

1. Read `../../team.md`, choose the applicable reviewers, and spin up subagents
   for independent critique. Ask them to focus on blockers, follow-up debt, what
   landed well, and concrete suggestions. Recursive delegation is appropriate
   only for distinct uncovered questions that could change the review
   conclusion.

   Keep a short review ledger before launching or relaunching reviewers:
   - Active or completed review lanes: persona, scope, and question.
   - Known findings: one-line blocker or debt summaries only.
   - Open questions not yet covered by an active or completed lane.
   - Explicit exclusions for the next child reviewer.

   Give each child reviewer a review contract: the one question it owns, the
   files or surfaces it should inspect, the lanes it must not revisit, and the
   condition that would change the parent conclusion. Do not launch a child
   whose scope substantially overlaps an active or completed lane unless the
   prompt names the exact delta being checked.

   If you are already running as a subagent, prefer doing a narrow re-check
   yourself. Launch another subagent only when it owns a distinct question you
   cannot answer directly and its prompt excludes nearby completed lanes.

   Continue reviewing while each round produces material improvements. If
   rounds mostly repeat prior findings or lead only to wording churn, stop and
   continue with the next validation or delivery step. Batch material fixes
   before asking for another review.

1. Run or recommend validation appropriate to the risk: focused tests,
   build or type checks, generated-artifact freshness checks,
   public-entrypoint smoke checks, or live checks only when credentials and
   runtime context allow it. Do not treat validation as a substitute for
   review.

1. Consider "leave it better" opportunities only inside the touched area:
   stale comments, misleading docs, duplicated owner facts, brittle tests, or
   validation holes that directly affect the current change. Report them when
   they reduce drift or make future changes safer. Do not turn adjacent cleanup
   into a larger redesign.

1. Report findings first, ordered by severity and grounded in file or function
   references. Separate blockers from follow-up debt, call out test or
   validation gaps, and summarize what landed well only after the issues. Do
   not edit files unless the user explicitly asks you to address the findings.
