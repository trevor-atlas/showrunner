# Showrunner — Specification · Daemon

> Part of the [Showrunner specification](README.md) — sections §8, §9, §11, §12, §13
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 8 · Spawning pi (daemon)

> Facts verified against the pi 0.84.2 installation (source + docs). Where the plan's assumptions differed, the verified behavior is marked **(verified)** and the difference is called out.

### 8.1 Invocation & session lifecycle

```
spawn("pi", ["--mode", "rpc", "--session-id", <id>, "--approve"], { cwd: run.cwd })
```

- `--mode rpc` — long-lived RPC process: reads JSON commands on stdin, writes JSONL events/responses on stdout, never exits on its own. Terminates when stdin closes (exit 0), on SIGTERM (exit **143**), or SIGHUP (exit **129**).
- **`--session-id <id>` is the create-or-continue flag** (verified: plain `--session <id>` *errors* with exit 1 when the session is not found — the daemon must use `--session-id`). The same id reused across corrections, steering, and resumption keeps the full context window intact (PLAN §6.5). Ids must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`; the daemon derives them like `<run8>_<phase>_v<visit>`.
- **No initial prompt on the command line** (verified): RPC mode ignores positional messages, rejects `@file` args, and skips piped stdin (stdin is the command channel). The daemon must send the composed prompt (§8.2) as the first command: `{"type":"prompt","message":…}` — acknowledged by `{"type":"response","command":"prompt","success":true}`. The model catalog may refresh in the background (15s timeout), so the first command can be slow.
- **`--approve` is project trust, not tool approval** (verified): pi has no permission popups at all; `--approve` merely trusts the project's local `.pi` resources (settings/extensions/skills) for this run. `require_approval` phases remain the *human* approval seam — orthogonal.
- **cwd**: there is no `--cwd` flag (verified); the daemon sets the working directory via the spawn `cwd` option. Config dir via env `PI_CODING_AGENT_DIR`; session dir via `--session-dir` (or `PI_CODING_AGENT_SESSION_DIR`).
- **Never use `--session <id>`** (verified): resolving a session that lives in another project triggers an interactive console prompt ("Fork this session into current directory?") on pi's stdin — fatal for an unattended daemon.

### 8.2 The composed prompt (daemon-rendered)

The daemon renders the initial `prompt` command's message as:

```
[Phase] <blueprint> → <phase>
[Agent] <agent.name> (<agent.model>)

<agent.prompt>
<phase.prompt additions, if any>

[Context]            ← §9 materialization
<context_handoff/<phase>/inputs/…> inlined file contents

[Handoff from previous phase]
<predecessor envelope.json rendered as YAML/JSON + notes_for_next_agent>

[Envelope contract]
<phase.envelope rendered as a zod description — field names, types, examples>
Return your final result as a JSON object matching this schema, written to
context_handoff/<phase>/outputs/envelope.json

