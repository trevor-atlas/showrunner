# Showrunner

An agent orchestration tool: blueprints of phases, each running a configured
agent — observed live, corrected in place, and paused
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
showrunner daemon            # or: bun src/cli/index.ts daemon
```

In another terminal:

```bash
# 3. run a starter blueprint. Real pi by default — the daemon auto-detects the
#    binary and spawns the actual agent; --prompt steers it (it becomes the
#    run's first instruction, §8.2). The run's inputs/outputs live under the
#    DATA DIRECTORY (~/.showrunner/runs/<run_id>/<phase>/), never in your
#    checkout — nothing the harness does touches the source tree. (Set
#    SHOWRUNNER_FAKE=1 to replay the scripted demo sessions instead — no
#    tokens.)
showrunner run src/starter-kit/blueprints/scout.ts --prompt "map the auth flow"

# 4. watch it live
showrunner runs                              # list runs
showrunner watch <run_id>                    # stream the folded events
showrunner show <run_id>                     # phases, visits, corrections, spend
```

That first run drives one recon phase against the real pi binary and ends
`success` — you just steered an agent with your own words. `plan_build` is the
full plan → build → ship loop: it pauses for **your approval** before the ship
agent commits (`showrunner approve <run_id>` continues it). `plan_build_test`
adds the project's real tests + typecheck as build gates — run it in a project
that has a `tsconfig.json` (or a `"typecheck"` script) and a test suite; the
gates fail loudly, naming the missing piece, when it does not.

The daemon serves ONE web server — the §13 JSON API under `/api/*` and the
dashboard — on `http://localhost:44100` (`SHOWRUNNER_PORT` overrides; `0` =
ephemeral port, a test seam — not an off switch). The dashboard is always on;
a failed bind logs and the daemon continues without a web server.

Paused runs (approval / budget / guard / blocked) surface with `showrunner pause
<run_id>`; the menu verbs are `approve`, `steer`, `override`, `restart-fresh`,
and `fail`. Interrupted runs (a daemon crash) continue with `showrunner resume
<run_id>`.

### Daemon lifecycle: start, stop, restart, reset

The daemon is ONE long-lived process (owns SQLite, pi spawns, and the web
server). Every `showrunner` command auto-spawns it if it isn't already running
(`ensureDaemon`); the pidfile lives at `<data_dir>/daemon.pid` — two lines:
pid, then the bound port.

```bash
showrunner daemon            # run the daemon in the foreground (Ctrl-C stops it)
showrunner stop              # SIGTERM it gracefully: stops children, removes the pidfile
showrunner status            # is it up? pool utilization + run counts
```

- **Restart (pick up new code).** The daemon runs the code that was on disk
  when it started — there is no hot reload in production mode. To apply code
  changes: `showrunner stop`, then `showrunner daemon` again (or
  `bun --watch src/daemon/daemon.ts` while developing). Equivalent foreground
  invocations: `bun src/cli/index.ts daemon` or `bun src/daemon/daemon.ts`.
- **Reset (wipe all runs).** Stop the daemon, delete the data, start again:

  ```bash
  showrunner stop
  rm -rf ~/.showrunner/showrunner.db* ~/.showrunner/runs   # keep prices.json (your config)
  showrunner daemon
  ```

  `rm -rf ~/.showrunner` for a completely clean slate (drops `prices.json`
  too).
- **Find the process / port.** `lsof -iTCP:44100` shows the listener; the
  pidfile's second line is the bound port (ephemeral when `SHOWRUNNER_PORT=0`).
- **Dashboard.** http://localhost:44100 — the first hit may 503 for a few
  seconds while the remix router import warms up, then 200.
- **Restart caveat.** Runs left `running` when the daemon died are reconciled
  to `interrupted` on the next start (§12) and need `showrunner resume <run_id>`
  to continue; completed runs are untouched.

### The starter kit

Six agents, a shared gates library (`testsPass`, `lintClean`, `matchesPlan`,
…), ten blueprint modules, ten skill files, and the `poll` tool live in
[`src/starter-kit`](src/starter-kit/README.md) — a replace-this
surface by design: the tests it ships prove the machinery, not your
project. `showrunner run` takes a blueprint **module path**. `--prompt "<goal>"` is the
instruction the agent works against — it is composed into the run's first
prompt as the `[User request]` section (and snapshotted verbatim into the
run's `blueprint.json`). Every run's files live under the data directory
(`~/.showrunner/runs/<run_id>/`, see below) — the harness writes nothing into
your checkout, so no scratch `--cwd` is needed:

```bash
showrunner run src/starter-kit/blueprints/scout.ts --prompt "map the auth flow"
showrunner run src/starter-kit/blueprints/plan_build.ts --prompt "add offline sync"
```

Real-pi runs are the default (the daemon auto-detects the binary); scripted
FakePi sessions — the test fixture, not a runtime mode — are the opt-in
(`SHOWRUNNER_FAKE=1`) for demos and CI.

## Environment

| Variable | Meaning |
| --- | --- |
| `SHOWRUNNER_DATA_DIR` | data directory (default `~/.showrunner`): `showrunner.db`, `runs/`, `daemon.pid`, `prices.json`. Honored by the daemon, the CLI, and the SDK. One run = one folder under `runs/<run_id>/`: the §13.3 `blueprint.json` config snapshot, the §10 raw record (`raw_output.jsonl`, `envelope.json`, `agent_map.json`), `sessions/`, and the per-phase workspace `<phase>/inputs|outputs/` — everything a run produced, inspectable and modifiable by hand. |
| `SHOWRUNNER_PORT` | the single web-server port (default `44100`): the §13 API and the dashboard share it; `0` = ephemeral (the pidfile's second line records the bound port). This replaced `SHOWRUNNER_DAEMON_URL` and `SHOWRUNNER_DASHBOARD_PORT` (deleted). |
| `SHOWRUNNER_FAKE` | `=1` forces the scripted FakePi sessions (tests, CI, token-free demos). Unset = real pi by default (auto-detected). Explicitly overrides `SHOWRUNNER_SMOKE`. |
| `SHOWRUNNER_SMOKE` | `=1` forces the REAL pi driver regardless of detection (the capstone smoke). The smoke runs with `SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun test/daemon/smoke/smoke.ts`. |
| `SHOWRUNNER_PI_BINARY` | path to the pi binary for real runs (default: `pi` on PATH). |
| `SHOWRUNNER_POOL_SIZE` | concurrent run slots (default 2; a paused run keeps its slot, §5.4). |
| `PI_CODING_AGENT_SESSION_DIR` | session-tree root pi writes to and the §12.4 backfill reads from (tests point it at a scratch dir). |

`SHOWRUNNER_FAKE` never needs to be set for normal use: the daemon runs the
real pi binary when one is on PATH, and falls back to the scripted sessions
only on a machine with no pi installed.

## The architecture at a glance

One package, one runtime, one process. The tree mirrors the old five-package
split as plain directories — `src/core`, `src/daemon`, `src/cli`,
`src/starter-kit`, `src/ui` — because the modules are load-bearing, not the
package boundaries (spec §2.2 deferred workspaces; there is no publishing
boundary). Cross-directory imports are plain relative imports; there is a
single tsconfig, a single node_modules, a single cwd.

- **`src/core`** — the SDK: blueprint/agent/envelope/gate types, the FakePi
  harness, and the run-loop skeleton. No pi, no SQLite.
- **`src/daemon`** — the long-lived daemon: owns SQLite (the write path),
  spawns pi, folds the raw stream into events (tracer, §7), runs the envelope
  and gate stages, the pause/control surface, and the merged web server
  (`src/daemon/web.ts`): ONE TCP listener on `127.0.0.1:44100` serving the §13
  JSON API under `/api/*` AND the remix@next dashboard in-process (§16).
- **`src/cli`** — `showrunner`: a thin typed client over the daemon's HTTP API.
- **`src/starter-kit`** — the replace-this content (agents, gates, blueprints, skills, poll tool).
- **`src/ui`** — the remix@next dashboard (served by the daemon via `src/daemon/web.ts`; `bun --watch src/ui/server.ts` boots the whole daemon in-process for UI dev).

## Docs

- [CONTEXT.md](./CONTEXT.md) — glossary / ubiquitous language
- [docs/spec](./docs/spec/) — the implementation contract, split by subsystem
  (index: [README.md](./docs/spec/README.md); **the UI is remix@next, NOT
  React** — see §16)
- [docs/implementation-record.md](./docs/implementation-record.md) — build
  history + known limitations
- [docs/diagrams/run-loop.md](./docs/diagrams/run-loop.md) — the run lifecycle

## Development

```bash
bun test                              # the full suite (FakePi; no pi binary, no tokens)
bunx tsc --noEmit   # one package, one typecheck
SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun test/daemon/smoke/smoke.ts
                                      # the capstone smoke: real pi, real repo, real tokens (T13)
```

Dev flow — every entry below boots a FULL daemon in-process (equivalent):

```bash
bun --watch src/ui/server.ts           # daemon + dashboard, dev reload
bun --watch src/daemon/daemon.ts       # same daemon, no UI dev reload
bun hmr                                # HMR without restarts (hmr.ts spawns server.ts as its HMR child)
```
