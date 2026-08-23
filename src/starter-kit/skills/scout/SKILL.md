---
name: scout
description: "Launch a read-only Showrunner recon run — the scout agent explores the codebase and reports findings without changing anything. You launch and monitor; you do not do the recon yourself. Use when nothing should change yet: an unfamiliar repo, sizing up a task, or 'what is here and how does it fit together?'."
---

# Showrunner: scout (read-only recon)

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the recon run with the question to investigate, monitor it, and report the findings. The scout agent does the exploring — read-only, nothing in the workspace changes.

## Launch

```bash
showrunner run scout --prompt "<what to investigate, verbatim>"
```

`scout` is the starter-kit name for `src/starter-kit/blueprints/scout.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/scout.ts --prompt "<what to investigate>"
```

`--prompt` carries the run's goal: pass the user's **full question**, not a summary. Do not start exploring the codebase yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state; `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run runs to completion.
- When the run is terminal, report to the user: the final status and where the findings landed.

## When to use

Nothing should change yet: exploring an unfamiliar repo, sizing up a task, or answering "what is here and how does it fit together?". Reach for it before `plan` or `build` — the findings become the base of information the next agent gets.