[Tools available] <agent.tools>
```

The envelope schema is rendered into the prompt (ADR-0002) so the agent knows what to return; the daemon *reads* the file the agent writes, never trusts the prompt echo.

### 8.3 Completion & crash detection

- **Completion**: `agent_settled` is the authoritative "done" event (verified) — it fires only when no automatic retry, compaction retry, or queued continuation remains. `agent_end` fires per low-level run and carries `willRetry`; a phase is not done on an `agent_end` with `willRetry: true`. The daemon then closes stdin to reap the process (exit 0).
- **Crash**: unexpected process exit — stdout EOF without `agent_settled`, or exit code 143/129/other. `processes` is how a stuck run is found (`ps -p <pid>`), and how "fail run" kills children (SIGTERM, SIGKILL after 1s — the same semantics as pi's bundled `RpcClient.stop()`).
- **Stderr**: real diagnostics (errors, startup warnings, model-catalog noise) go to stderr (verified); the daemon captures it per run for crash debugging.
- Mid-tool-call death → run is marked `needs_review` (§12).

### 8.4 Steering & control commands

Verified RPC command set (JSON objects written to the child's stdin):

| command | payload | effect |
|---|---|---|
| `prompt` | `{"type":"prompt","message":…,"streamingBehavior"?: "steer"\|"followUp"}` | queue/add a message; errors if the agent is streaming and no `streamingBehavior` is given |
| `steer` | `{"type":"steer","message":…}` | **queues the message; delivered after the current turn finishes its tool calls, before the next LLM call** — does not interrupt an in-flight turn, needs **no message id to reply to** (FIFO queue) |
| `follow_up` | `{"type":"follow_up","message":…}` | delivered only when the agent has no more tool calls or steering messages |
| `abort` | `{"type":"abort"}` | abort the current operation (also `abort_bash`, `abort_retry`) |
| `get_state` | `{}` | `{model, isStreaming, isCompacting, sessionFile, sessionId, messageCount, …}` |
| `get_session_stats` | `{}` | whole-session `{tokens{…}, cost, …}` (§7.3) |
| `get_entries` | `{since}` | durable cursor into session history — pass the last seen entry id to backfill after a daemon restart |

Responses: `{"id":<req>,"type":"response","command":…,"success":true|false}` (failures carry `error`). `queue_update` events reflect the pending steering/follow-up queues. The pause menu's **steer** writes a `steer` command to the child's stdin; a steer arriving mid-turn is queued until the turn ends.



---

## 9 · Context & handoff (filesystem protocol)

### 9.1 Workspace layout

All under the run's cwd (the repo being worked on):

```
context_handoff/
  <phase-name>/          # URL-safe slug of the phase name
    inputs/              # what the harness materializes for the agent (read-only)
      envelope.json      # predecessor's envelope, always present for phases > 0
      <artifact>…        # every file the predecessor listed in artifacts
    outputs/             # what the agent writes
      envelope.json      # the agent's typed result (the daemon parses this)
      <artifact>…        # files the agent lists in artifacts
```

### 9.2 Context resolution rule

At spawn, the harness walks each `context` entry (agent defaults, then phase-level additions):

1. Resolve against the run's cwd; fallback: the agent module's dir.
2. If it resolves to a readable file → read and inline its contents into the prompt.
3. Otherwise → treat the string as literal content.

Exact paths only; **no globs**. Collision rule (PLAN §18): a literal string that happens to match a real filepath gets read as a file; no escape syntax until something needs it.

### 9.3 Zero-friction handoff

The predecessor's `envelope.json` and every listed artifact are materialized into `inputs/` automatically — no declaration required. The phase prompt explicitly names the handoff paths so the agent never hunts. Outputs of phase N become inputs of phase N+1 by construction.



---

## 11 · Cost & observability

### 11.1 Spend

- **Primary source**: pi's own reported cost — `Usage.cost.total` on `message_update`/`message_end`/`turn_end` and the `get_session_stats` aggregate (verified: pi reports dollar cost, not just tokens). The tracer diffs per (phase, visit) into `spend` deltas.
- **Roster** (`{data_dir}/prices.json`) is the *fallback/estimate* path for providers whose `cost` comes back zero/absent: `{ model: { in_per_mtok, out_per_mtok } }`, replaceable by design (PLAN §16). Missing model → `usd: null`.
- Aggregations: per message/turn → per phase → per run.
- **The numbers are pi's, not ours**: the roster only fills gaps, and estimated spend is flagged as such in the UI.

### 11.2 Dashboard surfaces (derived from events)

- **Run list**: runs + status + spend.
- **Gantt** (per phase): duration, corrections, visits, spend.
- **Phase drill-in**: agent config used, prompt, token usage, envelope, gate results, simplified output feed "as though we were viewing it in the TUI."



---

## 12 · Crash & recovery

1. Daemon crashes → in-flight pi processes orphan; the `processes` table is how they're found.
2. Runs surface as `interrupted` in the dashboard.
3. Human clicks **continue** → daemon resumes from the last completed phase; the interrupted phase's pi session is relaunched with the same `--session-id` and a continue instruction. **Continuation is real** (verified): pi appends to the session JSONL on every `message_end` and rebuilds the full context on resume (minus anything compaction collapsed). Session files live at `~/.pi/agent/sessions/--<sanitized-cwd>--/<timestamp>_<sessionId>.jsonl` (JSONL v3 tree format; directory overridable via `--session-dir` / `PI_CODING_AGENT_SESSION_DIR`).
4. **Backfill**: after a daemon restart, `get_entries {since: <last-seen-entry-id>}` (or re-reading the session JSONL) restores events the daemon missed — entry ids are durable cursors across restarts.
5. Mid-tool-call deaths can leave a half-committed transcript (pi appends at `message_end`) → the resumed run carries `needs_review = 1` and the UI flags it for a human glance.
6. No auto-resume in v1.



---

## 13 · Daemon API contract

HTTP on **one** local TCP listener: `http://127.0.0.1:44100` (`SHOWRUNNER_PORT` overrides; `0` = ephemeral port, a test seam). The daemon's merged web server (`src/daemon/web.ts`) serves the §13 JSON API **and** the remix@next dashboard on that single listener — there is no unix socket and no transport negotiation. Every API endpoint lives under the **`/api`** prefix (the dashboard's HTML routes own everything else). JSON bodies. The UI/CLI talk only to this API — the UI is a **server-side** client: remix@next actions call the §13 api core functions **in-process** (same process, no socket round trip); the browser never talks to the daemon directly (§16).

