# wire-contract

> GitHub-issue-ready. Title: **One shared wire contract module — server, client, and UI import the same shapes**

## Goal

Make the API's wire shapes a single typed module that `server.ts` (producer),
`client.ts`, and the UI all import — the compiler, not `contract.test.ts`,
enforces conformance. Every `Record<string, unknown>` return and `as unknown as`
bridge dies.

## Blockers

- **None** — this is the foundation ticket. It unblocks `timeline-home` (02) and
  `controller-aggregation` (07).

## Files

- `src/daemon/contract.ts` — **new**: the contract (shapes + `ApiError`).
- `src/daemon/server.ts` — producer becomes typed; the duplicated `ApiError`
  (74–83) and the `TimelineSegmentShape`/`TimelineSegmentOutcome` shadows
  (158–171) are deleted.
- `src/daemon/client.ts` — declarations (19–153) move out; re-exports keep the
  CLI compiling unchanged.
- `src/daemon/index.ts` — `ApiError` + contract types join the public surface.
- `src/ui/app/lib/daemon.ts` — the 13+ casts (54,59,64,69,74,81,94,105,110,115,
  120,133,138) and the structural `isApiError` (148) die; wrappers become
  pass-throughs.
- UI type-import churn: `run-live-region.tsx`, `timeline-panel.tsx`,
  `timeline-model.ts`, `run-detail-page.tsx`, `run-list-page.tsx`,
  `drill-in-page.tsx`, `output-card.tsx` (type-only imports → `contract.ts`).
- Tests: `test/daemon/contract.test.ts`, `test/daemon/timeline.test.ts`
  (`server.test.ts` stays — raw JSON probes).

## Steps

1. **Create `src/daemon/contract.ts`.** Imports only `./db.ts` (row types) and
   `../core/index.ts` (type-only) — never `server.ts`/`client.ts`, so no cycle
   and the server→client import ban is untouched. Contents (moved verbatim from
   client.ts:31–153 + server.ts:74–83):

   ```ts
   export class ApiError extends Error { /* verbatim from server.ts:74-83 */ }
   export interface RunListItem extends RunRow { spend_usd: number; queue_position: number | null; phase_counts: Record<string, number>; }
   export interface PhaseSummary extends PhaseRow { estimated_spend_usd: number; }
   export interface RunDetail { run: RunRow; spend_usd: number; estimated_spend_usd: number; envelope_count: number; phases: PhaseSummary[]; sessions: AgentSessionRow[]; event_count: number; }
   export interface EventsPage { events: EventRow[]; next_cursor: number; }
   export interface PhaseEnvelopes { run_id: string; phase: string; phase_id: string; envelopes: EnvelopeRow[]; }
   export interface PhaseGates { run_id: string; phase: string; phase_id: string; gates: GateResultWithOverride[]; }
   export interface SpendBreakdown { /* as client.ts:75-80 */ }
   export type SegmentCause = PhaseStartCause;   // core's zod type, structurally identical to client.ts:86-89
   export interface TimelineSegment { visit: number; started_at: string; ended_at: string | null; outcome: "in_progress"|"success"|"failed"|"skipped"|"interrupted"; corrections: number; envelope_attempts: number; cause: SegmentCause | null; }
   export interface TimelinePhase { /* as client.ts:91-99 */ }
   export interface TimelineView { run_id: string; blueprint: string; status: RunStatus; needs_review: boolean; started_at: string; ended_at: string | null; phases: TimelinePhase[]; }
   export interface RawTail { run_id: string; raw: string; line_count: number; truncated: boolean; }
   export interface PauseView { /* as client.ts:130-137 */ }
   export interface DaemonStatus { ok: boolean; pid: number; data_dir: string; uptime_ms: number; pool: { slots: number; running: string[]; queued: string[] }; runs: Record<string, number>; }
   export interface SubmitRunResult { run_id: string; queue_position: number | null; blueprint?: string; phase_id?: string; agent_session_id?: string; fixture?: string; }
   export interface ControlResult { run_id: string; ok: boolean; status: string; needs_review?: number; queued_steers?: number; message?: string; verb?: string; }
   export type SubmitRunBody = { blueprint: string; cwd?: string; args?: string[] } | { fixture: string; cwd?: string; delayMs?: number; agent?: string; model?: string; phase?: string };
   export interface SteerBody { message: string; by?: string; }
   export interface EventsQuery { cursor?: number; limit?: number; }
   export interface RawQuery { lines?: number; }
   ```

