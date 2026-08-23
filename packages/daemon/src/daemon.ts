import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir, socketPathFor, dbPathFor } from "@showrunner/core";

import { openDb } from "./db.ts";
import { cleanupProcesses, reconcileInterruptedRuns, stopRecordedChildren } from "./pause-control.ts";
import { backfillMissedEvents } from "./backfill.ts";
import { createDaemonServer } from "./server.ts";

/**
 * The long-lived daemon (spec §2.1): owns SQLite, serves the local HTTP API on
 * a unix socket, and (in the full build) spawns pi. T01a's daemon serves the
 * observation pipeline: submit fixture runs, list them, and stream the event
 * cursor.
 */

export interface DaemonHandle {
  dataDir: string;
  /** unix socket path when listening on a unix socket; null in http mode */
  socketPath: string | null;
  /** the daemon's base URL: "unix://<socketPath>" or "http://<host>:<port>" —
   * what the typed client's SHOWRUNNER_DAEMON_URL override points at */
  baseUrl: string;
  close(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function startDaemon(opts: { dataDir?: string; poolSlots?: number; listen?: { port?: number; host?: string } } = {}): DaemonHandle {
  const dataDir = opts.dataDir ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  // pidfile guard: never unlink a live daemon's socket
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      throw new Error(`daemon already running (pid ${pid}) for data dir ${dataDir}`);
    }
  }

  const db = openDb(dbPathFor(dataDir));
  // §12 crash recovery, in reap-then-restore order:
  //   §12.1 orphan cleanup — sweep the processes table: dead-pid rows are
  //   removed, ALIVE pids are orphaned children of a SIGKILLed daemon and are
  //   SIGTERM'd (SIGKILL after 1s, §8.3) and removed.
  const orphans = cleanupProcesses(db);
  //   §12.2 crash surfacing — runs left `running` become `interrupted` (the
  //   children are already reaped above; a human continue comes via resume).
  const interrupted = reconcileInterruptedRuns(db);
  //   §12.4 backfill — restore the session tail the daemon missed while down
  //   (JSONL re-read, deduped against the run's own raw file; idempotent).
  const backfill = backfillMissedEvents(db, dataDir);
  if (orphans.killed.length > 0 || orphans.removed_dead > 0) {
    console.log(`showrunner daemon: reaped ${orphans.killed.length} orphaned child(ren) (${orphans.removed_dead} dead rows removed)`);
  }
  if (interrupted.length > 0) {
    console.log(`showrunner daemon: ${interrupted.length} run(s) interrupted by the previous crash — resume to continue`);
  }
  if (backfill.lines_restored > 0) {
    console.log(`showrunner daemon: backfilled ${backfill.lines_restored} missed line(s) → ${backfill.events_folded} event(s) for ${backfill.sessions.length} session(s)`);
  }
  const socketPath = socketPathFor(dataDir);
  const server = createDaemonServer({ db, dataDir, poolSlots: opts.poolSlots });
  const httpListen = opts.listen;
  let boundSocket: string | null = null;
  let baseUrl: string;
  if (httpListen !== undefined) {
    // dev override: listen on http://host:port so the typed client's
    // SHOWRUNNER_DAEMON_URL (an http base URL) can reach the daemon; the unix
    // socket stays the default transport
    const host = httpListen.host ?? "127.0.0.1";
    server.listen({ port: httpListen.port ?? 0, host });
    const addr = server.address();
    const port = addr !== null && typeof addr === "object" ? addr.port : httpListen.port ?? 0;
    baseUrl = `http://${host}:${port}`;
  } else {
    try {
      unlinkSync(socketPath); // stale socket from a dead daemon
    } catch {
      // nothing to unlink
    }
    server.listen({ path: socketPath });
    boundSocket = socketPath;
    baseUrl = `unix://${socketPath}`;
  }
  writeFileSync(pidFile, `${process.pid}\n`);

  return {
    dataDir,
    socketPath: boundSocket,
    baseUrl,
    close: async () => {
      // graceful shutdown (§13, T07): stop recorded children (SIGTERM →
      // SIGKILL after 1s) — events are already durable, nothing is persisted
      stopRecordedChildren(db);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (boundSocket !== null) {
        try {
          unlinkSync(boundSocket);
        } catch {
          // already gone
        }
      }
      try {
        rmSync(pidFile);
      } catch {
        // already gone
      }
      db.close();
    },
  };
}

/** Absolute path of this entry module - the CLI spawns it as the daemon process. */
export function daemonEntryPath(): string {
  return fileURLToPath(import.meta.url);
}

/**
 * Install SIGINT/SIGTERM handlers that shut the daemon down gracefully
 * (close the server, unlink the socket, remove the pidfile, close the DB).
 * Registered both when daemon.ts is the entry and when the CLI runs
 * `showrunner daemon` in-process. Handlers live for the process lifetime -
 * a daemon, by definition, does not outlive its signal handlers.
 */
export function installSignalHandlers(handle: DaemonHandle): void {
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    console.log(`showrunner daemon: ${signal}, shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let dataDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data-dir" && argv[i + 1]) {
      dataDir = argv[i + 1];
      i++;
    } else if (argv[i]?.startsWith("--data-dir=")) {
      dataDir = argv[i]!.slice("--data-dir=".length);
    }
  }
  let handle: DaemonHandle;
  try {
    handle = startDaemon({ dataDir });
  } catch (err) {
    console.error(`showrunner daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log(`showrunner daemon listening on ${handle.socketPath} (pid ${process.pid})`);
  installSignalHandlers(handle);
}
