---
name: plan-build-test
description: The standard Showrunner chain — plan, build, gate (tests + typecheck), review, ship. Planner writes the plan, builder implements it against the plan (matchesPlan + testsPass + lintClean gates), reviewer approves it (reviewApproved, rejected work loops back to the builder), and ship commits/PRs behind a human approval. Use for ordinary feature work that should be planned, green, reviewed, and shipped.
---

# Showrunner: the standard chain

Run the Showrunner `plan_build_test` blueprint: **plan → build → gate(test, lint) → review → ship** (PLAN §14's `plan_build_test`).

- **plan** — planner writes the plan document (envelope must carry `plan_path`).
- **build** — builder implements it; gates: `matchesPlan` (must reference the plan), `testsPass`, `lintClean`. Budget exhaustion routes back to the planner.
- **review** — reviewer must approve (`reviewApproved`); a rejected review routes back to the builder (bounded revise loop).
- **ship** — commits/PRs behind **your approval** (`require_approval`).

## Run

```bash
showrunner run plan_build_test --prompt "<the feature to plan, build, test, review, and ship>"
```

The CLI takes a blueprint **module path**; `plan_build_test` is the starter-kit name and resolves to `packages/starter-kit/src/blueprints/plan_build_test.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run packages/starter-kit/src/blueprints/plan_build_test.ts --prompt "<the feature>"
```

## Notes

- Gate commands are the replaceable defaults (`bun test`, `bunx tsc --noEmit`) — override them in the blueprint.
- The run pauses twice for you: at the ship approval (and only there, unless you add more `require_approval`). `showrunner approve <run_id>` continues it.
- Use `everything` when the work is real and its shape is not obvious (adds a human approval on the plan itself and heavier budgets).
