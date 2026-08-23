---
name: plan
description: Produce a concrete, executable plan document with the Showrunner planner agent — scope, ordered steps, checks, and any questions it cannot answer safely. Use before any code moves when the goal is real and underspecified.
---

# Showrunner: plan

Run the Showrunner `plan` blueprint: one planning phase by the planner agent. It writes a plan document (scope, ordered steps naming files and agents, checks that prove each step, assumptions) and raises questions it cannot answer safely.

## Run

```bash
showrunner run plan --prompt "<the goal to plan, e.g. 'add offline sync to the mobile client'>"
```

The CLI takes a blueprint **module path**; `plan` is the starter-kit name and resolves to `src/starter-kit/blueprints/plan.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run src/starter-kit/blueprints/plan.ts --prompt "<the goal to plan>"
```

## Notes

- The plan phase's envelope must carry a `plan_path` (the `envelopeShape` gate) — the plan document is the deliverable.
- Ambiguous goals are surfaced as `questions` in the envelope, which pauses the run for a human rather than letting the planner guess.
- Follow with `build` (the plan already exists) or `plan-build` (plan + build + ship in one run).
