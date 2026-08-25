# showrunner — the dashboard

The remix@next (v3 beta) dashboard. Not a React project: `remix` is the only runtime framework dependency, pinned exactly to `3.0.0-beta.10`.

## What's here

- `GET /` — the run list: run (short id, links to the run-detail route), blueprint, `StatusPill`, started time, spend. Sorted started desc, filterable by status, with a refresh control. All reads are server-side (`lib/model.ts` calls the api core in-process); the browser sees rendered HTML only.
- States: `EmptyState` ("no runs yet — `showrunner run <blueprint>`").
- Run detail + phase drill-in (timeline chart, detail panel, live feed, attempts, gates, spend, raw), the pause-menu controls, and the events/timeline/envelopes/gates JSON proxies.

## Run it

There is ONE web server: the long-lived server process serves the API (under
`/api/*`) and the dashboard together on a single TCP listener — same process,
no env needed:

```sh
showrunner server        # the merged web server: /api/* + the dashboard on http://localhost:44100
```

For UI development — every entry below boots a FULL server in-process
(equivalent), so there is no separate running process to point at:

```sh
bun install
bun main.ts              # full server + dashboard on http://localhost:44100 (default data dir)
bun --watch main.ts      # dev reload (same in-process server)
bun hmr                 # HMR without restarts (hmr.ts spawns main.ts as its HMR child)
bun run typecheck
bun test                 # hermetic e2e — scratch data dirs, in-process server
```

Everything runs under bun — remix's node server entry composes with bun's
node:http compat, which is exactly how the server serves it in-process
(`transport/http.ts`). No node required.
