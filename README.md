# Showrunner

An agent orchestration tool: blueprints of phases, each running a configured
agent against a local pi harness — observed live, corrected in place, and paused
for humans when success cannot be earned.

- **Observable** — every event lands in SQLite mid-flight; runs are watched, not
  read about afterwards. Each phase produces a typed envelope (§9) that gates
  the next phase.
- **Corrected in place** — when a gate rejects an envelope, the daemon re-prompts
  the SAME pi session with one message naming exactly what was wrong (§5.2).
- **Human in the loop** — approval, budget-exhaustion, blocked, and visit-guard
  pauses suspend the run until a human steers, approves, overrides a gate, or
  restarts the phase fresh (§5.3).
- **Crash-safe** — the raw stream is appended before it is parsed; a killed
  daemon reaps orphans, surfaces interrupted runs, and backfills the missed
  session tail on restart (§12).

## Quickstart

Prerequisites: [bun](https://bun.sh) (1.4+) and a local
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) binary on
your PATH.

```bash
# 1. install (each package is a file: dep — no workspaces)
bun install

# 2. start the daemon (long-lived; owns SQLite + pi spawns + the local API)
showrunner daemon            # or: bun packages/cli/src/index.ts daemon
```

In another terminal:

```bash
# 3. run a starter blueprint (FakePi sessions ship with the kit — no tokens).
#    --prompt steers the agent: it becomes the run's first instruction (§8.2).
#    --cwd runs the work in a scratch workspace, so the run's context_handoff/
#    output never lands in your checkout:
showrunner run packages/starter-kit/src/blueprints/scout.ts --prompt "map the auth flow" --cwd "$(mktemp -d)"

# 4. watch it live
showrunner runs                              # list runs
showrunner watch <run_id>                    # stream the folded events
showrunner show <run_id>                     # phases, visits, corrections, spend
```

That first run drives one recon phase and ends `success` — you just steered an
agent with your own words. `plan_build` is the full plan → build → ship loop:
it pauses for **your approval** before the ship agent commits
(`showrunner approve <run_id>` continues it). `plan_build_test` adds the
project's real tests + typecheck as build gates — run it in a project that has
a `tsconfig.json` (or a `"typecheck"` script) and a test suite; the gates fail
loudly, naming the missing piece, when it does not.

Paused runs (approval / budget / guard / blocked) surface with `showrunner pause
<run_id>`; the menu verbs are `approve`, `steer`, `override`, `restart-fresh`,
and `fail`. Interrupted runs (a daemon crash) continue with `showrunner resume
<run_id>`.

### The starter kit

Six agents, a shared gates library (`testsPass`, `lintClean`, `matchesPlan`,
…), ten blueprint modules, ten skill files, and the `poll` tool live in
[`packages/starter-kit`](packages/starter-kit/README.md) — a replace-this
surface by design (PLAN §14): the tests it ships prove the machinery, not your
project. `showrunner run` takes a blueprint **module path**. `--prompt "<goal>"` is the
instruction the agent works against — it is composed into the run's first
prompt as the `[User request]` section (and snapshotted verbatim into the
run's `blueprint.json`). Run the demo in a scratch `--cwd` so its
`context_handoff/` output never dirties your checkout:

```bash
showrunner run packages/starter-kit/src/blueprints/scout.ts --prompt "map the auth flow" --cwd "$(mktemp -d)"
showrunner run packages/starter-kit/src/blueprints/plan_build.ts --prompt "add offline sync" --cwd "$(mktemp -d)"
```

Real-pi runs (env-gated) drive the same loop against the actual pi binary and
cost real tokens — see `SHOWRUNNER_SMOKE` below.

## Environment

| Variable | Meaning |
| --- | --- |
| `SHOWRUNNER_DATA_DIR` | data directory (default `~/.showrunner`): `showrunner.db`, `runs/`, `daemon.sock`, `daemon.pid`, `prices.json`. Honored by the daemon, the CLI, and the SDK. |
| `SHOWRUNNER_DAEMON_URL` | HTTP base URL override for the daemon client (dev mode). Unset = the unix socket at `{SHOWRUNNER_DATA_DIR}/daemon.sock`. |
| `SHOWRUNNER_SMOKE` | `=1` selects the REAL pi session driver (daemon + `runBlueprint`); unset/anything else uses scripted FakePi sessions. The capstone smoke runs with `SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun packages/daemon/test/smoke/smoke.ts`. |
| `SHOWRUNNER_PI_BINARY` | path to the pi binary for real runs (default: `pi` on PATH). |
| `SHOWRUNNER_POOL_SIZE` | concurrent run slots (default 2; a paused run keeps its slot, §5.4). |
| `PI_CODING_AGENT_SESSION_DIR` | session-tree root pi writes to and the §12.4 backfill reads from (tests point it at a scratch dir). |

`SHOWRUNNER_SMOKE` never needs to be set for normal use: the kit ships scripted
FakePi sessions (`packages/starter-kit/src/blueprints/fake-pi/`) so every
blueprint runs out of the box with zero token spend.

## The architecture at a glance

- **`packages/core`** — the SDK: blueprint/agent/envelope/gate types, the FakePi
  harness, and the run-loop skeleton. No pi, no SQLite.
- **`packages/daemon`** — the long-lived daemon: owns SQLite (the write path),
  spawns pi, folds the raw stream into events (tracer, §7), runs the envelope
  and gate stages, the pause/control surface, and the local HTTP API on a unix
  socket (§13). See
  [ADR-0003: daemon owns spawn and the SQLite write path](docs/adr/0003-daemon-owns-spawn-and-sqlite-write-path.md).
- **`packages/cli`** — `showrunner`: a thin typed client over the daemon socket.
- **`packages/starter-kit`** — the replace-this content (agents, gates, blueprints, skills, poll tool).

## Docs

- [PLAN.md](./PLAN.md) — the settled design
- [CONTEXT.md](./CONTEXT.md) — glossary / ubiquitous language
- [docs/spec](./docs/spec/) — the implementation contract, split by subsystem
  (index: [README.md](./docs/spec/README.md); **the UI is remix@next, NOT
  React** — see §16)
- [docs/adr](./docs/adr/) — architecture decisions
- [docs/diagrams/run-loop.md](./docs/diagrams/run-loop.md) — the run lifecycle

## Development

```bash
bun test                              # 267 fixtures across all packages (230 + 37 UI) (FakePi; no pi binary, no tokens)
bunx tsc -p packages/daemon/tsconfig.json --noEmit   # per-package typecheck
SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun packages/daemon/test/smoke/smoke.ts
                                      # the capstone smoke: real pi, real repo, real tokens (T13)
```
