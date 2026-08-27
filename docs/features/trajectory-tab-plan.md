# Trajectory tab — implementation plan

A per-phase, deepseek-harness-style view of PI's raw jsonl: three color-coded
swimlanes (Input / Model / Tools), a synced scrolling log feed, and a drill-in
sidebar for one entry. Lives as a second tab on the run page, below the phase
gantt, next to the existing content (now the "Main" tab).

## Decisions (from the interview)

- **Layout**: the phase gantt (`timeline.tsx`) stays at the top of the run page,
  above a new tab bar. The current detail panel + live feed + phase cards become
  the **Main** tab; **Trajectory** is the new tab. Phase selection stays in the
  gantt and is shared across both tabs.
- **Rows**: three lanes — `role:"user"`(+system/context) → **Input**,
  `role:"assistant"` → **Model**, `tool_execution_*` → **Tools**.
- **Live-updating**: yes — folded into the existing SSE refetch loop.
- **Drill-in**: right sidebar with `kind · Turn N · Step M` header and
  Summary / Payload / Result / Timing sub-tabs.

## What the codebase already gives us (findings)

- Run page = `run-detail-page.tsx` shell + `RunLiveRegion`
  (`actions/public/run-live-region.tsx`), a `clientEntry` that owns `selection`,
  the SSE subscription, and the `apply()` refetch (events.json + timeline.json +
  raw.json in parallel, one re-render per change). This is where the tab switcher
  and the trajectory fetch hook in.
- The gantt (`Timeline`) already reports phase selection via `onSelect`; the
  selection lives in `RunLiveRegion` setup scope and is mirrored to `?phase=`.
  The Trajectory tab reuses this exact selection.
- **The rich stream is only in raw jsonl.** The DB folds just `tool_call`,
  `spend`, `agent_end` (`core/events.ts`, `engine/tracer.ts`). `message_*`
  (user/assistant) and `turn_*` are **not** queryable — so the trajectory must be
  built by parsing `raw_output.jsonl`.
- Raw jsonl is **per-run**: `{data_dir}/runs/<run_id>/raw_output.jsonl`, every
  session appended verbatim in order. Line shapes are pinned in `core/rawevents.ts`
  and visible in `engine/pi/harness/fixtures/happy.jsonl`:
  `message_start/update/end` carry `message.role` + content blocks;
  `tool_execution_start/update/end` carry `toolName`/`args`/`result`/`isError`;
  `agent_start` carries `sessionId` + `model`.
- **Phase attribution**: phases run sequentially, so the run file is a
  concatenation of session blocks, each opened by `agent_start` (whose
  `sessionId` == the `pi_session_id` in the `agent_sessions` table, which maps to
  `phase_id` + `visit`). Segment on `agent_start`, map `sessionId → phase`, keep
  the target phase's blocks. A phase re-driven by `on_fail`/restart has several
  sessions → several blocks, ordered by visit; include all.
- **No per-line timestamps** in raw jsonl. So the swimlane X-axis is **ordinal**
  (event sequence — the "Turns"/"Calls" reading), not wall-clock, by default.
  Tool entries can be correlated to DB `tool_call` events by `tool_call_id` to
  recover `ts` + `duration_ms` for the drill-in Timing tab; a wall-clock
  ("Duration") axis is a follow-up, not the first cut.

## Architecture

Parse raw jsonl → a typed `TrajectoryView` on the server; render it on the
client. Mirror the existing per-phase proxy + lazy-fetch + SSR-seed pattern
(`envelopes.json`, `raw.json`, `timeline.json`), so nothing new is invented.

### 1. Wire contract (`server/contract.ts`)

