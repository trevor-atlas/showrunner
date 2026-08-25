# Architecture refactor plan

This is the agreed plan to simplify showrunner by giving its core concepts deep
modules with clear ownership. It captures the decisions made during the
architecture review so future work does not re-litigate them.

## Why

Several concepts (Phase, Visit, Run views, the Phase workspace, Gates) are real
domain ideas, but their logic is scattered across shallow modules. The same
assembly and derivation happen in `server.ts`, the UI proxies, the phase
controller, and the live regions. The fix is not a framework; it is explicit
ownership: one deep module per concept, one place to test it.

## Structure at a glance

showrunner follows a common MVC/MVVM split. Five layers, mapped onto the tree:

| Layer | Role | Lives in |
| --- | --- | --- |
| **Persistence** | Storage mechanics (SQL, filesystem). Readers + writers. | `src/daemon/db.ts` (SQLite), Phase workspace module (filesystem) |
| **Domain** | Core concepts and invariants; the write side / run loop. | `src/core/`, the daemon run loop (`runner.ts`, `envelope-runner.ts`, gates) |
| **View models** | Read side. Assemble stored data into screen/API shapes. | `src/view-models/` (new) |
| **Controllers / adapters** | Translate a protocol only. | `src/daemon/server.ts` (HTTP), `src/ui/app/actions/**` (Remix), `src/cli/**`, the UI live-snapshot adapter |
| **Views** | Render already-shaped data. | `src/ui/app/ui/**` (TSX) |

`src/starter-kit/` is not a layer — it is templates that are materialized into
`~/.showrunner/` and loaded from there at runtime.

**How a read flows** (e.g. the phase card):

```
HTTP / Remix action        (controller: parse request)
   → PhaseRecordModel       (view model: assemble the shape)
       → db.ts readers       (persistence: rows)
       → Phase workspace     (persistence: files)
   → Response.json / props  (controller returns; view renders)
```

**How a write flows** (e.g. a Visit runs, a gate override):

```
HTTP / Remix action        (controller/adapter: parse + validate)
   → run loop / command     (domain: invariants, state machine)
       → db.ts writers       (persistence: rows)
       → Phase workspace     (persistence: files)
```

The read and write sides meet only in persistence. A controller never derives;
a view model never writes; a view never gathers.

## Layering standard

Common MVC/MVVM terminology, with showrunner-specific responsibilities pinned so
contributors do not have to infer them.

- **Persistence** — storage mechanics. `db.ts` owns all SQL. The Phase
  workspace module owns the run's filesystem layout. No raw SQL or raw
  workspace path math lives anywhere else.
- **Domain** — core concepts and invariants: Run, Phase, Visit, Gate, Envelope,
  Blueprint, Phase workspace. In `src/core` and the daemon run loop.
- **View models** — `src/view-models/`. Pure data assembly: identifiers +
  persistence in, serializable shape out. No view state, no commands, no SQL of
  their own, no HTTP/routing, no React, no writes. This is the read side of the
  app.
- **Controllers / adapters** — translate a protocol only: HTTP routes, Remix
  controllers, CLI commands, browser event handlers, SSE. Parse the request,
  call a view model or a command, return a response. No derivation.
- **Views** — render already-shaped data. TSX only. No gathering, no
  filesystem, no aggregation.

**Dependency direction (one-way):**

```
core types + persistence readers
        ▲
   src/view-models  ──────────────┐
        ▲                         │
 daemon HTTP · UI actions · CLI   │  (all consume the SAME view models)
        ▲
   views (TSX)
```

View models must not depend on HTTP, routing, React, or CLI. Daemon and UI
depend on view models, never the reverse.

## Domain model

- A **Run** has ordered **Phases**.
- A **Phase** is executed by one or more **Visits**.
- A **Visit** contains Envelope attempts and Corrections, and is backed by one
  **Agent Session**.
- **Gates** evaluate the **Envelope** within a Visit.

## Decisions

### Phase / Visit persistence (schema v3)

Enrich `phases` with queryable declaration metadata rather than a serialized
blob (avoids downstream stitching; never tries to serialize functions or zod
schemas):

- `ordinal`, `agent_name`, `agent_model`, `budget`, `require_approval`,
  `on_fail_to`, `gate_names` (JSON), `context_entries` (JSON).

Make **Visit** first-class in the same migration:

