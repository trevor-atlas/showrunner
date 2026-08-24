# Showrunner — Specification · Verification record

> Part of the [Showrunner specification](README.md) — appendix A
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## Appendix A · Verification record (pi 0.84.2)

All `{verify}` markers in this document resolved against the local pi installation (`@earendil-works/pi-coding-agent@0.84.2`, source + docs). Findings:

| question | finding |
|---|---|
| RPC invocation | `pi --mode rpc` (no `--jsonl`/`--output` flags exist); initial prompt must be sent as the first `prompt` command — no CLI/stdin prompt in RPC mode |
| Stream location & framing | stdout is pure JSONL (stray stdout rerouted to stderr); LF-only framing — Node `readline` non-compliant; daemon must drain stdout (backpressure) or the agent stalls |
| Raw event names | `agent_start`, `agent_end` (`messages`, `willRetry`), `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end` (role on `message.role`), `tool_execution_start`/`update`/`end` (`toolCallId, toolName, args[, partialResult | result, isError]`), `agent_settled`, machinery events (§7.4) |
| Steer | `{"type":"steer","message":…}` — queued, delivered after the current turn's tool calls, before the next LLM call; **no message id needed**; `follow_up` and `abort` also exist |
| Session flags | `--session-id <id>` = create-or-continue (id regex `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`); `--session <id>` errors if absent; files at `~/.pi/agent/sessions/--<sanitized-cwd>--/<ts>_<id>.jsonl` (JSONL v3 tree) |
| `--approve` | project trust only (load `.pi` resources); pi has no tool-approval mechanism at all |
| Programmatic access | Three surfaces: in-process SDK (`createAgentSession` — documented primary for Node), `./rpc-entry` (just a `--mode rpc` launcher), `./client` (`RemoteSession` — experimental server protocol, no server shipped). **Decision**: the daemon spawns the pi CLI itself (the spawn+tail+`processes` topology); pi's exported `RpcClient` is the reference for protocol details (id-matching, 30s timeouts, SIGTERM→SIGKILL stop) |
| Usage/cost | No `usage` event type; `message_update.usage` (cumulative) + `message_end`/`turn_end`/`agent_end` message usage; `Usage.cost.total` reports dollars; `get_session_stats` aggregates |
| Completion signal | `agent_settled` (fires when no retry/compaction/continuation remains) is authoritative; `agent_end` per low-level run with `willRetry`; process exits: stdin close→0, SIGTERM→143, SIGHUP→129 |

Remaining open items are design decisions, not unknowns: §19's per-visit vs per-phase process lifetime and `needs_review` flag semantics.

