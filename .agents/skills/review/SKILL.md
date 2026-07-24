---
name: review
description: Use when reviewing implemented Guppi changes after the fact, especially to assess correctness, state ownership, routing safety, session orchestration, autonomy boundaries, validation value, documentation contracts, and remaining design debt with help from the review team in .agents/team.md. Must be used after implementing any phase from a Guppi plan before declaring the phase complete.
---

# Review Workflow

1. Inspect the working tree, changed files, and relevant diffs to understand the implementation. Read the owning subsystem `AGENTS.md` files, nearby source, package manifests, CLI entrypoints, router/project handlers, registry schema or migrations, config loaders, markdown state helpers, Copilot runtime adapters, skill files, docs, tests, and representative call sites needed to judge the change in context.

1. Build a concise mental model of the intended behavior and actual implementation. Identify affected owners, CLI inputs and outputs, routing envelopes, fuzzy project hint behavior, markdown artifacts, registry metadata, session resume/attach paths, queue and lock behavior, validation evidence, autonomy boundaries, and any assumptions the implementation appears to make.

1. Read `../../team.md`, choose the applicable reviewers, and spin up subagents for independent critique. Ask them to focus on blockers, follow-up debt, what landed well, and concrete suggestions. Recursive delegation is allowed, but only for distinct uncovered review questions that would change the current review conclusion.

   Keep a short review ledger before launching or relaunching reviewers:
   - Active or completed review lanes: persona, scope, and question.
   - Known findings: one-line blocker or debt summaries only.
   - Open questions not yet covered by an active or completed lane.
   - Explicit exclusions for the next child reviewer.

   Give each child reviewer a review contract: the one question it owns, the files or surfaces it should inspect, the lanes it must not revisit, and the condition that would change the parent conclusion. Do not launch a child whose scope substantially overlaps an active or completed lane unless the prompt names the exact delta being checked.

   If you are already running as a subagent, prefer doing the narrow re-check yourself. Launch another subagent only when the child owns a narrower, distinct question that you cannot answer directly and the prompt excludes nearby lanes already covered by siblings or ancestors.

   Keep an eye on the review loop itself. Continue reviewing while each round is producing improvements. If rounds mostly repeat prior findings or lead only to small wording/local churn, use judgment, break out, and continue with the next validation or commit step. If it makes sense, try batching material fixes before asking for another review.

1. Run or recommend validation appropriate to the risk: focused package tests, build/type checks, generated-current checks, web smoke paths, or live checks only when credentials and runtime context allow it. Do not treat validation as a substitute for review.

1. Consider "leave it better" opportunities only inside the touched area: stale comments, misleading docs, duplicated owner facts, brittle tests, or validation holes that directly affect the current change. Report them when they reduce drift or make future changes safer. Do not turn adjacent cleanup into a larger redesign.

1. Report findings first, ordered by severity and grounded in file/function references. Separate blockers from follow-up debt, call out test or validation gaps, and summarize what landed well only after the issues. Do not edit files unless the user explicitly asks you to address the findings.
