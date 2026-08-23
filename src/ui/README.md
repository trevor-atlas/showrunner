# showrunner — the dashboard

The remix@next (v3 beta) run-list UI. Not a React project (spec §16.1): `remix` is the only runtime framework dependency, pinned exactly to `3.0.0-beta.10` (ADR-0004).

## What's here

- `GET /` — the run list: run (short id, links to the run-detail route), blueprint, `StatusPill`, started time, spend. Sorted started desc, filterable by status, with a refresh control. All daemon reads are server-side (`app/lib/daemon.ts` calls the §13 api core in-process); the browser sees rendered HTML only.
- States: `EmptyState` ("no runs yet — `showrunner run <blueprint>`").
- Run detail + phase drill-in (gantt, live feed, attempts, gates, spend, raw) and the pause-menu controls.

## Run it

There is ONE web server: the daemon serves the §13 API (under `/api/*`) and the
dashboard together on a single TCP listener. In production that is the daemon
itself — same process, no env needed:

```sh
showrunner daemon        # the merged web server: /api/* + the dashboard on http://localhost:44100
```

For UI development — every entry below boots a FULL daemon in-process
(equivalent), so there is no separate "running daemon" to point at:

```sh
bun install
bun server.ts            # full daemon + dashboard on http://localhost:44100 (default data dir)
bun --watch server.ts    # dev reload (same in-process daemon)
bun hmr                 # HMR without restarts (hmr.ts spawns server.ts as its HMR child)
bun run typecheck
bun test                 # hermetic e2e — scratch data dirs, in-process daemon
```

Everything runs under bun — remix's node server entry composes with bun's
node:http compat, which is exactly how the daemon serves it in-process
(`src/daemon/web.ts`). No node required.