```ts
export type TrajectoryLane = "input" | "model" | "tools";

export interface TrajectoryEntry {
  id: string;          // `${piSessionId}:${seq}` — stable across refetch
  seq: number;         // ordinal within the phase (X position for the count axis)
  lane: TrajectoryLane;
  kind: string;        // "user" | "assistant" | "tool"
  visit: number;
  turn: number;        // turn index within the session
  step: number;        // step index within the turn
  toolName?: string;
  toolCallId?: string;
  title: string;       // feed label: `read {"file_path":…}` or assistant snippet
  payload: unknown;    // tool args, or message content
  result?: string;     // tool result snippet
  ok?: boolean;        // tool success
  ts?: string | null;  // from the correlated tool_call event, else null
  durationMs?: number | null;
}

export interface TrajectoryView {
  run_id: string;
  phase: string;
  phase_id: string | null;
  status: PhaseStatus;
  entries: TrajectoryEntry[];
  counts: { input: number; model: number; tools: number };
  truncated: boolean;  // raw read hit the byte/line cap
}
```

### 2. Pure parser (`server/lib/trajectory.ts`)

`buildTrajectory(rawText, sessionsForPhase, toolTimings?) → TrajectoryView`.
No DB, no fs, no DOM — testable like `timeline-model`.

Fold rules (mirror the tracer's discipline):
- Track the current `sessionId` from each `agent_start`; keep only lines whose
  session maps to the target phase (via `sessionsForPhase`: `pi_session_id →
  {visit}`).
- `message_end role:"user"` → one **input** entry (join text blocks).
- `message_end role:"assistant"` → one **model** entry. Use `message_end` as
  canonical; ignore `message_start`/`update` to avoid duplicates.
- `tool_execution_start` opens a pending call by `toolCallId`; `tool_execution_end`
  → one **tools** entry (args from start, result from end, `ok = !isError`).
- `turn_start`/`turn_end` bump `turn`; `step` increments per entry within a turn.
- Correlate tools to DB `tool_call` events by `tool_call_id` for `ts` +
  `durationMs` when available.
- `seq` is a monotonic counter across the kept, ordered entries.

### 3. Server read + endpoint

- `apiTrajectory(state, runId, phase)` in `server/services/runs.ts`:
  read the full `raw_output.jsonl` (new full-read helper in `repository/rawfile.ts`
  with a byte/line cap → sets `truncated`), load the phase's `agent_sessions`
  rows and its `tool_call` events, call `buildTrajectory`. 404 on ghost
  run/phase.
- `getTrajectory(runId, phase)` wrapper in `server/lib/model.ts`; method on
  `transport/client.ts`.
- Route: `routes.runs.phases.trajectory = get("/runs/:runId/phases/:phase/trajectory.json")`.
- Remix proxy `trajectory` action in `actions/runs/phases/controller.tsx`
  (same shape as `envelopes`/`snapshot`): browser never talks to the server.

### 4. Client — pure layout (`ui/public/trajectory/trajectory-model.ts`)

`computeTrajectoryLayout(view, { axis, zoom }) →` per-lane points (fraction along
the axis), the visible feed slice, and lane colors. Axis default `"count"`
(ordinal by `seq`); `zoom` is a `[startFrac, endFrac]` window that narrows both
the swimlane and the feed. Pure + tested.

### 5. Client — components (`ui/public/trajectory/`)

- `trajectory-swimlane.tsx` — 3 rows (Input/Model/Tools), color-coded points at
  their axis fractions; a brush/zoom that sets the window; point click selects an
  entry. Colors from theme tokens (`--accent-*`, `--status-*`).
- `trajectory-feed.tsx` — the scrolling log (`TOOL read {…}`, `ASSISTANT …`,
  `USER …`) filtered to the zoom window; row click opens the drill-in; reuses the
  `describeToolCall`/snippet style from `event-feed.tsx`.
- `trajectory-detail.tsx` — the sidebar: header `kind · Turn N · Step M` +
  Summary / Payload / Result / Timing sub-tabs.
- `trajectory-panel.tsx` — composes the three; owns `selectedEntryId`, `zoom`,
  `axis` (state threaded from `RunLiveRegion` setup scope, like `autoScroll`).

### 6. Tab switcher + live wiring (`RunLiveRegion`)

- Add `activeTab: "main" | "trajectory"` to setup scope. Render order becomes:
  `<Timeline>` (gantt, unchanged) → `<TabBar>` → the active tab's body
  (`<TimelinePanel>` for main, `<TrajectoryPanel>` for trajectory).
- Add a `trajectory` cache keyed by phase + a `loadTrajectory(name)` (mirrors
  `loadPhaseData`): fetch on phase select and on tab switch when missing.
- SSR-seed the initially-selected phase's trajectory (via `renderRunDetail`,
  like `initialEnvelopes`) so the tab paints without a round-trip.
