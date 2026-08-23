---
name: everything
description: "The full Showrunner chain for real work whose shape is not obvious — plan (with human approval before building), build, test, review, ship. Like plan-build-test but heavier: the plan itself is approved by a human first, budgets are larger, and the run pauses before committing. Use when the work is real, the shape is not obvious, and you want every gate plus a human checkpoint before anything ships."
---

# Showrunner: everything

Run the Showrunner `everything` blueprint: **plan → (human approval) → build → test → review → ship** (PLAN §14's `everything`).

- **plan** — planner writes the plan; this phase `require_approval`s — **you approve the plan before anything is built**.
- **build** — builder implements it; gates: `matchesPlan`, `testsPass`, `lintClean`. Budget exhaustion routes back to the planner.
- **review** — reviewer must approve (`reviewApproved`); a rejected review routes back to the builder (bounded revise loop).
- **ship** — commits/PRs behind **your approval** (`require_approval`).

## Run

```bash
showrunner run everything --prompt "<the work — real, and its shape is not obvious>"
```

The CLI takes a blueprint **module path**; `everything` is the starter-kit name and resolves to `src/starter-kit/blueprints/everything.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run src/starter-kit/blueprints/everything.ts --prompt "<the work>"
```

## Notes

- The run pauses for you twice: once to approve the plan, once to approve the ship. `showrunner approve <run_id>` continues each.
- Budgets are larger here than in `plan-build-test` (4 vs 3) — the shape is not obvious, so the agents get more corrections before routing or pausing.
- Use `plan-build-test` when the shape IS obvious and a plan approval would just be ceremony.
