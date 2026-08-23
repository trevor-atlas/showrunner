---
name: scout
description: "Read-only reconnaissance of a codebase by the Showrunner scout agent — what files are involved, what they do, and what a builder or planner should know before touching anything. Use when nothing should change yet: exploring an unfamiliar repo, sizing up a task, or answering \"what is here and how does it fit together?\"."
---

# Showrunner: scout (read-only recon)

Run the Showrunner `scout` blueprint: one recon phase by the scout agent, which has no write or edit tools — it explores the workspace and reports findings. Nothing changes.

## Run

```bash
showrunner run scout --prompt "<what to investigate, e.g. 'map the auth flow and note anything fragile'>"
```

The CLI takes a blueprint **module path**; `scout` is the starter-kit name and resolves to `src/starter-kit/blueprints/scout.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run src/starter-kit/blueprints/scout.ts --prompt "<what to investigate>"
```

## Notes

- The recon phase's envelope must carry `findings` (the `envelopeShape` gate) — a scout that reported nothing cannot pass.
- Reach for this before `plan` or `build`: the scout's findings become the base of information the next agent gets.
