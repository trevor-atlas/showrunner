# Showrunner — Specification · Testing & rollout

> Part of the [Showrunner specification](README.md) — section §17
> [index](README.md) · [01-overview](01-overview.md) · [02-core](02-core-sdk.md) · [03-data](03-data-and-events.md) · [04-daemon](04-daemon.md) · [05-ui](05-ui-dashboard.md) · [06-starter](06-starter-kit.md) · [07-tests](07-testing-and-rollout.md) · [08-verify](08-verification-record.md)

## 17 · Test strategy

- **`FakePi`** (`src/core/test/` — no pi dependency): replays scripted raw-JSONL event streams (retry, gate-fail, blocked, crash scenarios) against the daemon/tracer/gates/DB/resume paths. Deterministic, CI-safe, no tokens. Fixtures are the test surface for the hard parts.
- **Real smokes** (env-gated, opt-in via `SHOWRUNNER_SMOKE=1`): `plan → build` on a tiny repo, proving the pi wiring actually works.
- **Fixtures vs smokes doctrine**: fixtures prove *our* machinery; smokes prove *the wiring*. Starter content ships tests as a replaceable surface — "the tests it ships are not your tests."

---

## 18 · Build history & known limitations

The implementation order this spec was built in is history (see
[docs/implementation-record.md](../implementation-record.md)); this spec is
now the contract for the shipped system. Implementation-time edge cases that
stuck as decisions are documented where they live:

- **Mid-tool-call crash** → `needs_review` (§12.5); the tracer's flush-on-death semantics are pinned in code (§7.2).
- **Literal-vs-path collision** → accepted design (§9.2), no escape syntax.
- **Price roster** → fallback only; pi reports dollars directly (§11.1).
- **`on_fail` + loop guard** → guard counts visits, cycles terminate or pause (§5.2), proven by the demo-loop fixture.
- **Gate crashes** → treated as violations, never daemon crashes (§5.5).
- **Backpressure** → the raw file is the safe buffer; the tracer never blocks on SQLite (§7.1).
- **`message_update` delta-only shape** (0.84.1+) → the tracer never assumes cumulative content; authoritative usage/content lives on `message_end`/`turn_end` (§7.3).
- **RPC process lifetime** → one pi process per visit (clean PID accounting, simple `processes` tracking), corrections reuse the same `--session-id` (§8.1).

Known limitations that remain open are listed in the implementation record's
follow-ups section.