- New `phase_visits` table: `id`, `phase_id`, `visit_number`, `cause`,
  `status`, `started_at`, `ended_at`, `agent_session_id`.
- Add `visit_id` FK on `envelopes` (keep the visit number too).

Backwards compatibility is not important right now, there are no users. Feel free to drop old table rows at migration time as there is not data necessary to keep.

### View-model layer

New `src/view-models/` owning at least:

- `RunListModel` — landing table rows.
- `RunStatsModel` — KPI + chart aggregates (moves the `apiStats` fold out of
  `server.ts`).
- `RunDetailModel` — a run with phases, timeline, current state.
- `PhaseRecordModel` — one Phase's full record: declaration, workspace
  inputs/outputs, envelope attempts, gate results, sessions, spend, visit
  history. Replaces the scattered assembly in `phase-data.ts`, the phase
  controller, the live region, and `server.ts`.

### Phase workspace module (filesystem persistence)

The Phase workspace is a **persistence-layer module — the filesystem sibling of
`db.ts`**. `db.ts` owns the SQLite store; the Phase workspace owns the run's
filesystem store (`inputs/`, `outputs/`, the envelope record, the agent map).
Turn the scattered handoff/path protocol (`handoff.ts` + the path helpers the
run loop calls) into that one deep module, exposing a readers/writers split:

- **Writers** — `materializeHandoff`, output capture, `recordAcceptedEnvelope`,
  `writeAgentMap`. Consumed by the run loop (the write/domain side). The run
  loop asks for workspace actions, not paths.
- **Readers** — `readHandoffInputs`, `readOutputsDir`, context resolution.
  Consumed by view models (`PhaseRecordModel`), exactly as view models call
  `db.ts` read functions.

This also removes the current overlap in `phase-data.ts`, which both reads
workspace files and assembles the shape: the Phase workspace becomes the
persistence reader, `PhaseRecordModel` becomes the assembler.

### Live snapshot (UI adapter)

This is a **client-side adapter**, not a view model: it owns the browser live
transport. Today the run-list, run-stats, and run-detail regions each hand-roll
the same lifecycle around `sse.ts` (`subscribeSse` + `createCoalescedNotifier`)
and repeat the in-flight guard, the stale-on-failure policy, and the abort
teardown. One module absorbs that.

The seam it already sits on:

- `lib/live.ts` (server) turns a change-bus subscription into the SSE
  `text/event-stream` response. Unchanged.
- `actions/public/sse.ts` (browser) wraps `EventSource` and coalesces wake-ups.
  The new module composes these into the full refetch transport.

**What the module owns:**

- Subscription lifecycle: open the `EventSource` for a live href, listen for
  `change`, rely on native reconnect, tear down on abort.
- Coalescing: a burst of wake-ups collapses to one run; a wake-up mid-run
  schedules exactly one trailing rerun.
- In-flight guard: a slow round-trip never stacks refetches.
- Transient-failure policy: keep the last snapshot; schedule one-shot retry
  after a fixed delay.
- Stop conditions: a caller-supplied predicate ends the subscription (a 404
  “run is gone”, or a terminal run).

**What stays in the region (view + view state):**

