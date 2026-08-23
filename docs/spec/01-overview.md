# Showrunner — Specification · Overview

> Part of the [Showrunner specification](README.md) — sections §1–§2
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 1 · Goals & non-goals

**Goals**

1. A run is observable while it happens: every event lands in SQLite mid-flight; the dashboard and CLI watch the same event cursor.
2. Agents and blueprints are typed code (zod-validated at runtime, type-checked at compile time) — customization is a small edit in an obvious file.
3. The core SDK (`packages/core`) is framework-agnostic: no pi, no UI, no SQLite dependency in its runtime.
4. A failed agent turn costs one message (a correction), never a cold restart.
5. Loops terminate by construction: budgets (corrections), a guard (`max_visits`), a human (pause menu), or the crash path (manual continue).

**Non-goals (v1)**

- No parallel phases; no branching beyond `on_fail`.
- No auto-resume after daemon crash.
- No cost caps (telemetry only).
- No ingest endpoint / WebSocket / replay path — the cursor query *is* the read transport.
- The dashboard does not spawn runs.



---

## 2 · Architecture overview

### 2.1 Process topology

```
┌──────────────┐   submit/control   ┌─────────────────────┐   spawn + tail   ┌──────────────┐
│  CLI         │ ─────────────────► │  Daemon             │ ───────────────► │  pi agents   │
│  pi skills   │  (HTTP)            │  (owns execution,   │   pi --mode rpc  │  (subprocs)  │
└──────────────┘                    │   SQLite write path,│   JSONL stream   └──────────────┘
                                    │   child PID table)  │
┌──────────────┐   read (cursor)    │                     │
│  Dashboard   │ ◄───────────────── │                     │
│  (remix@next) │                    └─────────────────────┘
└──────────────┘                         │ SQLite (WAL)
                                    ┌────▼──────────────────┐
                                    │  runs/phases/events/  │
                                    │  envelopes/gate_results│
                                    │  agent_sessions/processes│
                                    └───────────────────────┘
```

- **One daemon, long-lived.** It owns: spawning pi, tailing JSONL, the SQLite write path, the control verbs, and the `processes` table (run/session → child PID) so a stuck run can be found and stopped.
- **CLI and pi skill files** submit runs and issue controls. Most runs start from the CLI.
- **Dashboard is read-only plus control verbs** (steer / approve / override / resume / fail). It does not spawn runs.
- **Concurrency**: a configurable pool, default ~2 concurrent runs. The pool gates *spawn*, not events; tailing and DB writes are cheap regardless.

### 2.2 Package layout

Single repo, `packages/*`. No pnpm/nx/turbo; bun workspaces only if `core` ever needs standalone publishing (deferred).

```
packages/core         SDK: blueprint/agent/envelope/gate/run/event types + the run loop.
                      No pi or UI dependencies.
packages/daemon       spawns pi (rpc mode), tails events, owns SQLite, serves the API
packages/cli          submit + watch runs, steer
packages/ui           remix@next dashboard (React-free, single `remix` dependency)
packages/starter-kit  six agents, skill blueprints, shared gates, the polling tool
```

**Dependency rule**: `core ← daemon ← cli`, `core ← daemon ← ui`. Nothing outside `daemon` touches pi's process layer; nothing outside `core` defines what a run *is*.

### 2.3 Data path

```
agents → JSONL (pi --mode rpc) → tracer tails stdout → SQLite (WAL) → readers (sqlite3, tail, poll, UI)
```

- **WAL mode** so readers never block the running writers (see §4.4).
- **One cursor query is the entire read transport**:

  ```sql
  select * from events where run_id = ? and rowid > ? order by rowid limit 500;
  ```

  Live view and full history are the same query at different cadence. There is no ingest endpoint, no WebSocket, no backfill, no separate replay path.
- **Files stay the raw record**: `raw_output.jsonl`, `envelope.json`, `agent_map.json` (see §10). The DB is the queryable mirror; losing it loses nothing that cannot be rebuilt from files.



