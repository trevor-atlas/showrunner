# Trajectory tab — implementation record

What actually shipped for the Trajectory tab (issues #82–#88, all on the
`trajectory-tab` branch). Read alongside the design doc
[`trajectory-tab-plan.md`](./trajectory-tab-plan.md); this record documents the
built state and calls out where it diverged from the plan.

## 1. Overview

The Trajectory tab is a second tab on the run page (below the phase gantt, next
to the existing "Main" tab). It renders a per-phase, deepseek-harness-style view
of PI's raw JSONL stream: three color-coded swimlanes (Input / Model / Tools),
a synced scrolling log feed, a drill-in detail sidebar for a single entry, and a
brush/zoom window that scopes both the lanes and the feed.

Architecture is **parse-on-server / render-on-client**. The DB only folds
`tool_call` / `spend` / `agent_end`, so the rich conversational stream
(user/assistant messages, turns, tools) is not queryable — it is parsed from the
run's `raw_output.jsonl` on the server into a typed `TrajectoryView`, served
through the same per-phase proxy + lazy-fetch + SSR-seed pattern the phase cards
already use, and rendered on the client by pure/DOM-free layout code plus thin
components. It reuses the existing gantt phase selection and the existing SSE
refetch loop, so nothing new was invented on the transport side.

## 2. Per-ticket summary

- **#82 — run-page `[Main | Trajectory]` tab bar** (`ee9a6a8`). Added
  `activeTab: "main" | "trajectory"` to the `RunLiveRegion` setup scope (so it
  survives SSE refetches) and a `role="tablist"` tab bar between the gantt and
  the active tab body. Main renders the existing `TimelinePanel`; Trajectory
  renders `TrajectoryPanel`. Phase selection stays shared across both tabs.
  Files: `actions/public/run-live-region.tsx`.

- **#83 — per-phase trajectory data layer (parser + endpoint)** (`5baa1b7`). The
  wire contract (`TrajectoryLane`, the `TrajectoryEntry` union, `TrajectoryView`)
  in `contract.ts`; the pure parser `buildTrajectory` in `lib/trajectory.ts`; the
  capped full-file read `readRawFileCapped` in `repository/rawfile.ts`;
  `apiTrajectory` in `services/runs.ts`; the `getTrajectory` model wrapper, the
  client method, the `phases.trajectory` route, and the Remix `trajectory` proxy.
  Zod line shapes were extended in `core/rawevents.ts`. Files:
  `contract.ts`, `lib/trajectory.ts`, `repository/rawfile.ts`, `services/runs.ts`,
  `lib/model.ts`, `transport/client.ts`, `transport/http.ts`, `routes.ts`,
  `actions/runs/phases/controller.tsx`, `core/rawevents.ts`.

- **#84 — per-phase log feed UI** (`efae3af`). The scrolling `TrajectoryFeed`
  (one typed USER/ASSISTANT/TOOL row per entry, truncated to a single line) and
  the `TrajectoryPanel` composer that owns loading / error / no-selection states.
  Wired the per-phase trajectory cache + `loadTrajectory`/`ensureTrajectory`
  lazy-fetch into `RunLiveRegion`, plus the SSR seed of the initially-selected
  phase's trajectory threaded through `controller.tsx` → `run-detail-page.tsx`.
  Files: `ui/public/trajectory/trajectory-feed.tsx`,
  `ui/public/trajectory/trajectory-panel.tsx`, `actions/public/run-live-region.tsx`,
  `actions/runs/controller.tsx`, `actions/runs/run-detail-page.tsx`.

- **#85 — Input/Model/Tools swimlanes** (`5d58e32`). The pure layout model
  `computeTrajectoryLayout` (ordinal placement, always three lanes) in
  `trajectory-model.ts`, and the `TrajectorySwimlane` component that maps
  fractions to percentages and colors points by lane. Files:
  `ui/public/trajectory/trajectory-model.ts`,
  `ui/public/trajectory/trajectory-swimlane.tsx`,
  `ui/public/trajectory/trajectory-panel.tsx`.

- **#88 — live-updating** (`40a5b3e`, landed before #86/#87 in history). Folded a
  best-effort `fetchTrajectory` into `apply()`: while the Trajectory tab is open
  on a non-terminal run, the selected phase's trajectory rides the same
  events.json + timeline.json round-trip and replaces the cached view wholesale.
  Never throws (mirrors the RAW-tail fetch), so it never turns events/timeline
  into a retry. Files: `actions/public/run-live-region.tsx`.

