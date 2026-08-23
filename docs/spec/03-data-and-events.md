# Showrunner — Specification · Data & events

> Part of the [Showrunner specification](README.md) — sections §4, §6, §7, §10
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 4 · SQLite schema (daemon-owned)

### 4.1 File & pragmas

- DB file: `{data_dir}/showrunner.db`. `data_dir` defaults to `~/.showrunner`, overridable by env `SHOWRUNNER_DATA_DIR`.
- WAL mode, `synchronous = NORMAL`, `journal_mode = WAL`, `foreign_keys = ON`.
- All writes from the daemon's single writer connection. Readers open separate read-only connections (CLI, UI, `tail`).

### 4.2 Seven tables

```sql
CREATE TABLE runs (
  id            TEXT PRIMARY KEY,
  blueprint     TEXT NOT NULL,
  status        TEXT NOT NULL,            -- running|paused|success|failed|interrupted
  cwd           TEXT NOT NULL,
  needs_review  INTEGER NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE phases (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  name          TEXT NOT NULL,
  agent         TEXT NOT NULL,
  status        TEXT NOT NULL,            -- pending|in_progress|success|failed|skipped
  visits        INTEGER NOT NULL DEFAULT 0,
  corrections   INTEGER NOT NULL DEFAULT 0,
  budget        INTEGER NOT NULL,
  spend_usd     REAL NOT NULL DEFAULT 0,
  started_at    TEXT,
  ended_at      TEXT
);

CREATE TABLE events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,  -- rowid is the cursor
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT REFERENCES phases(id),
  agent_session_id TEXT REFERENCES agent_sessions(id),
  type          TEXT NOT NULL,            -- §5 taxonomy
  ts            TEXT NOT NULL,            -- ISO-8601, daemon wall clock
  data          TEXT NOT NULL             -- JSON payload; shape by type
);
CREATE INDEX idx_events_run_rowid ON events(run_id, id);

CREATE TABLE envelopes (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT NOT NULL REFERENCES phases(id),
  visit         INTEGER NOT NULL,
  attempt       INTEGER NOT NULL,         -- 0..budget (0 = first successful parse)
  json          TEXT NOT NULL,            -- the validated envelope, verbatim
  source        TEXT NOT NULL,            -- file path of envelope.json (§10)
  validated_at  TEXT NOT NULL
);

CREATE TABLE gate_results (
  id            TEXT PRIMARY KEY,
  envelope_id   TEXT NOT NULL REFERENCES envelopes(id),
  gate          TEXT NOT NULL,            -- gate name
  pass          INTEGER NOT NULL,
  violations    TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  ran_at        TEXT NOT NULL
);

CREATE TABLE agent_sessions (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id),
  phase_id      TEXT NOT NULL REFERENCES phases(id),
  pi_session_id TEXT NOT NULL,
  visit         INTEGER NOT NULL,
  pid           INTEGER NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE processes (
  id            TEXT PRIMARY KEY,         -- run_id or agent_session_id
  pid           INTEGER NOT NULL,
  kind          TEXT NOT NULL,            -- 'run' | 'agent'
  started_at    TEXT NOT NULL
);
```

**Why `events.id` is `INTEGER PRIMARY KEY`**: SQLite aliases that to `rowid`; the cursor query (`where rowid > ? … limit 500`) is an index scan on `(run_id, id)`. Append-only, never updated, never deleted — events are an audit log.

### 4.3 The cursor read contract

```sql
select * from events where run_id = ? and rowid > ? order by rowid limit 500;
```

- Client keeps `last_rowid`; polls at its own cadence (CLI: 500ms; UI: SSE/remix loader at 1s).
- No backfill, no replay, no ingest endpoint. `tail` and `sqlite3` are equally valid readers.
- The **UI live view is the same query as full history** — only the cadence differs.

### 4.4 WAL rationale

- Writers (daemon) and readers (CLI, UI) never block each other.
- The cursor query runs on a read snapshot that cannot see torn writes.
- Backup/copy of the `.db` file is safe while the daemon runs (WAL checkpoint semantics).



---

## 6 · Event taxonomy

PLAN §3.3 leaves the count as "ten harness event types (final enumeration at implementation)" — this section is that final enumeration, resolving the placeholder. Every event row: `{ id, run_id, phase_id, agent_session_id, type, ts, data }`.

| # | type | emitted when | data (JSON) |
|---|---|---|---|
| 1 | `run_submitted` | run accepted by daemon | `{ blueprint, cwd }` |
| 2 | `run_status` | run-level status change | `{ from, to, reason? }` |
| 3 | `phase_start` | phase begins (after approval, before spawn) | `{ phase, agent, visit, budget }` |
| 4 | `phase_end` | phase terminal | `{ phase, status, visits, corrections, spend_usd }` |
| 5 | `agent_start` | pi subprocess spawned | `{ agent, pi_session_id, pid, model }` |
| 6 | `agent_end` | pi reports the phase's agent fully settled (`agent_settled`; pi's per-run `agent_end` events are folded, §7.4) | `{ agent, pi_session_id, exit, ok }` |
| 7 | `tool_call` | **one** row per real tool call (folding, §7.2) | `{ tool, tool_call_id, args, result_snippet, ok, duration_ms, agent }` |
| 8 | `envelope` | envelope accepted (valid + gates passed or overridden) | `{ phase, visit, attempt, valid }` |
| 9 | `gate_result` | each gate run | `{ gate, pass, violations[] }` |
| 10 | `correction` | a correction is issued | `{ phase, visit, reason, message }` |
| 11 | `human_action` | steer / approve / override / restart / fail | `{ action, by?, detail }` |
| 12 | `spend` | usage deltas folded from pi message/turn usage fields (§7.3) | `{ phase, tokens_in, tokens_out, cache_read, cache_write, usd }` |

