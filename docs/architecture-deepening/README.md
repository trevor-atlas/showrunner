# Architecture deepening — implementation tickets

Seven tickets from the architecture review (23 Aug 2026). Each ticket is one
self-contained module deepening: it moves a module's interface or its
implementation so that friction concentrates instead of scattering. They were
planned by independent architect agents and distilled here.

Ticket naming is descriptive (no `T##` prefixes).

## Dependency order

```
independent (any time)          chain (in order)
─────────────────────           ─────────────────
04 harness-home                 01 wire-contract
05 envelope-parse               02 timeline-home
06 settle-recognition           03 persistence-depth
                                07 controller-aggregation
```

- **04, 05, 06** touch disjoint trees (daemon spawn layer / UI parsing / raw-line
  classification) — no ordering constraint, no file overlap with the chain.
- **01 → 02**: the timeline module imports its `TimelineView` contract from the
  wire-contract module, so 01 must land first (or 02 carries a minimal
  `contract.ts`; see ticket 02's open decisions).
- **02 → 03**: both touch `src/daemon/server.ts`; 02 shrinks it (the fold moves
  out) before 03 pushes SQL into `db.ts`, so the two diffs don't collide in the
  same functions.
- **03 → 07**: controller-aggregation moves derivations into the api core that
  rest on 03's deepened persistence module.
- **01 also feeds 07**: typed wire shapes mean the controllers' casts and
  re-declared shapes die with the move.

## Blockers (per ticket, also listed in each ticket file)

| Ticket | Issue | Blocked by | Unblocks |
|---|---|---|---|
| 01 wire-contract | #23 | — | 02, 07 |
| 02 timeline-home | #27 | 01 (imports `TimelineView` from `contract.ts`) | — |
| 03 persistence-depth | #28 | none hard; recommended after 02 (both touch `server.ts`) | 07 |
| 04 harness-home | #24 | — | — |
| 05 envelope-parse | #25 | — | — |
| 06 settle-recognition | #26 | — | — |
| 07 controller-aggregation | #29 | 01 (typed wire), 03 (persistence) | — |

## Suggested batching

- **Batch A (quick, low-risk, unblocks review of the chain):** 04, 05, 06
- **Batch B (the chain):** 01, 02, 03, 07

## Verification per ticket

Every ticket verifies with the same three commands:

```sh
tsc --noEmit
bun test test/                # full suite (~315 fixtures, must stay green)
bun test test/<changed-suite>.test.ts   # targeted suites, per ticket
```

The full suite is the guardrail: these are refactors, so behavior must be
byte-identical; the ~315 fixture tests pin that. If a ticket's diff changes any
existing test expectation, that ticket is wrong — stop and re-check.

## Do-not-regress list (from the implementation record)

- One writer process owns SQLite (ADR-0003) — only the daemon opens the DB.
- CLI never imports `src/daemon/client.ts` internals beyond the client; UI never
  opens SQLite; server never imports the UI.
- `needs_review` semantics, settle-waiter latch (G1), `agent_end` with
  `willRetry` is NOT settled (tracer ).
- R7 timeline invariants: per-visit segments, cause provenance, attempt counts
  folded from the `envelopes` table, open-segment outcomes.
- `bun run gen:fixtures` output must stay byte-identical (harness-home).