- **#86 — drill-in detail sidebar** (`3e599ab`). `TrajectoryDetail` — a
  `kind · Turn N · Step M` header plus Summary / Payload / Result / Timing
  sub-tabs, discriminating tool vs message rows off the union. Panel now owns
  `selectedSeq`; a feed row click opens the sidebar and marks the row. Files:
  `ui/public/trajectory/trajectory-detail.tsx`,
  `ui/public/trajectory/trajectory-feed.tsx`,
  `ui/public/trajectory/trajectory-panel.tsx`.

- **#87 — zoom/brush window** (`8217f3c`). Added the `TrajectoryZoomWindow`
  option and the shared `entriesInZoom` filter to `trajectory-model.ts`; the
  swimlane gained a drag-to-brush affordance + a visible overlay + a clear
  control; the panel owns `zoomWindow` and feeds the same in-window set to both
  the lanes and the feed. Files: `ui/public/trajectory/trajectory-model.ts`,
  `ui/public/trajectory/trajectory-swimlane.tsx`,
  `ui/public/trajectory/trajectory-panel.tsx`.

## 3. Data flow

```
{data_dir}/runs/<run_id>/raw_output.jsonl
   │  readRawFileCapped(path, 50_000)   ← full read from the START, capped,
   │                                       sets `truncated` when lines dropped
   ▼
buildTrajectory(rawText, sessionsForPhase, toolTimings)   [lib/trajectory.ts, pure]
   │  • segment on `agent_start` → sessionId; keep only lines whose session
   │    maps to the target phase (all visits, since an on_fail re-drive makes
   │    several sessions for one phase)
   │  • lane mapping: message_end role:"user" → input, role:"assistant" → model,
   │    tool_execution_start + tool_execution_end → tools
   │  • messages fold on `message_end` (canonical over start/update — dedupe)
   │  • tool timing correlation: ts + duration_ms from the DB tool_call event,
   │    keyed by tool_call_id (null when absent)
   │  • seq (monotonic across kept entries), turn (from turn_start), step
   │    (within the turn)
   ▼
TrajectoryView  ── apiTrajectory (services/runs.ts) loads agent_sessions rows +
   │                tool_call timings, calls buildTrajectory, 404s a ghost
   │                run/phase, stamps run_id/phase/phase_id/truncated
   ▼
GET /runs/:runId/phases/:phase/trajectory.json   (Remix proxy — browser never
   │                                               talks to the server directly)
   ▼
RunLiveRegion client cache
   │  • per-phase `trajectory` Map + `loadTrajectory` lazy-fetch (inflight dedup)
   │  • SSR-seeded initial phase (no round-trip on first open)
   │  • ensureTrajectory on tab-switch / phase-select while the tab is open
   ▼
TrajectoryPanel → TrajectorySwimlane + TrajectoryFeed + TrajectoryDetail
   │  • entriesInZoom is the single filter for lanes + feed
   ▼
Live: apply() best-effort refetch of the selected phase's trajectory folded into
      the SSE round-trip (Trajectory tab open + non-terminal), replacing the
      cached view wholesale — never blocks events/timeline.
```

## 4. Key design decisions

- **`buildTrajectory` is pure — no DB / fs / DOM.** The caller reads the file,
  the `agent_sessions` rows, and the `tool_call` timings and hands them in, so
  the parser is unit-tested like `timeline-model`.
- **Capped full-file read + `truncated` flag.** The trajectory needs the whole
  conversation in order (unlike `raw.json`, which serves a capped *tail*), so a
  separate `readRawFileCapped` reads from the start capped at
  `MAX_TRAJECTORY_RAW_LINES = 50_000` and sets `truncated` when later lines are
  dropped.
- **Single source of truth `entriesInZoom`.** One shared filter over the
  seq-ordered entries drives both the swimlane points and the feed rows, so they
  can never disagree about what is in the window.
- **Zoom window + `activeTab` held in setup closure.** They survive SSE
  refetches — a change wake-up's `apply()` replaces the `view` but never resets
  the reader's zoom or tab. (`selectedSeq` and `zoomWindow` live in the panel
  closure for the same reason.)
- **Live refetch is best-effort.** `fetchTrajectory` mirrors `fetchRawTail`:
  never throws, so a failure keeps the last good view and only events/timeline
  decide the `apply()` outcome. A terminal run or the Main tab skips it entirely.

