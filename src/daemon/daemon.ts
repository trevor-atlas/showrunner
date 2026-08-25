import { mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { resolveDataDir, dbPathFor } from "../core/index.ts";

import { openDb } from "./db.ts";
import { cleanupProcesses, reconcileInterruptedRuns, stopRecordedChildren } from "./pause-control.ts";
import { backfillMissedEvents } from "./backfill.ts";
import { RunPool } from "./pool.ts";
import { materializeTemplates } from "./templates.ts";
import { createWebServer, getRouter } from "./web.ts";

/**
 * The long-lived daemon: owns SQLite and serves BOTH the JSON
 * API (under /api/*) and the remix dashboard on ONE TCP listener (default
 * 127.0.0.1:44100, src/daemon/web.ts). The dashboard lives "under the remix
 * side": the same process that owns the data serves the web UI.
 */

export interface DaemonHandle {
  dataDir: string;
  /** the TCP port the merged web server listens on (ephemeral when 0 was passed) */
  port: number;
  /** "http://127.0.0.1:<port>" — what the typed client connects to */
  baseUrl: string;
  close(): Promise<void>;
}

/** pool size override (default: SHOWRUNNER_POOL_SIZE ?? 2) — test seam */
const POOL_SLOTS = Number(process.env.SHOWRUNNER_POOL_SIZE ?? "2") || 2;

/** The port the daemon binds: explicit option > SHOWRUNNER_PORT > PORT (the
 * remix HMR dev chain sets PORT when it spawns the dev server) > 44100.
 * 0 = ephemeral: the OS picks a free port (read back from server.address()). */
function resolvePort(opts: { port?: number }): number {
  if (opts.port !== undefined) return opts.port;
  return Number(process.env.SHOWRUNNER_PORT ?? process.env.PORT ?? "44100");
}

export async function startDaemon(opts: { dataDir?: string; poolSlots?: number; port?: number } = {}): Promise<DaemonHandle> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
  // Materialize the starter kit into <dataDir>/templates/ (copy-if-absent):
  // seeds missing files on first boot, never clobbers a user's own edits.
  materializeTemplates(dataDir);

  const db = openDb(dbPathFor(dataDir));
  const pool = new RunPool(opts.poolSlots ?? POOL_SLOTS);
  const server = createWebServer({ db, dataDir, pool, startedAt: Date.now() });

  // Double-boot guard, bind-based: a FIXED port already in use means another
  // daemon owns this data dir. A dead process holds no socket, so EADDRINUSE
  // is proof of a LIVE daemon — there is no stale file to reap. Ephemeral
  // (port 0) can never collide: the OS always hands back a free port, so no
  // guard is meaningful there. The bind is claimed BEFORE crash recovery so a
  // losing second boot never touches the shared DB.
  const port = resolvePort(opts);
  let boundPort: number;
  try {
    boundPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: unknown): void => reject(err);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const addr = server.address();
        resolve(addr !== null && typeof addr === "object" ? (addr as AddressInfo).port : port);
      });
    });
  } catch (err) {
    // release the DB handle this losing boot opened before surfacing the error
    db.close();
    if (port !== 0 && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(`daemon already running for data dir ${dataDir} (port ${port} in use)`);
    }
    throw err;
  }

  // crash recovery, in reap-then-restore order (safe now that we own the port):
  //   orphan cleanup — sweep the processes table: dead-pid rows are
  //   removed, ALIVE pids are orphaned children of a SIGKILLed daemon and are
  //   SIGTERM'd (SIGKILL after 1s) and removed.
  const orphans = cleanupProcesses(db);
  //   crash surfacing — runs left `running` become `interrupted` (the
  //   children are already reaped above; a human continue comes via resume).
  const interrupted = reconcileInterruptedRuns(db);
  //   backfill — restore the session tail the daemon missed while down
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

  {
    // Production boot-time asset warm: eagerly import the dashboard router and
    // compile the entry asset graph so the FIRST GET / is a cache hit rather
    // than paying the compile cost on the request path. Remix's asset compile
    // cache is in-memory PER PROCESS (AssetServer exposes only
    // fetch/getHref/getPreloads/close —
    // node_modules/@remix-run/assets/dist/lib/asset-server.d.ts — backed by an
    // in-memory ModuleStore, .../lib/module-store.d.ts), so the warm MUST run
    // in this process; the `build` script cannot precompile for it. Fired after
    // bind (never awaited before it) so it cannot deadlock the listener. A warm
    // failure is logged and does NOT kill the daemon — the first request then
    // surfaces the error and retries. Development stays lazy (needs watch+hmr).
    if ((process.env.NODE_ENV ?? "development") === "production") {
      void (async () => {
        try {
          await getRouter();
          const { warmEntryAssets } = await import("../server/actions/document.tsx");
          await warmEntryAssets();
        } catch (err) {
          console.error(
            `showrunner daemon: boot-time asset warm failed (${err instanceof Error ? err.message : String(err)}) — the first request will retry`,
          );
        }
      })();
    }
  }

  return {
    dataDir,
    port: boundPort,
    baseUrl: `http://127.0.0.1:${boundPort}`,
    close: async () => {
      // graceful shutdown (T07): stop recorded children (SIGTERM →
      // SIGKILL after 1s) — events are already durable, nothing is persisted
      stopRecordedChildren(db);
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
 * (close the server, close the DB). The daemon's HTTP shutdown endpoint
 * (POST /api/shutdown) rides this same path by signalling the process.
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
  try {
    const handle = await startDaemon({ dataDir });
    console.log(`showrunner daemon listening on ${handle.baseUrl} (pid ${process.pid})`);
    installSignalHandlers(handle);
  } catch (err) {
    console.error(`showrunner daemon: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
