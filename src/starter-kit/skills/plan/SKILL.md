---
name: plan
description: "Launch a Showrunner planning run — the planner agent turns the goal into a concrete, executable plan document and surfaces questions instead of guessing. You launch and monitor the run; you do not write the plan yourself. Use before any code moves when the goal is real and underspecified."
---

# Showrunner: plan (the spec before any code)

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the planning run with the user's goal, monitor it, and report the plan document it produces. The planner agent does the actual planning.

## Launch

```bash
showrunner run plan --prompt "<the goal to plan, verbatim>"
```

`plan` is the starter-kit name for `src/starter-kit/blueprints/plan.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/plan.ts --prompt "<the goal to plan>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start planning or exploring yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state; `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run runs to completion.
- When the run is terminal, report to the user: the final status, where the plan document landed, and any questions the planner surfaced (an ambiguous goal pauses the run rather than being guessed).

## When to use

The spec before any code: the goal is real but underspecified and nothing should be built yet. If the user just wants reconnaissance first, use `scout`; if the plan already exists and only needs implementing, use `build`.