- The snapshot data and how it renders.
- View state: selection, sort, search, filters, autoscroll, copied-id.
- URL mirroring of interaction state (`?status=`, `?phase=`).
- Any domain merge the region needs (e.g. run-detail's cursor merge), supplied
  to the module as an apply-callback so the transport stays generic.

**Two shapes it must cover without each region re-implementing:**

- Single-snapshot regions (list, stats): one wake-up → refetch one JSON proxy
  → replace snapshot → rerender.
- Run-detail: one wake-up → parallel fetches (events + timeline, plus the raw
  tail) → cursor merge → rerender, with the retry and terminal/gone stop
  conditions above.

The browser still never talks to the daemon — it only refetches rendered JSON
proxies (the iron convention).

### Starter kit → user-owned

`src/starter-kit/` becomes templates only; nothing runs from it directly.

- Runnable blueprints/agents/gates are copied into `~/.showrunner/` and loaded
  from there.
- **Materialization:** copy-if-absent on first daemon start (bootstrap only).
  The daemon never re-copies afterward.
- **Sync command:** an explicit CLI command pulls template updates later.
  Behavior: add-only for missing files (never clobber), plus report drift for
  existing files and overwrite only the ones the user confirms.
- With templates decoupled, collapse the duplicated blueprint stacks into a
  small catalog of shared phase patterns.

### Gates

- Enforce envelope-shape validation in the envelope/gate stage as a runtime
  backstop, so no phase can accept a malformed envelope regardless of its gate
  list. The stage already zod-parses `envelope.json` against `phase.envelope`,
  so the per-blueprint `envelopeShape(SameEnvelope)` gates are redundant and
  get dropped (this also shrinks the blueprint duplication above).
- Split the remaining gate families (command / handoff / file / verdict) into
  focused modules with shared helpers behind a small roster.

## Sequence (foundation-first)

1. This architecture doc (layers + rules).
2. Schema v3: enrich `phases`, add `phase_visits`, add `envelope.visit_id`,
   best-effort backfill.
3. `src/view-models/` with `PhaseRecordModel` first (the hottest ambiguity).
4. Phase workspace module.
5. Daemon view models (list / stats / detail / timeline); `server.ts` becomes a
   thin HTTP adapter.
6. UI live-snapshot module; list/stats/detail regions consume it.
7. Starter-kit materialization to `~/.showrunner` + blueprint-stack collapse.
8. Gate stage enforcement + gate-family split.

## Migration plan (how we get there)

Ground rules for every commit below: keep tiny and independently committable,
leave both gates green, and never edit source outside the files named. The
**green check** for every commit is the same two commands (tsc is not on PATH):

```
node_modules/.bin/tsc --noEmit
bun test test/
```

Baseline to compare against: 353 pass / 3 known-unrelated fails
(`test/starter-kit/skills.test.ts` two "10 skills" cases; the
`test/daemon/runner.test.ts` "R2 cause: human restart-fresh" full-suite flake).
Those 3 are not regressions. HEAD moves under you (the user commits to main in
parallel), so rebase often and keep each commit self-contained.

### Step 2 — Schema v3 (migration + backfill)

Goal: enrich `phases` with queryable declaration columns, make Visit
first-class (`phase_visits`), add `envelopes.visit_id`, backfill from existing
rows. All in `src/daemon/db.ts` plus the writers that feed it.

- **2.1 — the v3 DDL (additive, nullable).** In `src/daemon/db.ts`: push a
  third string onto `MIGRATIONS` and bump `SCHEMA_VERSION` to 3. The string,
  in one statement order:
  1. `CREATE TABLE phase_visits (id TEXT PRIMARY KEY, phase_id TEXT NOT NULL REFERENCES phases(id), visit_number INTEGER NOT NULL, cause TEXT, status TEXT NOT NULL, started_at TEXT, ended_at TEXT, agent_session_id TEXT REFERENCES agent_sessions(id));`
  2. `ALTER TABLE phases ADD COLUMN ordinal INTEGER;` and the rest as nullable /
     defaulted adds: `agent_model TEXT`, `require_approval INTEGER NOT NULL DEFAULT 0`,
     `on_fail_to TEXT`, `gate_names TEXT NOT NULL DEFAULT '[]'`,
     `context_entries TEXT NOT NULL DEFAULT '[]'`. Reuse the existing `agent`
     column for agent name and the existing `budget` column — do not re-add them.
  3. `ALTER TABLE envelopes ADD COLUMN visit_id TEXT REFERENCES phase_visits(id);`
     — allowed on an existing table precisely because the added FK column
     defaults to NULL (SQLite forbids ADD COLUMN with a non-NULL default or a
     non-null-defaulted FK, and forbids in-place FK edits; a nullable REFERENCES
     column needs no table rebuild). `phase_visits` is created earlier in the
     same migration string so the reference resolves.
  Tests: in `test/daemon/db.test.ts` add `"phase_visits"` to the `tables` array
  (keeps the "exactly these tables" and idempotency assertions correct), and add
  a v3 case asserting the new `phases`/`envelopes` columns exist via
  `PRAGMA table_info`. New columns are nullable/defaulted so the existing
  `insertPhase`/`insertEnvelope` writers still compile and run unchanged.
  Green check: tsc + bun test test/.

- **2.2 — persistence writers/readers for the new columns + phase_visits.** In
  `src/daemon/db.ts`: extend `PhaseRow` with the new fields; extend `insertPhase`
  (and keep `updatePhase` generic — it already folds `Partial<PhaseRow>`). Add
  `PhaseVisitRow` plus `insertPhaseVisit`, `updatePhaseVisit`, and
  `listPhaseVisits(db, phaseId)`. Extend `EnvelopeRow`/`insertEnvelope` to carry
  `visit_id`. Tests: extend `test/daemon/db.test.ts` with round-trip cases for a
  `phase_visits` row (FKs enforced) and an envelope carrying `visit_id`. No
  caller behavior changes yet (writers still pass the old fields; new ones are
  optional). Green check: tsc + bun test test/.

- **2.3 — populate on the write side (domain).** In `src/daemon/runner.ts`:
  `createRunRows` fills `ordinal` (phase index), `agent_model`,
  `require_approval`, `on_fail_to`, `gate_names` (from `gateName(g,i)`), and
  `context_entries` when it inserts each phase (it already has the
  `Blueprint`/`BlueprintPhase` in hand and already computes gate names for the
  snapshot). `driveVisit` inserts a `phase_visits` row at visit start (cause =
  the `PhaseStartCause` it already builds; status transitions on
  end) and threads its id into the `agentSessionId` link and into
  `runEnvelopeStage` so `recordAttemptRow` (in
  `src/daemon/envelope-runner.ts`) sets `envelopes.visit_id`. Tests: extend
  `test/daemon/runner.test.ts` to assert a completed run has one `phase_visits`
  row per visit with the right cause/status and that its envelopes carry
  `visit_id`. Green check: tsc + bun test test/.

- **2.4 — best-effort backfill for pre-v3 rows.** New `src/daemon/backfill-v3.ts`
  (kept separate from `src/daemon/backfill.ts`, which does event backfill). A
  pure, idempotent function `backfillV3(db)` that: derives each phase's
  `ordinal` from `phases` insertion order per run, copies `agent_model` from the
  run's `blueprint.json` snapshot when present, and synthesizes `phase_visits`
  from the distinct `(phase_id, visit)` pairs across `envelopes` +
  `agent_sessions`, then sets `envelopes.visit_id` by matching
  `(phase_id, visit)`. Call it once from `migrate()`'s caller `openDb` AFTER
  `migrate` returns — never inside the migration transaction, so a backfill bug
  can never brick `openDb`/DDL. Guard it to run only when unbackfilled rows
  exist (idempotent re-run is a no-op). Tests: new `test/daemon/backfill-v3.test.ts`
  builds a v2-shaped DB by hand (raw `INSERT`s), runs `backfillV3`, and asserts
  the synthesized visits + `visit_id` links; run it twice to prove idempotency.
  Green check: tsc + bun test test/.

Risk / de-risk:
- **Backfill is the ambiguous part.** The doc says backwards compat does not
  matter (no users), so backfill is best-effort, not load-bearing. De-risk by
  (a) keeping it OUT of the DDL transaction, (b) making it a standalone tested
  function over a hand-built fixture DB, and (c) guarding on "unbackfilled rows
  exist" so it is a safe no-op on fresh and already-migrated DBs. If synthesis
  proves fiddly, the fallback the doc explicitly allows is to drop stale
  `phases`/`envelopes` visit data at migrate time instead of synthesizing — but
  prefer synthesis since it is cheap and additive.
- **The `visit_id` FK add** is safe only because it is nullable; do not try
  `NOT NULL` or a table rebuild.
- **Atomicity:** 2.1 (DDL) must land as one commit; it can ship as its own PR.
  2.2/2.3 (writers + domain population) should land together or back-to-back so
  new runs write the new columns. 2.4 (backfill) is fully independent and can be
  a separate PR. Order matters only in that 2.3 depends on 2.2's writers.

### Step 3 — `src/view-models/` with `PhaseRecordModel`

Goal: create the read-side layer and move the hottest assembly
(`phase-data.ts` gathers + the phase controller's per-proxy shaping) into one
`PhaseRecordModel`.

- **3.1 — create the layer, no behavior change.** New `src/view-models/index.ts`
  (barrel) and `src/view-models/phase-record.ts` exporting a pure
  `buildPhaseRecordModel(db, dataDir, runId, phaseName)` that returns the union
  of what the six phase proxies serve today (snapshot+context, inputs, outputs,
  spend, envelopes, gates, visit history). It calls existing `db.ts` readers and
  the `handoff.ts` fs readers — no SQL of its own, no HTTP, no React. Port the
  logic from `src/ui/app/lib/phase-data.ts` (`gatherPhaseSnapshot`,
  `gatherPhaseInputs`, `gatherPhaseOutputs`, `gatherPhaseSpend`,
  `isFirstBlueprintPhase`, `describeContextEntries`) verbatim first; do not yet
  change callers. Tests: new `test/view-models/phase-record.test.ts` over a
  seeded DB + run dir. Green check: tsc + bun test test/.

- **3.2 — point the phase controller at the model.** In
  `src/ui/app/actions/runs/phases/controller.tsx`, replace the
  `gatherPhase*`/`isFirstBlueprintPhase` calls with `buildPhaseRecordModel`
  (the proxies now slice fields off the one model). Keep the wire shapes
  byte-identical so `test/ui/phase-proxies.test.ts` and
  `test/ui/run-detail.test.ts` stay green without edits. Green check: tsc + bun
  test test/.

- **3.3 — retire the moved gathers.** In `src/ui/app/lib/phase-data.ts`, delete
  the functions now living in the view model and re-export the model's field
  slices if any other importer still needs the old names (grep first:
  `run-detail`/`phases` controllers). Update `test/ui/run-detail.test.ts` only
  if it imported the gathers directly. Green check: tsc + bun test test/.

Risk / de-risk: `phase-data.ts` today both reads files AND assembles; the split
is exactly the doc's intent (workspace = reader in step 4, model = assembler
here). De-risk by porting logic unchanged in 3.1 and switching callers in 3.2 so
any diff is a pure move; the wire-shape tests are the safety net. This step is
one PR, but 3.1 can land alone (dead-but-tested code) if HEAD is churning.

### Step 4 — Phase workspace module (filesystem persistence)

Goal: turn `src/daemon/handoff.ts` into the filesystem sibling of `db.ts` with
an explicit readers/writers split, without breaking its ~7 importers.

- **4.1 — introduce the module as a façade.** New `src/daemon/workspace/index.ts`
  that re-exports the current `handoff.ts` surface, split into
  `workspace/writers.ts` (`materializeHandoff`, `recordAcceptedEnvelope`,
  `writeAgentMap`, output capture) and `workspace/readers.ts`
  (`readHandoffInputs`, `readOutputsDir`, `readAgentMap`, `resolveContext`, the
  path helpers). Move the implementation file-by-file; keep `handoff.ts`
  re-exporting from the new module so every existing import path
  (`src/daemon/runner.ts`, `envelope-runner.ts`, `backfill.ts`, `index.ts`,
  `server.ts`, `src/ui/app/lib/phase-data.ts`, `test/ui/phase-proxies.test.ts`)
  keeps compiling untouched. Tests: existing `test/daemon/handoff.test.ts`
  covers behavior; add nothing new yet. Green check: tsc + bun test test/.

- **4.2 — repoint first-party importers, keep the shim.** Update
  `src/daemon/*` and `src/view-models/phase-record.ts` to import from
  `src/daemon/workspace/` directly. Leave the `handoff.ts` shim in place for the
  test file to avoid touching test imports mid-move. Green check: tsc + bun test
  test/.

- **4.3 — drop the shim.** Repoint `test/ui/phase-proxies.test.ts` and
  `src/daemon/index.ts`'s re-exports to `workspace/`, delete `handoff.ts`.
  Green check: tsc + bun test test/.

Risk / de-risk: the only risk is an import-path miss. De-risk by keeping the
`handoff.ts` re-export shim through 4.1–4.2 so the move is invisible, then
deleting it last. Each sub-commit is independently green; 4.3 can be its own PR.

### Step 5 — Daemon view models; thin `server.ts`

Goal: move the `apiStats`/`apiListRuns`/`apiRunDetail`/`apiSpend`/`apiTimeline`
derivations into `src/view-models/`, leaving `server.ts` a protocol adapter.

- **5.1 — RunStatsModel.** New `src/view-models/run-stats.ts` with
  `buildRunStats(db, pool)` holding the exact JS fold now in `apiStats`
  (`runPhaseExtents` + `runSpendSplit`, day buckets, success rate, avg
  duration). `apiStats` in `src/daemon/server.ts` becomes a one-line call.
  Keep the `RunStats` contract shape identical. Tests:
  `test/daemon/stats.test.ts` stays green as-is; add
  `test/view-models/run-stats.test.ts` exercising the fold directly. Green
  check: tsc + bun test test/.

- **5.2 — RunListModel.** New `src/view-models/run-list.ts`
  (`buildRunList(db, pool)`) absorbing `apiListRuns` (the `runPhaseExtents`
  merge + `phaseStatusCounts` + queue position). `apiListRuns` delegates. Green
  check: tsc + bun test test/.

- **5.3 — RunDetailModel + timeline.** New `src/view-models/run-detail.ts`
  wrapping `apiRunDetail`'s assembly (phase spend, sessions, counts, optional
  `?full=1` sweep) and delegating timeline to the existing
  `src/daemon/timeline.ts` `buildTimelineView` (leave that module where it is;
  the view model just calls it). `apiRunDetail`/`apiTimeline`/`apiSpend`
  delegate. Green check: tsc + bun test test/.

