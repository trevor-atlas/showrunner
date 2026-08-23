---
name: build-test
description: "Launch a Showrunner run that builds against an existing test suite and keeps looping build ⇄ fix until the tests and typecheck pass. You launch and monitor the run; you do not implement the work yourself. Use when there is a suite and 'make it green' is the whole job."
---

# Showrunner: build until the suite is green

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the run with the user's request, monitor it, and report the result. The builder agent does the actual implementation, and the run keeps looping build ⇄ fix until the tests and typecheck pass (or it pauses for a human).

## Launch

```bash
showrunner run build_test --prompt "<what to build, verbatim>"
```

`build_test` is the starter-kit name for `src/starter-kit/blueprints/build_test.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/build_test.ts --prompt "<what to build>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start implementing or running tests yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state (success / paused / failed); `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run either finishes green, or pauses for a human if it cannot converge (a red suite never ships silently).
- When the run is terminal, report to the user: the final status and the files the builder changed.

## When to use

An existing suite must be satisfied and "make it green" is the whole job. For a quick implement-without-gates pass, use `build`; when design fidelity matters too, use `build-review` or `plan-build-test`.
