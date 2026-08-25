# Showrunner — Implementation Record

Ticket-driven build (GitHub issues #1–#20), each round gated by an independent
adversarial review, with git-tag rollback points. Only the recent rounds are
kept here; the earlier history (T01a through the audit label) is rolled up in
the entries below.

## What shipped (recent rounds)

| Round | Tickets | Delivered |
|---|---|---|
| 11 | PR #21 (merge) | One-package merge: the five `packages/*` became `src/*` directories (single tsconfig, single node_modules, single cwd; `packages/*` deleted). **FakePi flip**: `SHOWRUNNER_FAKE=1` = scripted sessions, real pi is the default (auto-detected). **Merged web server**: the unix socket is GONE — `src/daemon/web.ts` (`createWebServer`) serves ONE TCP listener on `127.0.0.1:44100` for both the JSON API (now under the `/api` prefix; `/api/health`, `/api/status` added) and the dashboard (remix router imported **lazily**; first dashboard hit may 503 "dashboard warming up" then 200); `startDaemon` is async (`{ dataDir, port, baseUrl, close() }`; pidfile = pid + port); `SHOWRUNNER_PORT` replaces `SHOWRUNNER_DASHBOARD_PORT` and `SHOWRUNNER_DAEMON_URL` (deleted); UI actions call the api core IN-PROCESS via `requireWebState()` (no socket round trip, no `DaemonClient` in the UI, no `DaemonDownBanner`); `src/daemon/dashboard.ts` deleted; dev flow = `bun --watch src/ui/server.ts` / `bun --watch src/daemon/daemon.ts` / `bun hmr` (hmr.ts unchanged). **Environment note**: this machine's Gatekeeper daemon (`syspolicyd`) wedged at 100% CPU, hanging every NAPI addon load (oxc-parser/transform, lightningcss — remix's asset compiler) in dyld; remedy was killing `syspolicyd`; the lazy assets/router seams keep compile work out of daemon startup regardless. |
| 12 | Phase timeline (spec: build spec, 5 rounds) | **R1** phase-row revisit lifecycle: `started_at` stamped once (lifetime start, never overwritten), `ended_at` cleared + `corrections` reset at every visit start — the invariant "in_progress ⇒ ended_at IS NULL" is now enforced and regression-tested. **R2** `phase_start.cause` (zod-optional, back-compatible): `flow` / `on_fail {from_phase, from_visit}` / `human {action, by?}`, stamped at every visit-start path (forward flow, on_fail jump target only, steer/restart/resume redrives; approve stays flow). **R3** `GET /api/runs/:id/timeline`: per-visit segments folded from `phase_start`/`phase_end` events read via the (run_id, rowid) cursor, blueprint-order phases (snapshot → first-start fallback), per-visit corrections/attempts + cause, open-segment outcomes (in_progress / interrupted). **R4/R5** run-detail timeline chart (replaced the single-bar gantt): per-phase rows, per-visit bubbles in status colors, correction badges, revisit arrows, tooltips/aria, ?phase= deep-link selection, and the detail panel (visit history with cause banners, lazy envelopes/gates via `.json` proxies, gates with override badges, collapsible sessions). **R6** live behavior: the 1s poll refetches timeline.json, open bubbles grow toward now, paused stripe + pause reason surfaced, interrupted outcome renders. **R7** `demo-loop` fixture (plan→implement→review→package, review `budget:1` + `on_fail→implement`) with a per-visit scripting seam (`byVisit?`, strictly additive), driven end-to-end: 1/2/2/1 segments, on_fail cause provenance, mid-run R1 snapshot, pre-R2 "reason not recorded", 4 rows / 6 bubbles / 1 arrow / correction badge, ?phase interaction, paused-run growth, convention checks. **Orchestrator resolution**: R7's `envelope_attempts=2` required counting from the `envelopes` table (the daemon emits the `envelope` event only on acceptance, so event-counting reported 0 for a rejected visit) — the endpoint now folds per-(phase, visit) attempt counts from the per-attempt table rows, matching the drill-in's "attempts" semantics. |
| 13 | issue #78 | **Removed the daemon pidfile**: `<dataDir>/daemon.pid` is gone — never written or read. **Double-boot guard is now bind-based**: in `src/daemon/daemon.ts` a FIXED-port `listen` that fails with `EADDRINUSE` is remapped to a clear "daemon already running for data dir <dir> (port <port> in use)" error; ephemeral (`port: 0`) binds are never guarded (the OS always picks a free port), so in-process/test daemons can share a data dir. **CLI discovery**: `daemonBaseUrl()` (`src/cli/daemon-lifecycle.ts`) uses the fixed default port (`SHOWRUNNER_PORT ?? 44100`) instead of reading the pidfile's port line. **stop / status**: `stop` POSTs a new `POST /api/shutdown` (`src/daemon/server.ts` `apiShutdown` → flush 200 then self-`SIGTERM` into the existing graceful signal handler; `src/daemon/client.ts` gained `shutdown()`) and polls until the daemon is down; `status` health-checks the known port; no pid is read from a file. **Preserved**: ephemeral `port: 0` still works and the returned daemon still exposes its real bound port; spawned-daemon test helpers now pick a free port up front and pass it via `SHOWRUNNER_PORT`. **Key decision**: kept ephemeral support (tests depend on it) while making the CLI rely on the fixed configured port for discovery — that is why the pidfile's port-discovery role could be dropped. |

## Verification state

- Full suite green and `tsc --noEmit` clean at the last round review.
- Capstone smoke (real pi, real repo, env-gated): correction on one session,
  gates, steer, override, approve, crash, backfill, poll tool runtime.
- UI: server-side only, no CORS, no browser→daemon path, NOT-React verified
  (grep + code read), remix pinned exact.
- All 20 GitHub issues closed with summary comments.

## Pinned decisions

- Daemon owns spawn + the SQLite write path (one long-lived process;
  `processes` table; crash recovery via JSONL backfill).
- Context transfers as strings with a literal-vs-path rule (no escape syntax;
  a collision reads the file).
- remix@next `3.0.0-beta.10` pinned for the dashboard.

## Follow-ups (documented, not blocking)

- **Live-region fault coupling**: the run-detail poll applies the events page and the timeline page atomically — a persistent `timeline.json` non-404 failure stalls the feed too (the old single-fetch isolated events). Same-origin in-process proxy makes this unlikely; documented in code.
- **Steer-caused visits unreachable at runtime**: `RunControl.steer()` queues and stays paused — it never resolves a pause waiter — so the loop's steer redrive branch and its `human` cause stamp are typed but unexercised. Wiring is defensive; revisit if a pause-continuation-with-steer path appears.
- **Blueprint-order fallback divergence**: the timeline endpoint's no-snapshot fallback uses the FIRST `phase_start` order; the old UI helper used last-start. First-start is correct for a backward on_fail jump; the two readers can disagree for fixture runs without a snapshot. Unify if the divergence ever bites.
- **Unreproduced full-suite timeout**: one 30s timeout in 1 of 9 full-suite runs, no test name captured, zero R7-file involvement; watch during future CI runs.
- **`freePort()` TOCTOU (issue #78)**: the spawned-daemon test helpers' `freePort()` has an inherent TOCTOU window, and the pause-control kill-and-reboot rebinds the same fixed port — guarded (waits for daemon-down before reboot; `SO_REUSEADDR`) and passing today, but a latent low-probability CI flake vector worth noting.
- `matchesPlan` (starter-kit) has a duplicated identical if/else branch (dead code; starter-kit is the replace-this surface).
- The smoke's poll-tool scenario redirects `PI_CODING_AGENT_SESSION_DIR` for scenarios 1–3 but scenario 4 spawns real pi with inherited env — a session dir can land in `~/.pi/agent/sessions` (cosmetic; outside the repo).
- `needs_review` semantics pinned in code (T04): mid-tool-call death flags at crash; any resume from `interrupted` re-flags; interruption alone does not.
- Spend pagination in the UI caps at 100k events with a visible truncated marker (was silently capped at 5000; T11 review).
- The live region freezes the timeline chart on terminal transitions (round-8 polish) but does not yet page old events beyond the initial history sweep (10k cap, T10a).
- By-design divergences recorded: steer on a paused run is queued + delivered on continuation (T13 `drainQueuedSteers`), audited `by` defaults to `"cli"` for CLI callers and `"web"` for the dashboard.
