---
name: build-review
description: Build and get it reviewed against the plan by a Showrunner reviewer — the run loops build ⇄ review until the reviewer approves (reviewApproved gate) or the visit guard pauses. Use when "is this what was asked for" matters more than "does it run" — design fidelity, not just green tests.
---

# Showrunner: build with a reviewer and bounded revise loop

Run the Showrunner `build_review` blueprint: builder, then a reviewer that judges the work against the plan and must set `approved: true` (the `reviewApproved` gate). A rejected review routes back to the builder; a builder that cannot pass routes forward to the reviewer — the loop terminates or pauses via the visit guard.

## Run

```bash
showrunner run build_review --prompt "<what to build and against what plan/standard it is judged>"
```

The CLI takes a blueprint **module path**; `build_review` is the starter-kit name and resolves to `packages/starter-kit/src/blueprints/build_review.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run packages/starter-kit/src/blueprints/build_review.ts --prompt "<what to build>"
```

## Notes

- The reviewer is read-only and deliberately not rubber-stamping: it must write concrete `issues` when it does not approve.
- A review that keeps rejecting eats its correction budget, routes back to the builder, and eventually pauses for a human — the verdict, not the build, decides.
- Reach for `plan-build-test` when green tests matter *and* a review matters, or `everything` when the shape of the work is not obvious.
