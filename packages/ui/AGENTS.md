# Showrunner UI — Agent Guide

The Showrunner dashboard (`@showrunner/ui`): the remix@next (v3 beta) run-list
UI. Built on the `remix` package only — **not React** (spec §16.1). See
`docs/spec/05-ui-dashboard.md` §16 and the guides at https://guides.remix.run
(§16.2: read start-here, request-handling, routing-and-controllers,
rendering-ui, streaming-ui-with-frames, data-and-validation, files-and-assets,
interactivity before touching this package).

## Commands

```sh
bun install
bun run typecheck   # tsc --noEmit
bun test            # bun test (daemon runs in-process against scratch dirs)
npm run dev         # node --watch --import remix/node-tsx server.ts (port 44100)
npm run start       # production server
```

The dev/start scripts are node-based because remix's runtime entry uses
`node --import remix/node-tsx`; tests run under bun (the daemon needs
`bun:sqlite` in-process). Run `bun test` from THIS directory: bun anchors
tsconfig discovery at the cwd, so running the UI tests from the repo root
misses this package's `jsxImportSource` and falls back to React's JSX runtime.

## Layout

- `server.ts` — node:http entry via `createRequestListener` (`remix/node-fetch-server`), port 44100.
- `app/routes.ts` — the typed route map (`remix/routes`): `/` and the §16.12 run-detail group.
- `app/router.ts` — middleware (`staticFiles` + `render`) and controller mapping.
- `app/actions/controller.tsx` — the `/` action: fetches GET /runs SERVER-SIDE
  via `app/lib/daemon.ts` and renders `RunListPage`. Never call the daemon from
  the browser — no CORS, no daemon credentials in the browser (§16.4/§16.5).
- `app/actions/run-list-page.tsx` — the §16.6 run list (table, filter, refresh).
- `app/actions/runs/` — stubs for `/runs/:runId`, `events.json`, phase drill-in (later tickets).
- `app/actions/public/` — the browser runtime entry + the `RunFilterForm` clientEntry.
- `app/ui/` — shared components (`StatusPill`, `EmptyState`, `DaemonDownBanner`) and `format.ts`.
- `app/lib/daemon.ts` — the server-side typed §13 client wrapper (imports the
  daemon relatively — same bun pattern as the CLI; do not make it a `file:` dep).
- `test/` — the T09 e2e (bun test + `router.fetch`, scratch daemons).

## Conventions

- remix two-phase component model: a component is a setup function returning a
  render function; state is a setup-scope variable; updates via `handle.update()`.
- Server-rendered by default; mark the smallest interactive piece with
  `clientEntry(import.meta.url, ...)` — props must be `SerializableProps`.
- No React, no react-router, no hooks, no styling library — `remix/ui`'s
  `css()`, `mix`, `on(...)` are the stack.
- `remix` is pinned exactly (`3.0.0-beta.10`, ADR-0004) — do not float it.
