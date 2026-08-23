# The dashboard pins remix@next 3.0.0-beta.10 (no floating beta)

**Status**: accepted

The dashboard (`packages/ui`) is built on **`remix@next`** — the `remix`
package, v3, `next` dist-tag: a ground-up, full-stack TypeScript framework that
does not use React at all (§16.1). As of this ticket the `next` dist-tag
resolves to `3.0.0-beta.10`, and `packages/ui/package.json` pins **exactly**
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
- Deterministic reproduction: `bun install` in `packages/ui` and CI get the
  same framework bits, so the T09 verification (typecheck + rendered run list)
  is repeatable.
- Upgrading stays explicit: bump the pin, re-check against the guides, and
  record the new version here.

The remix package is the only *runtime* framework dependency in
`packages/ui` (§16.3 — "for most web apps, `remix` can be the only runtime
dependency"). The only other declared dependency is `@showrunner/core`
(`file:../core`, matching the CLI's pattern) so the typed client's
`@showrunner/core` imports resolve under bun. The daemon itself is NOT a
declared dependency — it is imported relatively from `app/lib/daemon.ts`
(`../../daemon/src/client.ts`) because bun 1.4 cannot resolve a `file:` dep's
own `file:` deps; the CLI uses the identical pattern.

Scaffold path (recorded per the ticket): `npx remix@3.0.0-beta.10 new
packages/ui` from the repo root, then the exact pin above.
