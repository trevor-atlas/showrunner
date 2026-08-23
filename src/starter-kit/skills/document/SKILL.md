---
name: document
description: "Launch a Showrunner run that writes up what just changed — the documenter produces Markdown docs for humans and the next agent from the diff. You launch and monitor; you do not write the docs yourself. Use after a ship when the work landed but the 'what changed and how to verify' notes were never written."
---

# Showrunner: document the last change

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the documentation run, monitor it, and report the docs it produces. The documenter agent does the actual writing, based on the workspace's current diff.

## Launch

```bash
showrunner run document --prompt "<what to document, e.g. 'document the change on branch feature/offline-sync from its diff', verbatim>"
```

`document` is the starter-kit name for `src/starter-kit/blueprints/document.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/document.ts --prompt "<what to document>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start writing docs yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state; `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run runs to completion.
- When the run is terminal, report to the user: the final status and which docs were written.

## When to use

After a ship, when the work landed but nobody wrote the "what changed and how to verify it" notes. The documenter works from the workspace's current diff, so it is most useful right after a ship phase (or pointed at an unmerged branch).
