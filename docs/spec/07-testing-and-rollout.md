# Showrunner — Specification · Testing & rollout

> Part of the [Showrunner specification](README.md) — sections §17–§19
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 17 · Test strategy

- **`FakePi`** (`src/core/test/` — no pi dependency): replays scripted raw-JSONL event streams (retry, gate-fail, blocked, crash scenarios) against the daemon/tracer/gates/DB/resume paths. Deterministic, CI-safe, no tokens. Fixtures are the test surface for the hard parts.
- **Real smokes** (env-gated, opt-in via `SHOWRUNNER_SMOKE=1`): `plan → build` on a tiny repo, proving the pi wiring actually works.
- **Fixtures vs smokes doctrine** (PLAN §14): fixtures prove *our* machinery; smokes prove *the wiring*. Starter content ships tests as a replaceable surface — "the tests it ships are not your tests."



---

## 18 · Implementation order

1. `src/core` — zod types, run-loop skeleton, `FakePi` + first fixtures. No pi dependency.
2. `src/daemon` — schema (§4), spawn/tail (verified §8), tracer folding (§7), envelope/gate runner, corrections, pause menu, resume.
3. `src/cli` — submit, watch (cursor poll), steer.
4. `src/ui` — remix@next (read guides.remix.run first, §16.2; NOT React): run list → gantt → drill-in → controls.
5. `src/starter-kit` — six agents, gates library, polling tool, skill files.
6. ADR-0003 candidates (daemon topology; context-as-strings) as decisions harden in code.

**Gate for step 2**: the §8/§7 facts are already verified (Appendix A); if the daemon is built against a different pi version, re-run the Appendix A checks against that version first.



---

## 19 · Open questions & edge cases (implementation-time)

- **Mid-tool-call crash**: half-committed transcript (pi appends at `message_end`) → `needs_review` flag; resumed runs flagged for a human glance. Exact flush semantics of the tracer on child death (§7.2) pinned against the raw stream in step 2.
- **Literal-vs-path collision**: literal context string matching a real filepath is read as a file; no escape syntax until needed.
- **Price roster as fallback**: pi reports dollar cost directly; the roster is only for providers whose `cost` is zero/absent — `usd: null` until filled; values replaceable by design.
- **`on_fail` + loop guard**: the guard counts every visit, so cycles always terminate or pause (PLAN §18) — needs a fixture test proving a 2-phase cycle with `max_visits: 3` pauses at 3 visits.
- **Gate crashes**: treated as violations (error text as the violation), never daemon crashes (§5.5).
- **`needs_review` semantics**: what exactly flags it (mid-tool-call death only? any resume from `interrupted`?) — pin in step 2.
- **Backpressure**: the tracer's stdout read loop must never block on SQLite or gate execution — the raw file is the safe buffer (§7.1); a slow gate must not stall the agent.
- **`message_update` delta-only shape** (0.84.1+): the tracer must not assume `message_update` carries a cumulative `message`; authoritative content lives on `message_end`/`turn_end`.
- **RPC process lifetime**: one pi process per visit, or one per phase with `prompt` for corrections? Corrections reuse the same `--session-id`; v1 keeps one process per visit (clean PID accounting, simple `processes` tracking) and pays the startup cost per visit — re-evaluate if startup latency dominates.



