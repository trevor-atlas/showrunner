---
name: plan-build
description: "Launch a Showrunner run that plans, builds, and ships a small piece of work — the planner writes the plan, the builder implements it, and ship commits/PRs behind human approval. You launch and monitor; the blueprint's agents do the work. Use when the work is small and a full test+review chain would be overhead."
---

# Showrunner: plan → build → ship

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the run with the user's request, monitor it, surface its approval pause, and report what it produced. The blueprint's agents do the actual planning, building, and shipping.

## Launch

```bash
showrunner run plan_build --prompt "<the user's request, verbatim>"
```

`plan_build` is the starter-kit name for `src/starter-kit/blueprints/plan_build.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/plan_build.ts --prompt "<the user's request>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start planning or building any part of it yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state (success / paused / failed); `showrunner runs` or `showrunner show <run_id>` give snapshots.
- The run pauses for **your approval** before the ship phase commits/PRs. Surface that pause to the user; when they say go, continue with `showrunner approve <run_id>` and re-watch.
- When the run is terminal, report to the user: the final status, what it produced (plan, code changes, PR), and anything it surfaced.

## When to use

Small, well-understood work where a full test + review chain would be overhead. If a test suite must pass, use `plan-build-test`; if the work is real and its shape is not obvious, use `everything`.
