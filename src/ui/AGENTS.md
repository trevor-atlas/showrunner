# Showrunner UI — Agent Guide

The Showrunner dashboard (`@showrunner/ui`): the remix@next (v3 beta) dashboard.
Built on the `remix` package only — **not React**. See the guides at
https://guides.remix.run (read start-here, request-handling,
routing-and-controllers, rendering-ui, streaming-ui-with-frames,
data-and-validation, files-and-assets, interactivity before touching this
package).

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun test (daemon runs in-process against scratch dirs)
bun server.ts       # full daemon + dashboard in-process, port 44100 (SHOWRUNNER_PORT overrides)
bun --watch server.ts   # dev reload
bun hmr             # HMR without restarts (hmr.ts spawns server.ts as its HMR child)
```

Everything runs under bun — `server.ts` imports `startDaemon` from the daemon
and boots it in-process, and remix's node entry composes with bun's node:http
compat (the same path the daemon's merged listener uses, `src/daemon/web.ts`).
Run `bun test` from THIS directory: bun anchors tsconfig discovery at the cwd,
so running the UI tests from the repo root misses this package's
`jsxImportSource` and falls back to React's JSX runtime.

## Layout

- `server.ts` — the UI dev entry: calls `startDaemon` (src/daemon/daemon.ts)
  IN-PROCESS to boot a full daemon, then serves the remix router on the same
  merged TCP listener via `src/daemon/web.ts` (port 44100, `SHOWRUNNER_PORT`).
- `hmr.ts` — remix's HMR runner (unchanged); spawns `server.ts` as its HMR child.
- `app/routes.ts` — the typed route map (`remix/routes`): `/`, the run-detail group (`/runs/:runId`, `/runs/:runId/events.json`, `/runs/:runId/timeline.json`, the control POST routes, and `/runs/:runId/phases/:phase` + its `envelopes.json`/`gates.json` proxies + control POST routes), and the colocated asset server.
- `app/router.ts` — middleware (`staticFiles` + `render`) and controller mapping.
- `app/actions/controller.tsx` — the `/` action: fetches GET /runs SERVER-SIDE
  via `app/lib/daemon.ts` and renders `RunListPage`. Never call the daemon from
  the browser — no CORS, no daemon credentials in the browser (§16.4/§16.5).
- `app/actions/run-list-page.tsx` — the §16.6 run list (table, filter, refresh).
- `app/actions/runs/` — the run-detail group: `/runs/:runId` (header, control bar, timeline chart, detail panel, live feed), the `events.json` + `timeline.json` cursor/timeline proxies, the phase drill-in group, and the control POST routes (§16.9).
- `app/actions/runs/phases/` — the phase drill-in page (config, envelope, gates, spend, output) plus the lazy `envelopes.json`/`gates.json` proxies and the phase-scoped control verbs.
- `app/actions/public/` — the browser runtime entry, the `RunFilterForm` and `RunLiveRegion` clientEntries.
- `app/ui/` — shared components (`StatusPill`, `EmptyState`, `NeedsReviewBanner`, `PauseMenu`, phase drill-in cards) and `format.ts`.
- `app/ui/public/` — the browser module graph: the timeline chart + panel (`timeline.tsx`, `timeline-panel.tsx`, `timeline-model.ts`), the `EventFeed`, and the browser-local `format.ts` copies.
- `app/lib/daemon.ts` — the server-side daemon data layer: calls the §13 api
  core (src/daemon/server.ts) IN-PROCESS against the state held by
  src/daemon/web-state.ts (the merged web server — no socket round trip).
- `test/` — the T09 e2e (bun test + `router.fetch`, scratch daemons).

## Conventions

- remix two-phase component model: a component is a setup function returning a
  render function; state is a setup-scope variable; updates via `handle.update()`.
- Server-rendered by default; mark the smallest interactive piece with
  `clientEntry(import.meta.url, ...)` — props must be `SerializableProps`.
- No React, no react-router, no hooks, no styling library — `remix/ui`'s
  `css()`, `mix`, `on(...)` are the stack.
- `remix` is pinned exactly (`3.0.0-beta.10`) — do not float it.
