---
name: prompt
description: Send a single prompt to one Showrunner agent of your choosing (edit the blueprint to pick who: planner, builder, scout, reviewer, documenter, or ship). Use for a one-off, one-agent task where a full plan→build→ship chain is overkill.
---

# Showrunner: one agent, one prompt

Send the user's `{prompt}` to a single agent through Showrunner. The starter kit's `prompt` blueprint runs exactly one phase with one agent — by default the **planner**; edit `packages/starter-kit/src/blueprints/prompt.ts` (or copy it) to swap in `builder`, `scout`, `reviewer`, `documenter`, or `ship`.

## Run

```bash
showrunner run prompt --prompt "<the user's goal, as one argument>"
```

The CLI takes a blueprint **module path**; `prompt` is the starter-kit name and resolves to `packages/starter-kit/src/blueprints/prompt.ts` (see that package's README for the name→path map). If your CLI does not accept bare names yet, use the path form:

```bash
showrunner run packages/starter-kit/src/blueprints/prompt.ts --prompt "<the user's goal>"
```

## Notes

- The `{prompt}` argument is the goal of the run; pass it as `--prompt` per the
  spec's CLI form. (The current CLI parses but does not yet forward `--prompt`
  to the daemon — until it ships, the phase goal is configured in the blueprint
  and you steer the run; see the starter-kit README.)
- To make this skill send to a different agent, change the `agent:` in the
  `prompt` blueprint — that edit is the whole point of the starter kit
  (replace-this doctrine).