2. **`src/daemon/server.ts`.** Import `ApiError` + types from `./contract.ts`;
   delete the duplicated class and its "same shape" comment; re-`export { ApiError }`
   so `index.ts`'s re-export keeps working. Delete `TimelineSegmentShape`
   (161–171) and `TimelineSegmentOutcome` (158) — `foldPhaseSegments` returns
   `TimelineSegment[]`, `phaseEndOutcome` returns `TimelineSegment["outcome"]`.
   Change the 15 `Record<string, unknown>` return annotations (apiStatus:127,
   apiRunDetail:230, apiSpend:251, apiTimeline:315, apiPhaseEnvelopes:624,
   apiPhaseGates:636, apiRaw:658, apiPause:676, seven control verbs:709–845) to
   `DaemonStatus`, `RunDetail`, `SpendBreakdown`, `TimelineView`, `PhaseEnvelopes`,
   `PhaseGates`, `RawTail`, `PauseView`, `ControlResult`; `apiListRuns` →
   `{ runs: RunListItem[] }`, `apiEvents` → `EventsPage`. The `needs_review:
   run.needs_review !== 0` conversion at :323 stays — now compiler-verified
   against `TimelineView.needs_review: boolean`. **Keep `body:
   Record<string, unknown>` parameters as-is** — the server validates untrusted
   JSON; typed bodies are the client's promise, not the server's trust. No
   behavior change anywhere.

3. **`src/daemon/client.ts`.** Delete the local declarations (19–153) and local
   `ApiError` (20–28); `export { ApiError }` and `export type { ... } from
   "./contract.ts"` so `cli/index.ts`, `cli/daemon-lifecycle.ts`, `cli/watch.ts`
   compile **unchanged**. `DaemonClient` method signatures stay, sourced from the
   contract.

4. **`src/daemon/index.ts`.** Repoint the `ApiError` export to `./contract.ts`;
   add contract types to the public surface.

5. **`src/ui/app/lib/daemon.ts`.** Import types from `../../../daemon/contract.ts`.
   Every wrapper becomes a cast-free pass-through (`return apiRunDetail(
   requireWebState(), runId);`); all 13 `as unknown as` and the `as {
   runs: RunListItem[] }` at :49 die. `isApiError` becomes `err instanceof
   ApiError` — one class, and in-process calls throw the real one.

6. **UI files.** Point type-only imports at `contract.ts` (the `Serializable*`
   boundary intersections in run-live-region.tsx:20–23 stay — they widen, they
   don't duplicate).

## Tests

- `contract.test.ts`: replace the anonymous probe casts (`as { run: { status:
  string } }`, etc.) with contract types (`as RunDetail`, `as TimelineView`, …).
  Add type-level pins (enforced by `tsc --noEmit`): `Equal<ReturnType<typeof
  apiTimeline>, TimelineView>`, `Equal<Awaited<ReturnType<DaemonClient[
  "getTimeline"]>>, TimelineView>`, `Equal<TimelineView["needs_review"], boolean>`
  (standard `Equal<A,B>` helper), plus a runtime pin that server and client
  re-export the SAME `ApiError` class. Keep all existing HTTP assertions.
- `timeline.test.ts`: line 156's `as unknown as TimelineView` becomes a plain
  return.

```sh
bun test test/daemon/contract.test.ts test/daemon/server.test.ts test/daemon/timeline.test.ts test/daemon/dashboard.test.ts
bun test test/
```

## Verification

- `tsc --noEmit` — the primary gate; conformance is now compile-time.
- The four suites above, then the full suite as safety net.
- `grep -c "as unknown as" src/ui/app/lib/daemon.ts` → 0.
- `grep -c "Record<string, unknown>" src/daemon/server.ts` → only `readBody`
  plumbing.

## Open decisions / risks

- **contract in daemon vs core**: chosen `src/daemon/contract.ts` — the shapes
  embed `db.ts` row types; core is the SDK and must stay SQLite-free. Revisit
  only if the CLI needs the contract without the daemon package (it re-exports
  via `daemon/index.ts`).
- **`needs_review` asymmetry**: `TimelineView.needs_review: boolean` vs
  `ControlResult.needs_review?: number` (resume returns `1`, server.ts:811) is
  the actual wire; the contract records it honestly. Normalizing is a separate
  wire-change ticket.
- **Must not break**: server never imports client; UI never opens SQLite;
  the browser `Serializable*` boundary; the `{error: message}` JSON error wire;
  the `daemon/index.ts` public surface; `erasableSyntaxOnly` (no parameter
  properties in `ApiError` — keep the explicit-assignment constructor).
