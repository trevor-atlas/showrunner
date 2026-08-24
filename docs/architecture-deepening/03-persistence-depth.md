# persistence-depth

> GitHub-issue-ready. Title: **db.ts absorbs the stray SQL — zero raw queries outside the persistence module**

## Goal

Make `db.ts` the single owner of every SQL statement in the daemon, so
`server.ts`, `runner.ts`, and `pause-control.ts` become pure shaping over one
persistence module. Zero raw `db.query` outside db.ts.

## Blockers

- **No hard blocker.** Recommended to run **after `timeline-home` (#24)** —
  both touch `server.ts`; #24 deletes the fold functions first, so the two diffs
  don't collide in the same functions.
- Unblocks `controller-aggregation` (#29), which moves derivations into the api
  core on top of the deepened persistence module.

## Files

- `src/daemon/db.ts` — add 4 functions + 2 types.
- `src/daemon/index.ts` — re-export the new names (tests import from here).
- `src/daemon/server.ts` — delete `collectTimelineEvents` (:357) and
  `phaseStatusCounts` (:958); shrink `apiRunDetail` (:230), `apiSpend` (:251),
  `apiTimeline` (:315).
- `src/daemon/runner.ts` — delete `findPhaseRow` (:387); fold call sites (:337,
  :705) and the inline failed-gate query (:1073).
- `src/daemon/pause-control.ts` — `resolveGateResultId` (:350) and
  `phaseIdForRun` (:382) use db.ts.
- `src/daemon/envelope-runner.ts` — optional (step 6): its two stray queries
  (:276, :319).
- `test/daemon/db.test.ts` — grows; the other six suites stay byte-identical.

## Steps

1. **db.ts.** Add, using the existing `q()` helper and row-shape style (no new
   connections):

   ```ts
   // moved verbatim from server.ts:958 (keeps the `total` key — server.test.ts:186 pins it)
   export function phaseStatusCounts(db: Database, runId: string): Record<string, number>
   // cursor sweep from server.ts:357; stacks on CURSOR_SQL/cursorEvents (:397) so the
   // §4.3 pinned text (db.test.ts:129, contract.test.ts:212) is untouched
   export function sweepRunEvents(db: Database, runId: string, batchSize = 500): EventRow[]
   // merges runner.ts:1073 + pause-control.ts:352 (id + gate serves both callers)
   export interface FailedGateRow { id: string; gate: string }
   export function listFailedGateResults(db: Database, envelopeId: string): FailedGateRow[]
   // ONE per-phase spend shape for the three §13 surfaces
   export type PhaseSpendRow = PhaseRow & { estimated_spend_usd: number }
   export function listPhaseSpend(db: Database, runId: string): PhaseSpendRow[]
   // body: sumEstimatedPhaseSpend(db, runId) mapped onto listPhases(db, runId)
   ```

2. **index.ts.** Add the four functions, `FailedGateRow`, `PhaseSpendRow` to the
   `./db.ts` export blocks.

3. **server.ts.** Delete both local functions; import them from db.ts.
   `apiRunDetail`: replace :235–237/:244 with `const phaseSpend =
   listPhaseSpend(state.db, runId)` → `estimated_spend_usd:
   phaseSpend.reduce((a, r) => a + r.estimated_spend_usd, 0)` and `phases:
   phaseSpend`. `apiSpend`: same reduce; `phases: phaseSpend.map(({ id, name,
   status, spend_usd, estimated_spend_usd }) => ({ id, name, status, spend_usd,
   estimated_spend_usd }))`. `apiTimeline`: `const estimatedByPhase = new
   Map(listPhaseSpend(state.db, runId).map((r) => [r.id,
   r.estimated_spend_usd]))`; keep the `.get(p.id) ?? 0` in the ordered loop
   (:349). `collectTimelineEvents` call (:316) → `sweepRunEvents(state.db,
   runId)`.

4. **runner.ts.** Delete `findPhaseRow` (:387–391). `initState` (:337) and
   `driveVisit` (:705) call `getPhaseByName(db, runId, phase.name)` — already
   exported (db.ts:316), same `LIMIT 1` + nullable semantics; `PhaseRow` carries
   `id`/`visits`/`started_at`. `budgetPauseInfo` (:1073): `info.gateResultIds =
   listFailedGateResults(db, result.lastEnvelopeId).map((r) => r.id)`.

5. **pause-control.ts.** `resolveGateResultId`: `const rows =
   listFailedGateResults(this.state.db, info.envelopeId!)`, keep `.find((r) =>
   r.gate === gate)` and the error message. `phaseIdForRun`: body becomes
   `getPhaseByName(state.db, state.runId, phaseName)?.id ?? null`.

6. **(Optional but recommended) envelope-runner.ts.** `hasGateOverride(db,
   gateResultId): boolean` (:276) and `countUnoverriddenFailedGates(db,
   envelopeId): number` (:319, used by `isEnvelopeApproved`). Completes the
   zero-SQL invariant; split-able without rework.

7. **db.test.ts.** Add: `phaseStatusCounts` groups by status with `total` (seed
   2–3 statuses); `sweepRunEvents` returns all 505 rows in rowid order (reuse
   the cursor test's pattern, db.test.ts:127); `listFailedGateResults` returns
   id+gate for failed only (one pass, one fail); `listPhaseSpend` merges
   reported+estimated (reuse the §11.1 seeds, db.test.ts:186).

**Interface-narrowing result:** db.ts grows by only the interesting queries,
while six raw-SQL sites and three spend-reshape loops disappear from callers;
two duplicate failed-gate shapes collapse into one function, two run+name phase
lookups fold onto the existing `getPhaseByName`, and `listPhaseSpend` replaces
the repeated sum/attach logic.

## Tests

Only `db.test.ts` changes (additions). The rest must pass unchanged —
behavior-identical: `server.test.ts:186` (`phase_counts`), `contract.test.ts:181`
(spend shape), `timeline.test.ts`, `pause-control.test.ts:315` (`gateResultIds`)
+ :317 (override), `runner.test.ts:845+`, `demo-loop.test.ts:404`
(cursor-sweep semantics).

```sh
bun test test/daemon/db.test.ts
bun test test/daemon/server.test.ts test/daemon/runner.test.ts test/daemon/pause-control.test.ts test/daemon/timeline.test.ts test/daemon/contract.test.ts test/daemon/demo-loop.test.ts test/daemon/envelope-runner.test.ts
bun test test/
```

## Verification

- `tsc --noEmit` exits 0.
- All suites above green.
- `grep -n "\.query<" src/daemon` matches only `db.ts`.

## Open decisions / risks

- **WAL one-writer invariant:** all new functions are reads on the existing
  single `Database`; no new connections, no pragma/migration changes
  (`SCHEMA_VERSION` stays 2 — demo-loop.test.ts:418 pins it).
- **Prepared-statement hygiene:** use the `q()` helper in db.ts; the gate is
  the `\.query<` grep, not intent.
- **No server-shaping leak:** `listPhaseSpend` returns rows in phases-table
  order, not the wire shape — `apiTimeline`'s blueprint ordering and `apiSpend`'s
  field-pick stay in server.ts. `phaseStatusCounts` keeps `total` (it is the
  runs-list contract, pinned by server.test.ts).
- **Batch constant:** `sweepRunEvents` defaults to 500, replacing server.ts's
  `MAX_EVENTS_LIMIT` (:73) so the magic number lives in one place.
- Minor: `apiTimeline` reads phases twice via `listPhaseSpend` (once internally)
  — trivial row counts; accept, or add an optional preloaded-phases param later.