- **Live**: extend `apply()` to also refetch the selected phase's trajectory when
  the Trajectory tab is active and the run is non-terminal — best-effort like
  `fetchRawTail` (never turns events/timeline into a retry). Full refetch each
  tick, matching how `timeline.json` is replaced wholesale.

## Files

**New**
- `server/lib/trajectory.ts` — pure parser
- `server/ui/public/trajectory/trajectory-model.ts` — pure layout
- `server/ui/public/trajectory/trajectory-swimlane.tsx`
- `server/ui/public/trajectory/trajectory-feed.tsx`
- `server/ui/public/trajectory/trajectory-detail.tsx`
- `server/ui/public/trajectory/trajectory-panel.tsx`
- tests under `test/` (see below)

**Changed**
- `server/contract.ts` — `TrajectoryView`/`TrajectoryEntry`/`TrajectoryLane`
- `server/repository/rawfile.ts` — full-read helper (capped)
- `server/services/runs.ts` — `apiTrajectory`
- `server/lib/model.ts` — `getTrajectory`
- `server/transport/client.ts` — client method
- `server/routes.ts` — `phases.trajectory` route
- `server/actions/runs/phases/controller.tsx` — `trajectory` proxy
- `server/actions/runs/controller.tsx` — SSR-seed the initial trajectory
- `server/actions/public/run-live-region.tsx` — tab bar, trajectory cache/fetch,
  `apply()` live fold, SSR seed threading
- `server/actions/runs/run-detail-page.tsx` — pass the SSR seed through props

## Testing

- `buildTrajectory` over `happy.jsonl` + a new multi-phase fixture: lane counts,
  user/assistant/tool mapping, per-phase session filtering, tool arg/result fold,
  dedupe, `seq`/`turn`/`step`.
- `apiTrajectory`: correct view; 404 on ghost run/phase; `truncated` on cap.
- `computeTrajectoryLayout`: point fractions, zoom-window slicing, feed slice.
- DOM (happy-dom): swimlane renders 3 rows with N points; feed rows; detail
  sub-tabs switch; tab switch swaps bodies; phase select reloads trajectory.

## Suggested commits (small, ordered)

1. contract types + `buildTrajectory` + parser tests (no wiring).
2. `apiTrajectory` + rawfile full-read + model/client/route/proxy + endpoint tests.
3. `trajectory-model` + layout tests.
4. Trajectory components (render from a seeded view) + DOM tests.
5. Tab switcher + selection wiring + SSR seed.
6. Live fold into `apply()` + tests.
7. Polish: zoom/brush, color tokens, empty/loading/error states.

## Risks / follow-ups

- **Ordinal axis first.** No per-line timestamps in raw jsonl, so the default
  X-axis is sequence ("Turns"/"Calls"). A wall-clock "Duration" axis needs
  timing correlation (partial today via `tool_call`); ship it later, or enrich
  the tracer to stamp raw lines.
- **Full-file read per tick** on large runs. Fine to start (matches the
  timeline.json wholesale refetch); add a cursor/incremental path if it bites.
- **Sequential-phase assumption** underpins `agent_start` segmentation. Holds
  today; revisit if runs ever execute phases concurrently (lines would interleave).
- **Tail vs full.** `raw.json` serves a capped tail today; the trajectory needs
  the full file — hence the separate capped full-read helper and `truncated` flag.
