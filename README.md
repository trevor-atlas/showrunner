# Showrunner

An agent orchestration tool: blueprints of phases, each running a configured
agent — observed live, corrected in place, and paused
for humans when success cannot be earned.

- **Observable** — every event lands in SQLite mid-flight; runs are watched, not
  read about afterwards. Each phase produces a typed envelope that gates
  the next phase.
- **Corrected in place** — when a gate rejects an envelope, the server re-prompts
  the SAME pi session with one message naming exactly what was wrong.
- **Human in the loop** — approval, budget-exhaustion, blocked, and visit-guard
  pauses suspend the run until a human steers, approves, overrides a gate, or
  restarts the phase fresh.
- **Crash-safe** — the raw stream is appended before it is parsed; a killed
  server reaps orphans, surfaces interrupted runs, and backfills the missed
  session tail on restart.

## Quickstart

Prerequisites: [bun](https://bun.sh) (1.4+) and a local
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) binary on
your PATH.

```bash
# 1. install (each package is a file: dep — no workspaces)
bun install
# put the `showrunner` binary on PATH (installs into ~/.bun/bin):
bun link

# 2. start the server (long-lived; owns SQLite + pi spawns + the local API)
showrunner server            # or: bun src/cli/index.ts server
```

In another terminal:

```bash
# 3. run a starter blueprint. Real pi by default — the server auto-detects the
#    binary and spawns the actual agent; --prompt steers it (it becomes the
#    run's first instruction). The run's inputs/outputs live under the
#    DATA DIRECTORY (~/.showrunner/runs/<run_id>/<phase>/), never in your
#    checkout — nothing the harness does touches the source tree. (Set
#    SHOWRUNNER_FAKE=1 to replay the scripted demo sessions instead — no
#    tokens.)
showrunner blueprints                        # discover blueprints by name
showrunner run scout --prompt "map the auth flow"

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

The server serves ONE web server — the JSON API under `/api/*` and the
dashboard — on `http://localhost:44100` (`SHOWRUNNER_PORT` overrides; `0` =
ephemeral port, a test seam — not an off switch). The dashboard is always on;
a failed bind logs and the server continues without a web server.

Paused runs (approval / budget / guard / blocked) surface with `showrunner pause
<run_id>`; the menu verbs are `approve`, `steer`, `override`, `restart-fresh`,
and `fail`. Interrupted runs (a server crash) continue with `showrunner resume
<run_id>`.

### Server lifecycle: start, stop, restart, reset

The server is ONE long-lived process (owns SQLite, pi spawns, and the web
server). Every `showrunner` command auto-spawns it if it isn't already running
(`ensureServer`). A bind-based double-boot guard (EADDRINUSE on the fixed
port) keeps a second server from starting for the same data dir — the live
socket is the guard, there is no pidfile.

```bash
showrunner server            # run the server in the foreground (Ctrl-C stops it)
showrunner stop              # SIGTERM it gracefully: stops children, closes the server + DB
showrunner status            # is it up? pool utilization + run counts
```

- **Restart (pick up new code).** The server runs the code that was on disk
  when it started — there is no hot reload in production mode. For UI work,
  don't stop/restart: `showrunner dev` runs remix HMR so `src/server/ui/**` edits
  hot-swap in place (see [The UI dev loop](#the-ui-dev-loop) for the run-safety
  tradeoffs). To apply non-UI code changes: `showrunner stop`, then
  `showrunner server` again (or `bun --watch src/server/main.ts` while
  developing). Equivalent foreground invocations: `bun src/cli/index.ts server`
  or `bun src/server/main.ts`.
- **Reset (wipe all runs).** Stop the server, delete the data, start again:

  ```bash
  showrunner stop
  rm -rf ~/.showrunner/showrunner.db* ~/.showrunner/runs   # keep prices.json (your config)
  showrunner server
  ```

  `rm -rf ~/.showrunner` for a completely clean slate (drops `prices.json`
  too).
- **Find the process / port.** `lsof -iTCP:44100` shows the listener (the
  resolved `SHOWRUNNER_PORT`; ephemeral when `SHOWRUNNER_PORT=0`).
- **Dashboard.** http://localhost:44100 — the first hit may 503 for a few
  seconds while the remix router import warms up, then 200.
- **Restart caveat.** Runs left `running` when the server died are reconciled
  to `interrupted` on the next start and need `showrunner resume <run_id>`
  to continue; completed runs are untouched.

### The starter kit

Six agents, a shared gates library (`testsPass`, `lintClean`, `matchesPlan`,
…), ten blueprint modules, one operator skill, and the `poll` tool live in
[`src/starter-kit`](src/starter-kit/README.md) — a replace-this
surface by design: the tests it ships prove the machinery, not your
project. `showrunner run` takes a blueprint **name**, resolved from the data dir
(`showrunner blueprints` lists them; `showrunner blueprints <name>` shows a
blueprint's phases). `--prompt "<goal>"` is the
instruction the agent works against — it is composed into the run's first
prompt as the `[User request]` section (and snapshotted verbatim into the
run's `blueprint.json`). Every run's files live under the data directory
(`~/.showrunner/runs/<run_id>/`, see below) — the harness writes nothing into
your checkout, so no scratch `--cwd` is needed:

```bash
showrunner run scout --prompt "map the auth flow"
showrunner run plan_build --prompt "add offline sync"
```

Real-pi runs are the default (the server auto-detects the binary); scripted
FakePi sessions — the test fixture, not a runtime mode — are the opt-in
(`SHOWRUNNER_FAKE=1`) for demos and CI.

## Environment

| Variable | Meaning |
| --- | --- |
| `SHOWRUNNER_DATA_DIR` | data directory (default `~/.showrunner`): `showrunner.db`, `runs/`, `prices.json`. Honored by the server, the CLI, and the SDK. One run = one folder under `runs/<run_id>/`: the `blueprint.json` config snapshot, the raw record (`raw_output.jsonl`, `envelope.json`, `agent_map.json`), `sessions/`, and the per-phase workspace `<phase>/inputs|outputs/` — everything a run produced, inspectable and modifiable by hand. |
| `SHOWRUNNER_PORT` | the single web-server port (default `44100`): the API and the dashboard share it; `0` = ephemeral (the OS picks a free port). This replaced the old server-URL and dashboard-port variables (deleted). |
| `SHOWRUNNER_FAKE` | `=1` forces the scripted FakePi sessions (tests, CI, token-free demos). Unset = real pi by default (auto-detected). Explicitly overrides `SHOWRUNNER_SMOKE`. |
| `SHOWRUNNER_SMOKE` | `=1` forces the REAL pi driver regardless of detection (the capstone smoke). The smoke runs with `SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun test/server/smoke/smoke.ts`. |
| `SHOWRUNNER_PI_BINARY` | path to the pi binary for real runs (default: `pi` on PATH). |
| `SHOWRUNNER_POOL_SIZE` | concurrent run slots (default 2; a paused run keeps its slot). |
| `PI_CODING_AGENT_SESSION_DIR` | session-tree root pi writes to and the backfill reads from (tests point it at a scratch dir). |

`SHOWRUNNER_FAKE` never needs to be set for normal use: the server runs the
real pi binary when one is on PATH, and falls back to the scripted sessions
only on a machine with no pi installed.

## The architecture at a glance

One package, one runtime, one process. The tree mirrors the old five-package
split as plain directories — `src/core`, `src/server`, `src/cli`,
`src/starter-kit`, `src/server/ui` — because the modules are load-bearing, not the
package boundaries (deferred workspaces; there is no publishing
boundary). Cross-directory imports are plain relative imports; there is a
single tsconfig, a single node_modules, a single cwd.

- **`src/core`** — the SDK: blueprint/agent/envelope/gate types, the FakePi
  harness, and the run-loop skeleton. No pi, no SQLite.
- **`src/server`** — the long-lived server: owns SQLite (the write path),
  spawns pi, folds the raw stream into events (tracer), runs the envelope
  and gate stages, the pause/control surface, and the merged web server
  (`src/server/transport/http.ts`): ONE TCP listener on `127.0.0.1:44100` serving the
  JSON API under `/api/*` AND the remix@next dashboard in-process.
- **`src/cli`** — `showrunner`: a thin typed client over the server's HTTP API.
- **`src/starter-kit`** — the replace-this content (agents, gates, blueprints, skills, poll tool).
- **`src/server/ui`** — the remix@next dashboard (served by the server via `src/server/transport/http.ts`; `showrunner dev` — equivalently `bun src/cli/index.ts dev` / `bun hmr` — runs remix HMR for UI dev, and `bun --watch src/server/main.ts` boots the whole server in-process with `--watch` reload).

## Docs

- [CONTEXT.md](./CONTEXT.md) — glossary / ubiquitous language
- [docs/implementation-record.md](./docs/implementation-record.md) — build
  history + known limitations (the `docs/spec/` contract was removed — it had
  drifted; this README and the implementation record are the living docs)
- [docs/diagrams/run-loop.md](./docs/diagrams/run-loop.md) — the run lifecycle

## Development

```bash
bun test                              # the full suite (FakePi; no pi binary, no tokens)
bunx tsc --noEmit   # one package, one typecheck
SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun test/server/smoke/smoke.ts
                                      # the capstone smoke: real pi, real repo, real tokens (T13)
```

### The UI dev loop

`showrunner dev` is THE loop for UI work. It runs remix's built-in HMR (the
proxy chain in `src/server/hmr.ts`) with `NODE_ENV=development`, so accepted edits
under `src/server/ui/**` hot-swap **in place** with no process restart:

```bash
showrunner dev                         # or: bun src/cli/index.ts dev
showrunner dev --port 45000            # override the proxy port (default 44100)
```

Two paths, depending on whether a run is in flight:

- **`showrunner dev` (remix HMR) — the fast UI loop.** Most `src/server/ui/**` edits
  hot-swap with no restart. The catch: edits remix cannot hot-accept (typically
  server-only module changes) make it **restart the child server**, and a server
  restart flips in-flight runs to `interrupted`. Interrupted runs are
  recoverable — `showrunner resume <run_id>` relaunches the phase — so this is a
  documented tradeoff, not data loss (see `src/server/main.ts`). Use `dev` when no
  run is in flight, or when you can afford to resume.
- **Plain `showrunner server` — never interrupts a run.** The plain server never
  restarts on a UI edit, so an in-flight run keeps going untouched. Because
  `NODE_ENV` is unset, its AssetServer watches and serves non-fingerprinted
  assets `no-cache`, so **client-component edits** (e.g.
  `src/server/ui/public/timeline.tsx`) show up on reload. What it does NOT pick
  up without a restart is the **server-rendered HTML** (the module-cached router
  graph in `src/server/transport/http.ts`). So to edit UI while a run is in progress: use
  the plain server — the run survives, client edits refresh on reload, and
  server-rendered HTML lands on the next restart.

Production (`NODE_ENV=production`) behavior is unchanged: no hot reload.

The underlying scripts are equivalent to `showrunner dev`:

```bash
bun hmr                                # what `showrunner dev` runs (hmr.ts spawns server.ts as its HMR child)
bun --watch src/server/main.ts           # server + dashboard, --watch reload (restarts on every edit → interrupts runs)
bun --watch src/server/main.ts       # same server, no UI dev reload
```