Risk / de-risk: `server.ts` derivations are already pure folds over `db.ts`
rollups, so each move is mechanical. De-risk by delegating (server keeps the
route, calls the model) rather than relocating routes — the contract tests
(`test/daemon/contract.test.ts`, `server.test.ts`) are the net. Each of
5.1/5.2/5.3 is an independent PR.

### Step 6 — UI live-snapshot adapter

Goal: one client-side module owns the SSE→refetch transport; the list, stats,
and detail regions stop hand-rolling it.

- **6.1 — the adapter, tested in isolation.** New
  `src/ui/app/actions/public/live-snapshot.ts` composing the existing
  `subscribeSse` + `createCoalescedNotifier` from
  `src/ui/app/actions/public/sse.ts` into a transport that owns: subscription
  lifecycle, coalescing, the in-flight guard, the one-shot transient-retry
  timer, and a caller-supplied stop predicate (terminal / 404-gone). Model it on
  the richest current implementation in
  `src/ui/app/actions/public/run-live-region.tsx` (the `inflight` set,
  `retryTimer`, terminal freeze). Tests: new
  `test/ui/live-snapshot.test.ts` for the scheduling/guard/retry logic (pure,
  no DOM — same style as the `sse.ts` notifier tests). Green check: tsc + bun
  test test/.

