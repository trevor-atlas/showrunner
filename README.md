# Showrunner

An agent orchestration tool: blueprints of phases, each running a configured agent against a local pi harness — observed live, corrected in place, and paused for humans when success cannot be earned.

**Status**: design phase. The full plan is in [PLAN.md](./PLAN.md).

- **Observable** — every event lands in SQLite mid-flight; runs are watched, not read about afterwards.
- **Customizable** — agents and blueprints are typed code; the fix is a small edit in an obvious file.
- **Reusable** — a framework-agnostic core SDK; no part of the system is locked into another.

## Docs

- [PLAN.md](./PLAN.md) — the settled design
- [CONTEXT.md](./CONTEXT.md) — glossary / ubiquitous language
- [docs/adr](./docs/adr/) — architecture decisions
- [docs/diagrams/run-loop.md](./docs/diagrams/run-loop.md) — the run lifecycle

## Status

Not yet implemented. See PLAN.md §17 for the build order.
