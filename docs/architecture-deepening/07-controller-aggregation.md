# controller-aggregation

> GitHub-issue-ready. Title: **Controllers stop re-implementing domain aggregation — derivations move into the api core**

## Goal

Move every UI-side derivation (cursor sweeps, spend sums, override targets,
workspace reads) into the §13 api core so the controllers become one fixed call
per data surface. This restores the ADR-0003 seam: the UI is again a pure
in-process consumer of the api core.

## Blockers

- **Blocked by `wire-contract` (#23)** — the response shapes widen (`RunDetail`,
  `SpendBreakdown`, `PauseView`, new `PhaseOutputs`) and must be contract types.
- **Blocked by `persistence-depth` (#25)** — the spend-token SUM and
  `sweepEvents` helpers land in the deepened `db.ts`.
- Recommended after `timeline-home` (#24) — same `server.ts` file.

## Files

- `src/daemon/server.ts` — api core gains: `?full=1` on run-detail, spend token
  totals, `override_targets`, new phase-outputs endpoint.
- `src/daemon/db.ts` — `sumSpendTokenTotals`, `listGateNamesByIds`.
- `src/daemon/handoff.ts` — `readOutputsDir` moves here (ported from the UI
  controller).
- `src/daemon/client.ts` — wire shapes widen; new `PhaseOutputs` +
  `DaemonClient.getPhaseOutputs`.
- `src/ui/app/lib/daemon.ts` — `getRunDetail({full})`, `getPhaseOutputs`.
- `src/ui/app/actions/runs/controller.tsx` — sheds sweep + `failedGateNames` +
  re-declared limits.
- `src/ui/app/actions/runs/phases/controller.tsx` — sheds
  `collectSpendEvents`/`sumPhaseSpendTokens`/`readOutputsDir` + `node:fs`
  imports.
- `src/ui/app/actions/runs/phases/drill-in-page.tsx` — drop `truncated` from the
  spend prop.
- Tests: `test/daemon/server.test.ts`, `test/ui/run-controls.test.ts`,
  `test/ui/run-detail.test.ts`, `test/ui/phase-drill-in.test.ts`.

## Steps

1. **api core data (server.ts + db.ts).**
   - `db.ts`: add `sumSpendTokenTotals(db, runId): Map<phase_id,
     {tokens_in,tokens_out,cache_read,cache_write}>` — one
     `SUM(CAST(json_extract(data,'$.tokens_*') AS REAL)) … WHERE type='spend'
     GROUP BY phase_id` (same pattern as `sumEstimatedPhaseSpend`, db.ts:334) —
     and `listGateNamesByIds(db, ids): string[]` (must preserve gate_results
     row order to match `failedGateNames`' dedup semantics).
   - `server.ts`: export `MAX_EVENTS_LIMIT` (:65); extract `sweepEvents(db,
     runId, maxPages?)` from `collectTimelineEvents` (:186) so the timeline
     stays uncapped but the detail sweep can cap at 20 pages.

2. **Richer responses (server.ts). All additive:**
   - `apiRunDetail(state, runId, query?)` — with `?full=1`, response gains
     `events: EventRow[]` and `next_cursor: number` (the 20-page sweep,
     reproducing today's `collectEvents` cursor exactly).
   - `apiSpend` — each `phases[]` entry gains `tokens_in, tokens_out,
     cache_read, cache_write` from the SUM map. No `truncated`: SQL SUM is exact
     — the 100k-event cap dies.
   - `apiPause` — when `actions` includes `override`, add `override_targets:
     string[]` = `listGateNamesByIds(info.gateResultIds)` (deduped, row order);
     `[]` otherwise. `effectiveMenu` (pause-control.ts:96) feeds the menu, so the
     target list rides the same viewer call.
   - New `apiPhaseOutputs(state, runId, phase)` → `{ run_id, phase, phase_id,
     files: string[], findings_md: string | null }`, using `requirePhaseOrThrow`
     (same 404 semantics as envelopes/gates) and a `readOutputsDir` moved into
     `handoff.ts` (ported from phases/controller.tsx:271). Wire
     `GET /runs/:id/phases/:phase/outputs` in `handleApiRequest`.

3. **Wire shapes (client.ts) + UI data layer (lib/daemon.ts).**
   - `RunDetail` gains optional `events?: EventRow[]; next_cursor?: number`;
     `SpendBreakdown` phases gain the four `tokens_*`; `PauseView` gains
     `override_targets?: string[]`; new `PhaseOutputs` interface +
     `DaemonClient.getPhaseOutputs`.
   - `lib/daemon.ts`: `getRunDetail(runId)` calls `apiRunDetail(
     requireWebState(), runId, new URLSearchParams({ full: "1" }))`; add
     `getPhaseOutputs`.

4. **Controllers shed (one call per surface, no loops).**
   - `runs/controller.tsx`: delete `collectEvents`, `EVENTS_PAGE_LIMIT`,
     `MAX_EVENT_PAGES`, `failedGateNames`. `renderRunDetail` reads
     `detail.events`/`detail.next_cursor` from the single detail call; the pause
     block becomes `overrideGates = pause.override_targets ?? []` — the
     conditional second `getPhaseGates` fetch dies. The `events` proxy
     (controller.tsx:126) imports the exported `MAX_EVENTS_LIMIT` instead of
     re-declaring 500.
   - `phases/controller.tsx`: delete `collectSpendEvents`,
     `sumPhaseSpendTokens`, `MAX_EVENT_PAGES`, `readOutputsDir`, and the
     `node:fs` + `outputsDirFor`/`resolveDataDir`/`runDirFor` imports. The
     `Promise.all` (controller.tsx:74) drops `collectSpendEvents(runId)` and
     gains `getPhaseOutputs(runId, phaseName)`; the spend prop reads
     `spendPhase?.tokens_in ?? 0` etc. with `truncated: false` removed.
   - `drill-in-page.tsx`: remove `truncated` from the spend prop (SpendCard
     already defaults it false).

## Tests

- `test/daemon/server.test.ts` grows: spend endpoint returns per-phase token
  totals for the happy fixture; `?full=1` detail returns 13 events +
  `next_cursor: 13` and the flagless response omits them; `apiPhaseOutputs`
  lists `envelope.json` for the demo blueprint, `findings_md` for a written
  FINDINGS.md, 404 for ghost run/phase; pause viewer `override_targets =
  ["neverGreen"]` on a budget pause and absent on approval.
- `test/ui/run-controls.test.ts`: the sweep test keeps its "5,500" SSR assertion
  and adds `expect((await client.getSpend(runId)).phases[0]).toMatchObject({
  tokens_in: 5500 })`; comment rewording only.
- `run-detail.test.ts` / `phase-drill-in.test.ts`: unchanged assertions (SSR DOM
  is byte-identical); they now exercise the api-core totals/outputs path
  implicitly.

```sh
bun test test/daemon/server.test.ts
bun test test/ui/run-detail.test.ts test/ui/run-controls.test.ts test/ui/phase-drill-in.test.ts
bun test test/
```

## Verification

- `tsc --noEmit` clean.
- The four suite commands above green.
- `bun test test/` (~315 fixtures) green with **zero changed existing
  expectations** — any diff to a current assertion means the refactor drifted
  (do-not-regress rule, README of this directory).

## Open decisions / risks

- **Long-run pagination**: the SSR full-history keeps the 20-page/10k cap
  (byte-identical DOM; the live poll continues from `next_cursor`). The spend
  100k cap is simply gone — SQL SUM is exact; `truncated`/"older spend omitted"
  UI dies with it. Payload growth (~10k events in-process) is acceptable; CLI
  callers never pass `?full=1`.
- **Live-region fault coupling** (implementation-record): untouched — the
  per-tick events.json + timeline.json proxies stay; only the SSR sweep moves.
- **Read-only invariant**: `apiPhaseOutputs` reads the run record dir only; the
  daemon stays sole SQLite writer; the UI loses its last fs path past the seam.
- **UI tests**: none mock the api core (verified) — no mock churn; keep the SSR
  DOM identical so the three UI suites pass unchanged.
- Minor: `tokens_*` snake_case on the wire maps to the card's camelCase once in
  the controller; `gateNamesByIds` must preserve gate_results row order to match
  `failedGateNames`' dedup semantics.