- **6.2 — single-snapshot regions.** Switch
  `src/ui/app/actions/public/run-list-live.tsx` and
  `run-stats-region.tsx` to the adapter (one wake-up → one JSON-proxy refetch →
  replace snapshot). View state (selection/sort/search/URL mirroring) stays in
  the region. Green check: tsc + bun test test/.

- **6.3 — run-detail region.** Switch
  `src/ui/app/actions/public/run-live-region.tsx` to the adapter, passing its
  parallel events+timeline+raw-tail fetch and cursor merge as the apply-callback
  so the transport stays generic. Green check: tsc + bun test test/.

Risk / de-risk: run-detail is the hard one (parallel fetch + cursor merge +
retry + terminal/gone stop). De-risk by extracting the adapter from
run-detail's own logic first (6.1), converting the two simple regions to prove
the API (6.2), then converting run-detail last (6.3) so its behavior is the
reference, not a guess. Each region conversion is an independent PR.

### Step 7 — Starter-kit materialization + blueprint-stack collapse

Goal: templates in `src/starter-kit/` are materialized into `~/.showrunner/`
and loaded from there at runtime; collapse the duplicated phase stacks.

- **7.1 — copy-if-absent bootstrap.** New `src/daemon/templates.ts` with
  `materializeTemplates(dataDir)` that copies `src/starter-kit/**` into
  `<dataDir>/templates/` only for files that do not already exist (never
  clobber). Call it once from `startDaemon` in `src/daemon/daemon.ts` right
  after `mkdirSync(dataDir)`. `resolveDataDir()` already defaults to
  `~/.showrunner` (`src/core/data-dir.ts`), so no path invention. Tests: new
  `test/daemon/templates.test.ts` over a temp `SHOWRUNNER_DATA_DIR` asserting
  copy-if-absent + no-clobber. Green check: tsc + bun test test/.

