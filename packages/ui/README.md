# @showrunner/ui

The Showrunner dashboard — the remix@next (v3 beta) run-list UI. Not a React
project (spec §16.1): `remix` is the only runtime framework dependency, pinned
exactly to `3.0.0-beta.10` (ADR-0004).

## What's here (T09)

- `GET /` — the run list: run (short id, links to the run-detail route),
  blueprint, `StatusPill`, started time, spend. Sorted started desc, filterable
  by status, with a refresh control. All daemon reads are server-side
  (`app/lib/daemon.ts` over the typed §13 client); the browser sees rendered
  HTML only.
- States: `DaemonDownBanner` (daemon unreachable — shell still renders, no data
  rows), `EmptyState` ("no runs yet — `showrunner run <blueprint>`").
- Stub 404s for `/runs/:runId`, `/runs/:runId/events.json`,
  `/runs/:runId/phases/:phase` (later tickets).

## Run it

```sh
bun install
npm run dev          # http://localhost:44100 (needs a daemon: SHOWRUNNER_DATA_DIR or ~/.showrunner)
bun run typecheck
bun test             # hermetic e2e — scratch data dirs, in-process daemon
```

The dev server is node-based (`node --import remix/node-tsx server.ts`, remix's
documented entry); tests run under bun because the daemon needs `bun:sqlite`.