(PLAN's "ten" was an approximation; the categories it names — run/phase lifecycle, agent lifecycle, tool calls, envelopes, gate results, corrections, human actions, spend — map onto the twelve concrete types above. `tool_call`, `envelope`, `gate_result`, `spend`, and `human_action` derive from raw pi events + daemon logic rather than being raw pi events themselves; see §7.)

**Naming rule for `tool_call`**: name the row the way you'd read it aloud — `bash: ls -la src`, `edit: src/core/src/index.ts`. The `data` row keeps the structured `{tool, tool_call_id, args, result_snippet, ok, duration_ms, agent}`.



---

## 7 · The tracer: from raw pi JSONL to folded events

### 7.1 Raw stream

The daemon owns the child's stdout read loop. Verified against pi 0.84.2:

- **Pure protocol channel**: in `--mode rpc` pi reroutes any stray `console.log`/`process.stdout.write` to stderr (`takeOverStdout`), so stdout carries only JSONL. Diagnostics live on stderr — the daemon captures stderr per run for crash debugging.
- **Framing is LF-only**: "Clients must split records on `\n` only" — Node's `readline` is explicitly non-compliant; the tracer must split on `\n` itself.
- **Backpressure is mandatory**: pi awaits stdout backpressure before processing further commands — a daemon that stops draining stdout stalls the agent. The read loop must never block on SQLite; the raw file (§10) is the safe buffer.
- Every raw line is appended verbatim to `raw_output.jsonl` *before* parsing (§10) — the folded DB events are the queryable mirror; the raw file is the record of truth.

Raw event types (pi's `AgentEvent` union, from the pi source): `agent_start`, `agent_end` (with `messages`, `willRetry`), `turn_start`, `turn_end` (`message`, `toolResults`), `message_start` / `message_update` / `message_end` (role lives on `message.role` — there is no separate `user_message`/`assistant_message` event), `tool_execution_start` / `tool_execution_update` / `tool_execution_end`, plus machinery events (§7.4).

### 7.2 Tool-call folding

pi announces one tool call across three raw events; exact fields (verified): `tool_execution_start {toolCallId, toolName, args}`, `tool_execution_update {toolCallId, toolName, args, partialResult}`, `tool_execution_end {toolCallId, toolName, result, isError}`.

| raw → folded | rule |
|---|---|
| `start` | open a call keyed by `toolCallId`; record `toolName`, `args`, wall-clock `ts` |
| `update` | **replace** the pending call's snippet with `partialResult` (it is the *accumulated* output, not a delta); cap stored text (default 4 KB) |
| `end` | close: `ok = !isError`, `result_snippet` from `result.content`, `duration_ms = ts(end) − ts(start)` — pi emits **no duration**; the tracer timestamps on receipt |

- `tool_execution_update` fires only when the tool calls its `onUpdate` callback (bash streams it). `partialResult.content` / `result.content` are arrays of `{type: "text", text}` blocks — join the `text` fields for the snippet.
- Calls that never emit `end` (mid-tool-call death) are flushed as `ok: false` with `truncated: true` when the process dies.
- `toolCallId` is the join key. A missing id falls back to `(toolName, start_ts)` (should not occur — pi always emits it).

### 7.3 Usage folding

There is **no standalone `usage` event type** (verified). Usage is a field:

- `message_update.usage` — the latest *cumulative* provider-reported usage per streaming update (`{input, output, cacheRead, cacheWrite, totalTokens, cost{…}}`); may stay zero until completion for providers that do not report during streaming. (0.84.2 fixed a bug that dropped cumulative usage during streaming.)
- `message_end.message.usage` / `turn_end.message.usage` / `agent_end.messages[*].usage` — the authoritative per-message numbers, persisted on every assistant message.
- **pi reports cost in dollars directly** (`Usage.cost.total`), so spend does not depend on a price roster.
- `get_session_stats` (RPC) returns the whole-session aggregate `{tokens{…}, cost, …}` (§8.4).

The tracer snapshots usage at each `message_end`/`turn_end` and diffs per (phase, visit) into `spend` deltas (event type 12): `{tokens_in, tokens_out, cache_read, cache_write, usd}`. `usd` comes from pi's reported `cost` when present; the local roster (§11.1) is only the fallback/estimate path.

### 7.4 Machinery events are recorded, not folded

`compaction_*`, `auto_retry_*`, `summarization_retry_*`, `queue_update`, `bash_execution_update`, `entry_appended`, `session_info_changed`, `thinking_level_changed`, `extension_error` are pi's session machinery — written to `raw_output.jsonl` and mirrored as opaque `data` rows only if debugging demands it; they never become harness event types. `agent_end` with `willRetry: true` means a low-level run will retry; the phase is not done until `agent_settled` arrives (it fires only when no automatic retry, compaction retry, or queued continuation remains).



---

## 10 · Raw record files

Per run, under `{data_dir}/runs/<run_id>/`:

| file | contents |
|---|---|
| `raw_output.jsonl` | every raw pi JSONL line, verbatim, appended by the tracer |
| `envelope.json` | the last accepted envelope (validated + gates-passed), verbatim |
| `agent_map.json` | `{ phase → { pi_session_id, pid, visit, model } }` — enough to rebuild DB state |

These files are the raw record; the DB is the queryable mirror. Rebuilding the DB from files is possible but not automatic (deferred).



