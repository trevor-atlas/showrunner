---
name: prompt
description: "Launch a Showrunner run that sends one prompt to a single agent (planner by default — edit the blueprint to pick another). You launch and monitor the run; the agent does the work. Use for a one-off, one-agent task where a full plan→build→ship chain is overkill."
---

# Showrunner: one agent, one prompt

**Run this through Showrunner — do not do the work yourself.** Your job is operator, not implementer: launch the run with the user's request, monitor it, and report what the agent produced. The run runs exactly one phase with one agent — by default the **planner**; edit `src/starter-kit/blueprints/prompt.ts` (or copy it) to swap in `builder`, `scout`, `reviewer`, `documenter`, or `ship`.

## Launch

```bash
showrunner run prompt --prompt "<the user's goal, verbatim>"
```

`prompt` is the starter-kit name for `src/starter-kit/blueprints/prompt.ts` — use the path form if the CLI does not accept bare names:

```bash
showrunner run src/starter-kit/blueprints/prompt.ts --prompt "<the user's goal>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary. Do not start doing the task yourself before or while the run works.

## Monitor

- `showrunner run` prints the run id. Then `showrunner watch <run_id>` follows it to a terminal state; `showrunner runs` or `showrunner show <run_id>` give snapshots.
- No approval pauses — the run runs to completion.
- When the run is terminal, report to the user: the final status and what the agent produced.

## When to use

A one-off, one-agent task where a full plan→build→ship chain is overkill. To send the prompt to a different agent, change the `agent:` in the `prompt` blueprint — that edit is the whole point of the starter kit.
