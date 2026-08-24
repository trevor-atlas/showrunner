# Showrunner — Specification

The technical implementation contract for Showrunner: what was built, how the pieces talk, and what the data looks like. The design intent and vocabulary live in [CONTEXT.md](../../CONTEXT.md) (the glossary); this specification is the implementation-level contract, split by subsystem.

> **Status**: implemented — this spec describes the shipped system; the code is the truth, and corrections belong in a PR.
> **Conventions**: code-first types, envelope contract owned by the phase. "Session" always means a pi session; the schema's top-level table is `runs`.
> **Section numbers are global and stable across every file in this directory** — "§8.1" means the same thing in any doc here, and all cross-references between files use them. The section map below is the authoritative §→file index.
> **Verification**: the pi-harness facts (§7, §8, §11, §12, Appendix A) were verified against the local pi 0.84.2 installation; see [08-verification-record.md](08-verification-record.md).

> **⚠️ The UI is `remix@next` — NOT a React project.** No React anywhere in this repo. Read [05-ui-dashboard.md](05-ui-dashboard.md) (incl. the mandatory guide list in its §16.2) before touching `src/ui`; past agents assumed React and produced wrong code. remix@next provides the entire web stack for the dashboard (§16.3).

## Reading order

1. [01-overview.md](01-overview.md) — goals, architecture, data path (§1–§2)
2. [02-core-sdk.md](02-core-sdk.md) — `src/core`: types, run loop, hooks (§3, §5, §14)
3. [03-data-and-events.md](03-data-and-events.md) — SQLite schema, event taxonomy, tracer, raw records (§4, §6, §7, §10)
4. [04-daemon.md](04-daemon.md) — spawning pi, handoff, cost, crash, daemon API (§8, §9, §11, §12, §13)
5. [05-ui-dashboard.md](05-ui-dashboard.md) — the remix@next dashboard (§16)
6. [06-starter-kit.md](06-starter-kit.md) — six agents, gates library, skill files (§15)
7. [07-testing-and-rollout.md](07-testing-and-rollout.md) — tests (§17), build history & resolved edge cases (§18)
8. [08-verification-record.md](08-verification-record.md) — pi verification record (Appendix A)

## Section map

| sections | file | package |
|---|---|---|
| §1–§2 | [01-overview.md](01-overview.md) | — |
| §3, §5, §14 | [02-core-sdk.md](02-core-sdk.md) | `src/core` |
| §4, §6, §7, §10 | [03-data-and-events.md](03-data-and-events.md) | `src/daemon` (data layer) |
| §8, §9, §11, §12, §13 | [04-daemon.md](04-daemon.md) | `src/daemon` |
| §16 | [05-ui-dashboard.md](05-ui-dashboard.md) | `src/ui` |
| §15 | [06-starter-kit.md](06-starter-kit.md) | `src/starter-kit` |
| §17–§18 | [07-testing-and-rollout.md](07-testing-and-rollout.md) | — |
| Appendix A | [08-verification-record.md](08-verification-record.md) | — |

## Related docs

- [CONTEXT.md](../../CONTEXT.md) — glossary / ubiquitous language
- [docs/implementation-record.md](../implementation-record.md) — build history + known limitations
- [docs/diagrams/run-loop.md](../diagrams/run-loop.md) — the run lifecycle
