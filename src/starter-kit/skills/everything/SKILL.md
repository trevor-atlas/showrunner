---
name: everything
description: "Launch the full Showrunner chain for real work whose shape is not obvious — plan (human-approved before building), build, test, review, ship (human-approved before committing). You launch and monitor; the blueprint's agents do the work. Use when the work is real and you want every gate plus human checkpoints."
---

# Showrunner: everything (plan → build → test → review → ship, with human checkpoints)

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the run with the user's request, monitor it, surface its two approval pauses, and report what it produced. The blueprint's agents do the actual planning, building, testing, reviewing, and shipping.

## Launch

```bash
showrunner run everything --prompt "<the user's request, verbatim>"
```

`everything` is the starter-kit name for `src/starter-kit/blueprints/everything.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/everything.ts --prompt "<the user's request>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start planning, building, or testing any part of it yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state (success / paused / failed); `showrunner runs` or `showrunner show <run_id>` give snapshots.
- The run pauses for **your approval twice**: once before anything is built (the plan), and once before the ship phase commits/PRs. Surface each pause to the user; when they say go, continue with `showrunner approve <run_id>` and re-watch.
- When the run is terminal, report to the user: the final status, what it produced (plan, code changes, PR), and anything it surfaced (questions, decisions, blocked reasons).

## When to use

Real work whose shape is not obvious, where every gate plus a human checkpoint is wanted before anything ships. If the shape IS obvious and a plan approval would be ceremony, use `plan-build-test`.
