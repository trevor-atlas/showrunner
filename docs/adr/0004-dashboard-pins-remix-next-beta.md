# The dashboard pins remix@next 3.0.0-beta.10 (no floating beta)

**Status**: accepted

The dashboard (`src/ui`) is built on **`remix@next`** — the `remix`
package, v3, `next` dist-tag: a ground-up, full-stack TypeScript framework that
does not use React at all (§16.1). As of this ticket the `next` dist-tag
resolves to `3.0.0-beta.10`, and `src/ui/package.json` pins **exactly**
`"remix": "3.0.0-beta.10"` — deliberately NOT `^3.0.0` or `^3.0.0-beta.10`.
The scaffold's default `^3.0.0-beta.10` was edited to the exact pin in the same
ticket that scaffolded the app.

Why an exact pin, on a moving target:

- The v3 beta's API surface is documented at guides.remix.run and the repo's
  spec §16 tracks it; a floating caret silently changes the framework's typed
  route map, component model, and middleware contracts under a running app.
- `next` is a rolling dist-tag — `3.0.0-beta.10` today, something else
  tomorrow. The §16 contract and the guides are the source of truth for THIS
  version; an exact pin keeps the code, the ADR, and the docs in one
  verifiable snapshot.
- Deterministic reproduction: `bun install` in `src/ui` and CI get the
  same framework bits, so the T09 verification (typecheck + rendered run list)
  is repeatable.
- Upgrading stays explicit: bump the pin, re-check against the guides, and
  record the new version here.

The remix package is the only *runtime* framework dependency
(§16.3 — "for most web apps, `remix` can be the only runtime
dependency"); since PR #21's one-package merge it lives in the single root
`package.json`, pinned exactly. The daemon is NOT a declared dependency: it is
imported relatively (`src/daemon/web.ts` → `../ui/app/router.ts`, lazily) and
the UI's data layer imports the daemon's modules directly (`app/lib/daemon.ts`
→ `../../daemon/web-state.ts`, `../../daemon/server.ts`).

Scaffold path (recorded per the ticket): `npx remix@3.0.0-beta.10 new
src/ui` from the repo root, then the exact pin above.

**Merged-server seam (PR #21)**. The daemon serves the dashboard in-process,
but it imports the remix router **lazily** (`src/daemon/web.ts` uses a dynamic
`import("../ui/app/router.ts")`) and remix's asset compiler is likewise lazy
(`assets.ts` accessors). The first dashboard request may answer `503 "dashboard
warming up"` while the import resolves, then 200; the `/api/*` dispatch runs
BEFORE the router promise is touched, so the JSON API never waits on the UI
graph. The daemon therefore never does compile work at startup.

**Environment quirk (this machine, PR #21)**. macOS Gatekeeper's `syspolicyd`
wedged at 100% CPU, making every NAPI addon load (oxc-parser/transform,
lightningcss — used by remix's asset compiler) hang inside `dyld` while
dlopen'ing. Remedy: kill/restart `syspolicyd` (or reboot). The lazy seams above
mean the daemon never hits this path unless a dashboard page is actually
rendered — and in CI the UI tests drive the router through bun directly.
