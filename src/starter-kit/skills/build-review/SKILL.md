---
name: build-review
description: "Launch a Showrunner run that builds the work and loops build ⇄ review until a reviewer approves it against the plan. You launch and monitor the run; you do not implement or review yourself. Use when 'is this what was asked for' matters more than 'does it run'."
---

# Showrunner: build with a review loop

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the run with the user's request, monitor it, and report the outcome. The builder implements and a reviewer judges the work against the plan; the run loops until the review approves or it pauses for a human.

## Launch

```bash
showrunner run build_review --prompt "<what to build, and against what plan/standard it is judged, verbatim>"
```

`build_review` is the starter-kit name for `src/starter-kit/blueprints/build_review.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/build_review.ts --prompt "<what to build>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start building or reviewing anything yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state (success / paused / failed); `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run either finishes with an approved review, or pauses for a human if the loop cannot converge.
- When the run is terminal, report to the user: the final status and the reviewer's verdict.

## When to use

Design fidelity matters more than green tests: "is this what was asked for" is the bar. If green tests matter *and* a review matters, use `plan-build-test`; if the shape of the work is not obvious, use `everything`.
