# Showrunner — Implementation Record

Built across 9 implementation rounds + 2 hardening/fix rounds, ticket-driven (GitHub issues
#1–#20), each round gated by an independent adversarial review. Rollback points: git tags
`round1-t01a` … `round10-audit-label`, one commit per round.

## What shipped (15 tickets, 5 epics)

| Round | Tickets | Delivered |
|---|---|---|
| 1 | T01a (#19) | Workspace scaffold (bun, `packages/*`, file: deps, no workspaces — bun workspaces deferred per §2.2); `packages/core` zod types (Envelope/Agent/Gate/Blueprint, the 12 event types, run/phase/session records), FakePi harness + happy/gate-fail/crash fixtures; `packages/daemon` 7-table WAL schema (migration via `user_version`), LF-only tracer (tool-call folding, usage diffing), backpressure-safe queue, unix-socket server; `packages/cli` run/runs/watch via the rowid cursor poll |
| 2 | T01b (#6) | The §5.2 run loop on FakePi: blueprint import/validate, §13.3 snapshot, prompt composer + zod-schema renderer, envelope-parse/gate-run seam, corrections, `on_fail`, visit guard, §5.4 pool; CLI `show` |
| 3 | T02 (#7) ∥ T03 (#8) | Real pi spawn behind a `SessionDriver` seam (`PiSession` vs byte-compatible `FakeSessionDriver`), RPC layer (id-matched acks, first-prompt timeout), LF-only stdout, SIGTERM→SIGKILL stop, `processes` tracking, `SHOWRUNNER_SMOKE` smoke; envelope/gate machinery: v2 migration (attempt history `valid`/`violations`/`correction`, `gate_overrides`), override audit chain, gate-crash→violation |
| 4 | T04 (#9) ∥ T05 (#10) ∥ T06 (#11) | Pause loop: `RunControl` wait-for-action, all five pause actions (each auditing `human_action`), `needs_review` pin (mid-tool-call death flags at crash; any interrupted-resume re-flags), F1: paused runs keep their pool slot; §9 handoff protocol (`handoff.ts`: literal-vs-path resolution, artifact materialization with traversal guards, accepted-envelope write path, per-visit `agent_map`); cost: `roster.ts` prices.json fallback, `estimated` flag, per-phase/run aggregation |
| 5 | T07 (#12) ∥ T12 (#17) | Crash recovery: resume continuation (same `--session-id`, continue prompt, never re-enters success phases), session-JSONL backfill (dedup vs `raw_output.jsonl`, `/var`→`/private/var` handling), orphan reaping on start, settle-waiter latch (G1); starter kit: six agents, six gates, ten blueprints, ten skills, `poll` pi-extension tool, replace-this structure |
| 6 | T08 (#13) ∥ T13 (#18) | Full §13 HTTP contract + typed `DaemonClient` (socket + `SHOWRUNNER_DAEMON_URL`), cursor/`next_cursor`, `run_submitted` at acceptance + queue position (F2), §14 hooks with `hook_error` failure-pause; hardening capstone: real-pi smoke (steer/override/approve/correction), §19 fixtures (slow-gate backpressure, mid-tool-crash, delta-only `message_update`), 15-item backlog, ADR-0003 ×2, README |
| 7 | T09 (#14) | remix@next dashboard scaffold (3.0.0-beta.10 pinned, ADR-0004; NOT React), typed route map, run list page, StatusPill/EmptyState/DaemonDownBanner, server-side-only daemon access |
| 8 | T10a (#15) ∥ T11 (#16) | Run detail: gantt (blueprint order, now cursor, pause edge), live feed via events.json proxy (1s poll, sliding cursor, SSR-guarded), EventRow ×12 types; the F1 race root-cause fix (pause/abort window); phase drill-in: snapshot config, attempt history, override badges, spend, raw tail |
| 9 | T10b (#20) | Pause menu + control verbs (data-schema validation, no zod in UI, no optimistic mutation, every action in the feed as `human_action`), terminal-freeze, spend pagination |
| 10 | — | Audit label (web overrides record `by: "web"`); capstone re-brief: async gate/hook shell (event loop never blocks — was `spawnSync`), loop termination across `on_fail` (guard reachable), fake-child reaping, smoke exit, `--prompt` pass-through → `[User request]`, starter gates resolve targets with loud violations, quickstart rewritten to demo `scout --prompt --cwd $(mktemp -d)` |

## Verification state (final)

- 267 fixtures green (230 core/daemon/cli/starter-kit + 37 UI), `tsc --noEmit` × 5 packages, no flakes across repeated runs.
- Capstone smoke (real pi 0.84.2, real repo, env-gated): all 4 scenarios — correction on one session, gates, steer, override, approve, crash, backfill, poll tool runtime.
- UI: server-side only, no CORS, no browser→daemon path, NOT-React verified (grep + code read), remix pinned exact.
- All 20 GitHub issues closed with summary comments.

## Pinned decisions (ADR-0003/0004)

- Daemon owns spawn + the SQLite write path (one long-lived process; `processes` table; crash recovery via JSONL backfill).
- Context transfers as strings with a literal-vs-path rule (no escape syntax; collision reads the file).
- remix@next `3.0.0-beta.10` pinned for the dashboard.

## Follow-ups (documented, not blocking)

- `matchesPlan` (starter-kit) has a duplicated identical if/else branch (dead code; starter-kit is the replace-this surface).
- The smoke's poll-tool scenario redirects `PI_CODING_AGENT_SESSION_DIR` for scenarios 1–3 but scenario 4 spawns real pi with inherited env — a session dir can land in `~/.pi/agent/sessions` (cosmetic; outside the repo).
- `needs_review` semantics pinned in code (T04): mid-tool-call death flags at crash; any resume from `interrupted` re-flags; interruption alone does not.
- Spend pagination in the UI caps at 100k events with a visible truncated marker (was silently capped at 5000; T11 review).
- The live region freezes the gantt timeline on terminal transitions (round-8 polish) but does not yet page old events beyond the initial history sweep (10k cap, T10a).
- By-design divergences recorded: steer on a paused run is queued + delivered on continuation (T13 `drainQueuedSteers`), audited `by` defaults to `"cli"` for CLI callers and `"web"` for the dashboard.
