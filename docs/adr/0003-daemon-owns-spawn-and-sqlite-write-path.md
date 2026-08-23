# The daemon owns spawn and the SQLite write path

**Status**: accepted

The original spec sketched the CLI and the daemon as two peers around the same
SQLite database. As the implementation hardened (rounds T01b–T13), the daemon
became the single long-lived owner of execution (§2.1): it opens the database,
owns every write (run/phase/session rows, the events log, gate results,
envelopes, processes), spawns and reaps pi children (§8), folds the raw stream
through the tracer (§7), and serves the local HTTP API on a unix socket (§13).
The CLI is a thin client over that socket, and the UI (remix@next) is a
server-side client of the same API — no other process ever opens the database
for writing.

The reasons this won:

- **One writer, no locking tax.** The events log is append-only and the sink
  drains on the daemon's event loop; a second writer would need coordination
  for no benefit.
- **Crash recovery is a daemon concern.** Orphan reaping (§12.1), interrupted
  surfacing (§12.2), and session-tail backfill (§12.4) all run at daemon start
  in reap-then-restore order — they need the DB and the process table together,
  which only the daemon has.
- **The pool is server-side.** The §5.4 spawn gate (N concurrent runs, F1's
  paused-runs-hold-slots) must serialize across runs; that state lives in the
  daemon process.
- **The control surface is in-process.** Steer/approve/override/fail dispatch
  through a per-run control registry that only exists in the daemon process; a
  paused run after a daemon restart has no handle and answers 409 — the honest
  response, surfaced as such (§13).

The CLI therefore never opens SQLite; it talks HTTP over the unix socket
(`unix://~/.showrunner/daemon.sock`, honoring `SHOWRUNNER_DATA_DIR`), with an
`SHOWRUNNER_DAEMON_URL` HTTP-mode override for development. The typed
`DaemonClient` (packages/daemon/src/client.ts) is the single shared client for
the CLI and the UI.

**Costs accepted**: a restarted daemon loses the in-memory control registry
(paused runs become viewer-only until the continuation surface handles them),
and the daemon process is a single point of failure for live control — recovery
is exactly the §12 interrupted/resume path.