- **7.2 — sync CLI command.** Add a `templates sync` subcommand in
  `src/cli/index.ts` (add-only for missing files; report drift for existing
  files; overwrite only on confirm). Tests: extend `test/cli/e2e.test.ts` with a
  sync-adds-missing case. Green check: tsc + bun test test/.

- **7.3 — collapse duplicated blueprint stacks.** With templates decoupled from
  runtime, factor the repeated phase patterns across
  `src/starter-kit/blueprints/*.ts` into a small shared catalog
  (`src/starter-kit/blueprints/patterns.ts`), rewriting the ten blueprints to
  compose from it. Keep each blueprint's exported name/shape identical so
  `src/starter-kit/index.ts` and `test/starter-kit/*` stay green. Green check:
  tsc + bun test test/.

Risk / de-risk:
- **Keeping tests green through the load-path switch.** Tests import from
  `src/starter-kit/**` directly (9 files, e.g. `test/starter-kit/gates.test.ts`,
  `test/daemon/server.test.ts`) and the CLI still accepts an explicit
  `run <blueprint.ts>` path. Materialization only adds a runtime *copy* the
  daemon bootstraps; it does not remove or move the source tree, so no test
  import breaks. Do NOT delete `src/starter-kit/` — it stays the template
  source. De-risk 7.1 by scoping the copy to a temp data dir in tests so a
  developer's real `~/.showrunner` is never touched.
