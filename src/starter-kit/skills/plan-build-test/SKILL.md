---
name: plan-build-test
description: "Launch the standard Showrunner chain — plan, build, test + typecheck, review, ship behind human approval — as a single run. You launch and monitor the run; the blueprint's agents do the work. Use for ordinary feature work the user wants planned, green, reviewed, and shipped."
---

# Showrunner: the standard chain (plan → build → test → review → ship)

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the blueprint run with the user's request, monitor it, surface its approval pause, and report what it produced. The run's agents do the actual planning, building, testing, reviewing, and shipping.

## Launch

```bash
showrunner run plan_build_test --prompt "<the user's request, verbatim>"
```

`plan_build_test` is the starter-kit name for `src/starter-kit/blueprints/plan_build_test.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/plan_build_test.ts --prompt "<the user's request>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary or a paraphrase. Do not start planning, building, or testing any part of it yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state (success / paused / failed); `showrunner runs` or `showrunner show <run_id>` give snapshots.
- The run pauses for **your approval** before the ship phase commits/PRs. Surface that pause to the user; when they say go, continue with `showrunner approve <run_id>` and re-watch.
- When the run is terminal, report to the user: the final status, what it produced (plan, code changes, PR), and anything it surfaced (questions, decisions, blocked reasons).

## When to use

Ordinary feature work that should be planned, green, reviewed, and shipped. For work whose shape is not obvious, use `everything` (adds a human approval on the plan itself); for a quick implement-without-gates pass, use `build`.