### 13.1 Read

| endpoint | returns |
|---|---|
| `GET /api/health` | liveness: `{ ok: true }` (the CLI's daemon-up check) |
| `GET /api/status` | daemon status: data dir, db path, pool occupancy, uptime |
| `GET /api/runs` | run list: id, blueprint, status, started/ended, spend, queue position |
| `GET /api/runs/:id` | run detail: phases (status, visits, corrections, spend), envelope count, needs_review |
| `GET /api/runs/:id/events?cursor=<rowid>&limit=500` | the cursor query (§4.3), plus `next_cursor` |
| `GET /api/runs/:id/pause` | the pause view (menu actions available for a paused run) |
| `GET /api/runs/:id/phases/:phase/envelopes` | envelope history for a phase (all attempts) |
| `GET /api/runs/:id/phases/:phase/gates` | gate results, incl. overridden |
| `GET /api/runs/:id/spend` | per-phase spend breakdown |
| `GET /api/runs/:id/raw` | the `raw_output.jsonl` tail (drill-in feed) |

### 13.2 Control

| endpoint | effect |
|---|---|
| `POST /api/runs` `{ blueprint, cwd?, args? }` | submit a run (queues into pool) |
| `POST /api/runs/:id/steer` `{ message }` | deliver steer to a run (queued between turns, §8.4) |
| `POST /api/runs/:id/resume` | continue from last completed phase (§12) |
| `POST /api/runs/:id/fail` | fail the run; kill children via `processes` (SIGTERM, SIGKILL after 1s) |
| `POST /api/runs/:id/approve` | approve a `require_approval` pause |
| `POST /api/runs/:id/phases/:phase/override` `{ gate, reason }` | override a gate result (audited) |
| `POST /api/runs/:id/phases/:phase/restart-fresh` | new pi session, same config |
| `POST /api/sessions/:pi_session_id/steer` `{ message }` | deliver steer to a raw pi session id (§8.4) |

All control verbs write a `human_action` event. Override keeps the original `gate_results` row and adds an overridden marker.

### 13.3 Blueprint submission

`POST /api/runs` accepts a blueprint **module path** (absolute path to a `.ts` file exporting `defineBlueprint(...)`). The daemon imports it at submit time (validating with zod) and snapshots the *rendered* configuration into the run — later edits to the blueprint do not mutate in-flight runs. The snapshot is stored in `{data_dir}/runs/<run_id>/blueprint.json` (debuggable, and what phase drill-in shows).



