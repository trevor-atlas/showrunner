# timeline-home

> GitHub-issue-ready. Title: **Give the timeline derivation one module — the fold moves out of server.ts**

## Goal

Move the events→segments fold and phase ordering out of the HTTP module into one
daemon-side derivation module (`src/daemon/timeline.ts`) that imports its wire
types verbatim from the wire-contract module, and point every consumer (UI
model, panel, live region) at the same contract.

## Blockers

- **Blocked by `wire-contract` (#23)** — `timeline.ts` imports `TimelineView` /
  `TimelineSegment` / `SegmentCause` from `contract.ts` and cannot compile
  without it.
- Sequencing fallback: if #23 lands after this ticket, this ticket introduces a
  minimal `contract.ts` containing the TimelineView family (01 then grows it).
  Either way `client.ts` must re-export so `DaemonClient.getTimeline`'s type
  never breaks.

## Files

- `src/daemon/timeline.ts` — **new**: the derivation home.
- `src/daemon/contract.ts` — **new, by ticket 01**; this ticket only imports
  from it.
- `src/daemon/server.ts` — `apiTimeline` (:315) shrinks; delete
  `collectTimelineEvents` (:357), `countEnvelopeAttempts` (:375),
  `foldPhaseSegments` (:420), `segmentForVisit` (:493), `phaseEndOutcome`
  (:507), `orderTimelinePhases` (:531), `rowStartTs` (:577),
  `readBlueprintPhaseNames` (:585).
- `src/daemon/client.ts` — re-export the TimelineView family from `contract.ts`
  (`export type { … } from "./contract.ts"`) so `DaemonClient.getTimeline`
  (:298) stays typed.
- `src/ui/app/ui/public/timeline-model.ts` — types from `contract.ts` (:22
  today, points at client.ts); gains `segmentDurationMs`.
- `src/ui/app/ui/public/timeline-panel.tsx` — the `Date.parse` re-derivation
  (:179–180) dies; types from `contract.ts`.
- `src/ui/app/actions/public/run-live-region.tsx` (:4),
  `src/ui/app/actions/runs/run-detail-page.tsx` (:5),
  `src/ui/app/lib/daemon.ts` (:44) — type imports → `contract.ts`.
- Tests: `test/daemon/timeline.test.ts`, `test/daemon/demo-loop.test.ts` (:22),
  `test/ui/timeline-model.test.ts` (:8), `test/ui/run-detail.test.ts`.

## Steps

1. **Create `src/daemon/timeline.ts`.** Move the eight functions from server.ts
   verbatim (byte-identical bodies; only imports change). Internal shape keeps
   `TimelineSegmentShape` with `cause: PhaseStartCause | null` (core) —
   structural typing bridges to the contract's `SegmentCause`. Give the module
   `TIMELINE_EVENTS_PAGE = 500` (server.ts's `MAX_EVENTS_LIMIT` stays for
   `apiEvents`).

2. **Add `buildTimelineView(db, dataDir, run): TimelineView`** — the typed
   assembler: `collectTimelineEvents` + `foldPhaseSegments(run, events,
   countEnvelopeAttempts(db, run.id))` + `orderTimelinePhases(listPhases(db,
   run.id), events, readBlueprintPhaseNames(dataDir, run.id))` +
   `sumEstimatedPhaseSpend` → the exact object `apiTimeline` returns today.

3. **Slim `apiTimeline`** to the 404 check + delegate: `getRun` → `if (!run)
   throw new ApiError(404, …)` → `return buildTimelineView(state.db,
   state.dataDir, run);` — return type becomes `TimelineView`; the `as unknown
   as TimelineView` cast in `ui/app/lib/daemon.ts:74` dies.

4. **Switch consumers to the contract** — timeline-model.ts, timeline-panel.tsx,
   run-live-region.tsx, run-detail-page.tsx, lib/daemon.ts import the TimelineView
   family from `daemon/contract.ts`; client.ts re-exports.

5. **Kill the panel re-derivation.** Add to timeline-model.ts:

   ```ts
   export function segmentDurationMs(segment: TimelineSegment, endFallbackMs = Date.now()): number {
     const endMs = segment.ended_at !== null ? Date.parse(segment.ended_at) : endFallbackMs;
     return Math.max(0, endMs - Date.parse(segment.started_at));
   }
   ```

   `computeTimelineLayout` calls it with its `runEndMs` for open segments (chart
   edge semantics preserved); `VisitBlock` (:179–180) becomes `const durationMs
   = segmentDurationMs(segment);` — one `Date.parse` site, tested in the model.

## Tests

- `test/daemon/timeline.test.ts` **stays** (already colocated with
  `src/daemon/timeline.ts`); only the `TimelineView` import points at
  `contract.ts`. Seeded-SQLite coverage is untouched — it still drives
  `apiTimeline` + `handleApiRequest`, so the endpoint/wire route stays pinned.
- Add direct module-boundary tests in the same file (import from
  `src/daemon/timeline.ts`): unexpected `phase_end` status → `"failed"`;
  dangling `phase_end` with no open segment produces nothing;
  `countEnvelopeAttempts` across phases/visits and empty; per-visit pairing +
  resume collapse re-pinned at the fold's own signature.
- `test/ui/timeline-model.test.ts`: add `segmentDurationMs` cases (closed;
  open → now; now < start → 0).
- `test/daemon/demo-loop.test.ts` (:22) + `test/ui/run-detail.test.ts`:
  import-path-only updates.

```sh
bun test test/daemon/timeline.test.ts test/daemon/demo-loop.test.ts test/ui/timeline-model.test.ts test/ui/run-detail.test.ts
bun test test/
```

## Verification

- `tsc --noEmit` clean.
- The four suites above green — they pin the fold invariants: per-visit
  segments, cause provenance, attempt counts from the `envelopes` table,
  open-segment outcomes.
- Full suite `bun test test/` green.

## Open decisions / risks

- **R7 fallback divergence**: keep first-start ordering (documented at
  server.ts:531's docstring — move it verbatim into the module). Do not unify
  in this ticket; the divergence stays live.
- **Byte-identical fold**: bodies move verbatim; the seeded tests are the guard.
  Only allowed diffs: imports, the typed `buildTimelineView` return,
  `collectTimelineEvents` using `TIMELINE_EVENTS_PAGE`.
- **Panel vs chart open-segment duration**: the panel's "now" semantics and the
  chart's edge-pinned semantics are both preserved through
  `segmentDurationMs`'s `endFallbackMs` parameter — a deliberate, documented
  seam, not a silent unification.