### Deviations from the plan

- **`TrajectoryEntry` shipped as a discriminated union**
  (`TrajectoryMessageEntry | TrajectoryToolEntry`) rather than the plan's single
  flat entry with `kind`/`title`/`payload`. Messages carry `role`/`text`; tools
  carry `tool`/`args`/`result`/`ok`/`ts`/`duration_ms`. The lane discriminates
  the shape.
- **`TrajectoryView` dropped `counts`, `status`, and per-entry `id`/`visit`** from
  the planned shape. Lane counts are derived on the client in
  `computeTrajectoryLayout`; entries key on `seq`.
- **Live-update (#88) landed before the drill-in (#86) and zoom (#87)** in commit
  order, even though the issue numbers suggest the reverse.
- The ordinal ("count") axis is the only axis, as planned; a wall-clock axis
  remains a follow-up.

## 5. Test coverage

- `test/server/trajectory.test.ts` — the pure parser and endpoint: lane mapping
  over `happy.jsonl` (1 input / 3 model / 3 tools), per-phase session filtering
  across the new `test/server/fixtures/multi-phase.jsonl` (all visits kept),
  tool ts/duration correlation by `tool_call_id`, empty-view for a session-less
  phase; `readRawFileCapped` (truncation + missing file); the trajectory.json
  proxy (correct view, 404 for ghost run/phase).
- `test/server/trajectory-model.test.ts` — `computeTrajectoryLayout`: ordinal
  fractions, per-lane grouping/counts, always-three-lanes ordering, empty lanes,
  lone-point (no divide-by-zero), seq re-ordering.
- `test/server/trajectory-feed.test.tsx` — feed rows tagged by lane in seq order,
  long-body truncation, empty state; plus the `RunLiveRegion` Trajectory-tab
  lazy-fetch tests (SSR seed paints with no fetch, new phase fetches through the
  proxy, cached phase does not refetch, empty + error states).
- `test/server/trajectory-swimlane.test.tsx` — three labelled lanes, one point
  per entry on the right lane, per-lane header counts, clean empty lane, empty
  view.
- `test/server/trajectory-detail.test.tsx` — the `kind · Turn N · Step M` header,
  kind derived from role, Summary default, Payload/Result/Timing content for tool
  and message rows, `not available` timing, `onClose`; plus the panel wiring
  (row click opens/updates/closes the sidebar).
- `test/server/trajectory-zoom.test.tsx` — windowed `computeTrajectoryLayout`
  (in-window re-normalization, reversed window, single-entry, full window),
  `entriesInZoom` as the shared filter, the swimlane brush seam (drag sets a
  window, click clears, clear control), and the panel scoping lanes AND feed
  together — including keeping the window across a simulated SSE view refetch.
- `test/server/run-live-region.test.tsx` — the #82 tab bar (default Main, tab
  swap, selection + activeTab surviving refetch) and the #88 live fold (new
  entries stream in on a wake, best-effort on a rejecting fetch, skipped on the
  Main tab, frozen on a terminal run).

## 6. Known follow-ups / limitations

- **Drill-in sub-tab does not reset to Summary when switching entries.**
  `TrajectoryDetail` holds `active` in its own setup closure and only reseeds on
  mount, so selecting a different feed row while the sidebar is open keeps the
  previously-active sub-tab (e.g. Payload) instead of returning to Summary.
- **Real-browser brush pixel geometry is not unit-tested.** The rect→fraction
  math and the CSS overlay offsets depend on live layout; happy-dom reports
  zero-size rects, so the drag tests exercise the handler seam, not the pixel
  geometry.
- **The live-freeze `isTerminalStatus` gate is covered via stream teardown, not
  in isolation.** The "freezes the trajectory on a terminal run" test asserts the
  observable outcome (no further refetch after completion) rather than the gate
  predicate directly.
- **Repo-wide `bun run typecheck` has a pre-existing baseline failure** in the
  phase/gate files (`BlueprintPhase<Env>`), unrelated to this feature. It is
  being addressed by a separate phase/gate refactor and does not gate the
  Trajectory tab work.
- **Ordinal axis only.** No wall-clock "Duration" axis yet (no per-line
  timestamps in raw JSONL); full-file read per tick and the sequential-phase
  `agent_start` segmentation assumption both carry over from the plan's
  risks/follow-ups.
