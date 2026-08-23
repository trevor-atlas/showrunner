---
name: plan-build
description: Plan, build, and ship a small, well-understood piece of work with Showrunner — the planner writes the plan, the builder implements it against the plan (matchesPlan gate), and the ship agent commits/PRs behind a human approval. Use when the work is small enough that a full test+review chain would be overhead.
---

# Showrunner: plan → build → ship

Run the Showrunner `plan_build` blueprint: planner writes a plan, builder implements it (the `matchesPlan` gate refuses work that does not reference the plan), and ship commits/PRs — pausing for **your approval** before any commit is made.

## Run

```bash
showrunner run plan_build --prompt "<the small, well-understood piece of work>"
```

The CLI takes a blueprint **module path**; `plan_build` is the starter-kit name and resolves to `src/starter-kit/blueprints/plan_build.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run src/starter-kit/blueprints/plan_build.ts --prompt "<the work>"
```

## Notes

- If the build cannot pass its gates, `on_fail` routes it back to the planner (bounded by the visit guard) instead of silently shipping a bad build.
- The ship phase pauses for approval (`require_approval`) — the run waits for you before committing; `showrunner approve <run_id>` continues it.
- Reach for `plan-build-test` instead when a test suite must pass, or `everything` when the work is real and its shape is not obvious.
