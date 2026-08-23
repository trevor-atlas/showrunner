---
name: document
description: Write up what just shipped with the Showrunner documenter — clear Markdown docs for humans and the next agent, based on the git diff. Use after a ship when the work landed but nobody wrote the "what changed and how to verify it" notes. The filesExist gate insists the docs actually got written.
---

# Showrunner: document the last change

Run the Showrunner `document` blueprint: one documentation phase by the documenter agent. Hand it the diff to write up (via the prompt or as the workspace state — e.g. run it right after a ship, or point it at a branch/PR), and it produces Markdown docs under the workspace root.

## Run

```bash
showrunner run document --prompt "<what to document, e.g. 'document the change on branch feature/offline-sync from its diff'>"
```

The CLI takes a blueprint **module path**; `document` is the starter-kit name and resolves to `packages/starter-kit/src/blueprints/document.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run packages/starter-kit/src/blueprints/document.ts --prompt "<what to document>"
```

## Notes

- The `filesExist` gate refuses an envelope that lists no artifacts — the documenter must actually write docs, not just describe them.
- The documenter works from the workspace's current diff, so it is most useful immediately after a ship phase (or pointed at an unmerged branch).