- 7.1/7.2/7.3 are independent PRs. 7.3 (collapse) is pure refactor and can land
  anytime; keep it last so it does not collide with 7.1's bootstrap.

### Step 8 — Gate stage enforcement + gate-family split

Goal: make envelope-shape validation a runtime backstop in the stage, drop the
redundant per-blueprint `envelopeShape(SameEnvelope)` gates, and split the gate
library into focused families.

- **8.1 — assert the backstop already holds.** `runEnvelopeStage` in
  `src/daemon/envelope-runner.ts` already zod-parses `envelope.json` against
  `phase.envelope` before gates run, returning `invalid` on failure. Add a test
  in `test/daemon/envelope-runner.test.ts` pinning that a malformed envelope is
  rejected by the stage even when the phase's `gates` array is empty — this is
  the invariant that makes the per-blueprint shape gates removable. Green check:
  tsc + bun test test/.

- **8.2 — drop the redundant blueprint gate call sites.** Remove the
  `envelopeShape(<SameSchema>)` entries from the seven starter blueprints
  (`build.ts`, `build_review.ts`, `document.ts`, `everything.ts`, `plan.ts`,
  `plan_build.ts`, `plan_build_test.ts`) — each re-parses the same schema the
  stage already parsed, so it is an always-passing gate row. KEEP the
  `envelopeShape` factory exported from `src/starter-kit/gates/index.ts` and its
  unit test (`test/starter-kit/gates.test.ts:163`, which uses a *different*
  schema — the legitimate stricter-contract use). Update expectations in tests
  that count gate rows or list gate names for these blueprints
  (`test/daemon/server.test.ts`, `test/daemon/smoke/*` if driven, and the
  `snapshotBlueprint` gate-name lists). Update `src/starter-kit/README.md`'s gate
  column. Green check: tsc + bun test test/.

- **8.3 — split gate families.** Break `src/starter-kit/gates/index.ts` (419
  lines) into `gates/command.ts` (`testsPass`, `lintClean`, `workspaceShell`),
  `gates/handoff.ts` (`matchesPlan`), `gates/file.ts` (`filesExist`,
  `findingsReported`), `gates/verdict.ts` (`reviewApproved`), `gates/envelope.ts`
  (`envelopeShape`), and shared helpers in `gates/shared.ts`
  (`violation`, `tail`, `shq`, `findUp`, `nearestScripts`, …). `gates/index.ts`
  becomes a roster barrel re-exporting the same names so
  `src/starter-kit/index.ts` and `test/starter-kit/gates.test.ts` imports do not
  change. Green check: tsc + bun test test/.

Risk / de-risk:
- **Dropping `envelopeShape` without breaking gate tests.** The trap is that
  removing the call sites changes gate-result counts and gate-name lists in
  fixture-driven tests. De-risk by landing 8.1 (the backstop pin) first so the
  safety net exists, then removing call sites in 8.2 and updating the exact
  count/name expectations in the same commit. Keep the `envelopeShape` *function*
  and its unit test — only the redundant *usages* go.
- 8.3 is a pure move behind the `gates/index.ts` barrel — an independent PR.
- 8.1/8.2 should land together or back-to-back (the backstop test justifies the
  removal); 8.3 is fully separable.
