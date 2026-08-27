---
name: showrunner
description: "Start and manage Showrunner runs from the CLI — discover the available blueprints, launch one against a task, monitor it, and handle its pauses (approve, steer, resume, override, fail). Use whenever the user wants to run a blueprint, kick off agent work through Showrunner, or check on / intervene in a run. You are the operator: you launch and manage runs; the blueprint's agents do the actual work — do not do the task yourself."
---

# Showrunner: start and manage runs

**Run the work through Showrunner — do not do it yourself.** Your job is operator, not implementer: pick a blueprint, launch it with the user's request, monitor it, surface any pause, and report what it produced. The blueprint's agents plan, build, test, review, and ship. Do not start planning or editing code yourself before or while a run works.

Every command is `showrunner <cmd>`. Blueprints are referenced **by name** (resolved from the data dir — `~/.showrunner/templates/blueprints/`, override with `SHOWRUNNER_DATA_DIR`), never by file path.

**Prerequisite:** the `showrunner` binary must be on `PATH`. If `showrunner` is not found, it has not been linked — from the Showrunner repo run `bun link` once (it installs `showrunner` into `~/.bun/bin`). Do not fall back to `bun path/to/cli.ts`; fix the install so the commands below work verbatim.

## 1. Discover the blueprint

Do not guess a blueprint name — list what is actually installed, then read its shape.

```bash
showrunner blueprints              # every blueprint + its phase chain
showrunner blueprints <name>       # one blueprint's phases: agent, budget, on_fail, approval
```

`blueprints <name>` tells you what a run will do before you start it: the ordered phases, which agent runs each, the correction budget, any `on_fail` branch, and which phases pause for **your approval** (`require_approval`). Pick the blueprint whose phase chain matches the user's intent (e.g. read-only recon vs. plan→build→review→ship). If none fits, edit or add one (next section) — the list reflects whatever is in the data dir.

## Customize or add a blueprint

Blueprints are TypeScript modules **you edit** — they live in the data dir at `~/.showrunner/templates/blueprints/<name>.ts` (root `~/.showrunner`, or `SHOWRUNNER_DATA_DIR`). Each file is a `defineBlueprint({ name, phases: [...] })` module whose phases wire the agents, output contracts, and gates that sit beside it — the whole replace-this surface is in the same tree: `agents/`, `gates/`, `envelopes.ts`, `models.ts`.

- **Edit** an existing blueprint's phases, gates, budgets, `on_fail`, or `require_approval` in its file.
- **Add** one by dropping a new `<name>.ts` in `blueprints/`; it shows up in `showrunner blueprints` immediately (resolved by file name) and runs with `showrunner run <name>`.
- `showrunner blueprints [<name>]` imports and validates each module, so a syntax or wiring error surfaces there — verify your change before a run.
- `showrunner templates sync [--yes]` pulls starter-kit updates into the data dir without clobbering your edits (drift is reported; `--yes` overwrites).

The full authoring guide — agents, gates, envelopes, the model roster — lives beside them at `~/.showrunner/templates/README.md`.

## 2. Launch

```bash
showrunner run <name> --prompt "<the user's request, verbatim>"
```

`--prompt` carries the run's goal: pass the user's **full request**, not a summary or paraphrase. Optional: `--cwd <dir>` to run against another working directory. The command prints the run id and the commands to watch it.

An unknown name fails fast and lists what is available — re-check step 1 if that happens.

## 3. Monitor

```bash
showrunner watch <run_id>          # stream folded events to a terminal state
showrunner runs                    # all runs: status + phase counts
showrunner show <run_id>           # snapshot: phases, visits, corrections, spend
showrunner status                  # server: pool utilization + run status counts
```

`watch` follows a run until it is terminal (success / failed) or pauses. A run reaches `paused` when a phase needs your approval or a gate is stuck; `interrupted` awaits a resume.

## 4. Intervene on a pause

When a run pauses, surface it to the user and act on their decision — do not decide for them:

```bash
showrunner pause <run_id>                              # the pause viewer + what actions apply
showrunner approve <run_id>                            # approve a require_approval pause, then re-watch
showrunner steer <run_id> "<message>"                  # inject guidance into the live session (paused or running)
showrunner override <run_id> --gate <gate> --reason "<why>"   # override a failed gate
showrunner restart-fresh <run_id> [phase]             # restart the paused phase with a new session
showrunner resume <run_id>                             # continue an interrupted run
showrunner fail <run_id>                               # give up: fail the run (kills its children)
```

After any action, re-`watch` the run. When the run is terminal, report to the user: the final status, what it produced (findings, plan, code changes, PR), and anything it surfaced (questions, decisions, blocked reasons).

## Server (only if needed)

The CLI auto-starts the server for a run. Manage it explicitly when asked:

```bash
showrunner server                  # run the server in the foreground
showrunner stop                    # stop the server
showrunner templates sync [--yes]  # pull starter-kit updates into the data dir (drift reported; --yes overwrites)
```
