---
name: build-test
description: Build with a test suite to satisfy — the Showrunner builder implements the plan, then the run loops build ⇄ fix until the tests and typecheck pass (testsPass + lintClean gates) or the visit guard pauses. Use when there is an existing suite and "make it green" is the whole job.
---

# Showrunner: build with a test gate and bounded fix loop

Run the Showrunner `build_test` blueprint: builder, gates on (`testsPass` = `bun test`, `lintClean` = `bunx tsc --noEmit`), and a bounded fix loop — `build` ⇄ `fix`, each routing to the other on budget exhaustion, terminated or paused by the visit guard.

## Run

```bash
showrunner run build_test --prompt "<what to build — the run keeps going until the suite is green>"
```

The CLI takes a blueprint **module path**; `build_test` is the starter-kit name and resolves to `src/starter-kit/blueprints/build_test.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run src/starter-kit/blueprints/build_test.ts --prompt "<what to build>"
```

## Notes

- The gate commands are the replaceable defaults (`bun test`, `bunx tsc --noEmit`) — override them per phase via the gate options (`testsPass({ command: "npm test" })`) in the blueprint.
- A phase that keeps failing eats its correction budget, routes to the other phase, and eventually hits the visit guard and pauses for a human — a red suite never ships silently.
- Skip the lint gate by copying the blueprint and dropping `lintClean()` if your project has no typecheck step.
