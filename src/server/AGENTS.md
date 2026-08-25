# Showrunner server — Agent Guide

`src/server/` is the long-lived server process: it owns SQLite and serves BOTH
the JSON API (`/api/*`) and the remix@next (v3 beta) dashboard on ONE TCP
listener (default `127.0.0.1:44100`, `SHOWRUNNER_PORT` overrides). The
dashboard is built on the `remix` package only — **not React**. See the guides
at https://guides.remix.run (read start-here, request-handling,
routing-and-controllers, rendering-ui, streaming-ui-with-frames,
data-and-validation, files-and-assets, interactivity before touching the UI
layers).

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun test (the server runs in-process against scratch dirs)
bun src/cli/index.ts dev   # `showrunner dev` — the first-class UI dev loop (remix HMR, NODE_ENV=development)
bun main.ts         # full server + dashboard in-process, port 44100 (SHOWRUNNER_PORT overrides)
bun --watch main.ts   # dev reload (restarts on every edit → interrupts in-flight runs)
bun hmr             # what `showrunner dev` runs: hot-swaps most edits without restart (hmr.ts spawns main.ts as its HMR child)
```

Everything runs under bun — `main.ts` imports `startServer` from
`lifecycle.ts` and boots the server in-process, and remix's node entry composes
with bun's `node:http` compat (the same path the merged listener uses,
`transport/http.ts`). Run `bun test` from THIS directory: bun anchors tsconfig
discovery at the cwd, so running the UI tests from the repo root misses this
package's `jsxImportSource` and falls back to React's JSX runtime.

## Layout — the layers

Requests flow **router → controller → service → engine → repository**, with
**transport** owning the wire (HTTP + SSE) and **lib** the server-side data
bridge the dashboard controllers read through.

- `lifecycle.ts` — `startServer` / `ServerHandle`: opens the DB, boots the pool,
  claims the port (bind-based double-boot guard), runs crash recovery, and
  returns the handle. `main.ts` is the standalone dev entry that calls it.
- `routes.ts` — the typed route map (`remix/routes`): `/`, the run-detail group
  (`/runs/:runId`, `events.json`, `timeline.json`, the control POST routes, the
  `/runs/:runId/phases/:phase` drill-in + its `envelopes.json`/`gates.json`
  proxies), and the colocated asset server.
- `router.ts` — middleware (`staticFiles` + `render`) and controller mapping.
- `transport/` — the wire layer: `http.ts` (the merged web server + the
  `Request → Response` dispatcher for `/api/*`), `client.ts` (the typed HTTP
  client the CLI uses), `state.ts` (the in-process state holder registered by
  `createWebServer`), and `change-bus.ts` (the write-side signal bus that wakes
  SSE subscribers).
- `actions/` — the remix controllers (the run list, the run-detail group, the
  phase drill-in group, the control POST routes) and `actions/public/` (the
  browser runtime entry, the `RunListLive`/`RunLiveRegion` clientEntries, and
  the SSE substrate). Controllers read data SERVER-SIDE through `lib/`; the
  browser never calls the API directly.
- `services/` — the read/compute view-model layer (run list, run stats, run
  detail, phase record, timeline, templates): pure gathers over the repository.
- `engine/` — the run loop, pool, driver, pi session harness, backfill,
  pause-control, and tracer — everything that actually drives agent sessions.
- `repository/` — persistence: `db.ts` (SQLite, the single events-write
  chokepoint) and `workspace/` (the run workspace filesystem protocol).
- `lib/` — the dashboard's server-side data bridge: `model.ts` calls the api
  core IN-PROCESS against the state held by `transport/state.ts` (no socket
  round trip), plus `blueprint-snapshot.ts` / `phase-data.ts` gathers.
- `ui/` — server-only shared components (`NeedsReviewBanner`, `PauseMenu`, phase
  drill-in cards) and `format.ts`.
- `ui/public/` — the browser module graph: `StatusPill` (+ the `runStatus`
  fold), `EmptyState`, the run-list `list-model.ts`, the timeline chart + panel,
  the `EventFeed`, and the browser-local `format.ts` copies.

Note: the package tree lives at `src/server/`; the standalone test suite is at
`test/server/`.

## Conventions

- remix two-phase component model: a component is a setup function returning a
  render function; state is a setup-scope variable; updates via `handle.update()`.
- Server-rendered by default; mark the smallest interactive piece with
  `clientEntry(import.meta.url, ...)` — props must be `SerializableProps`.
- The browser module graph (`ui/public/`) must not pull server-only types or
  modules.
- No React, no react-router, no hooks, no styling library — `remix/ui`'s
  `css()`, `mix`, `on(...)` are the stack.
- `remix` is pinned exactly (`3.0.0-beta.10`) — do not float it.
