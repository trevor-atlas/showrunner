import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

  // pidfile guard: never unlink a live daemon's socket
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    // the pidfile holds two lines: pid, then port
    const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]?.trim());
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      throw new Error(`daemon already running (pid ${pid}) for data dir ${dataDir}`);
    }
  }

  const db = openDb(dbPathFor(dataDir));
  // crash recovery, in reap-then-restore order:
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

  const pool = new RunPool(opts.poolSlots ?? POOL_SLOTS);
  const server = createWebServer({ db, dataDir, pool, startedAt: Date.now() });

  // Bind 127.0.0.1:<port>. A failed bind logs and the daemon keeps running
  // WITHOUT a server (in-process consumers — the UI actions — still work);
  // the pidfile is only written after a SUCCESSFUL bind.
  const port = resolvePort(opts);
  let boundPort: number | null = null;
  let listening = false;
  let bindError: unknown = null;
  await new Promise<void>((resolve) => {
    server.once("error", (err) => {
      bindError = err;
      resolve();
    });
    server.listen(port, "127.0.0.1", () => {
      listening = true;
      const addr = server.address();
      boundPort = addr !== null && typeof addr === "object" ? (addr as AddressInfo).port : port;
      resolve();
    });
  });

  let keepAlive: ReturnType<typeof setInterval> | null = null;
  if (!listening) {
    console.error(
      `showrunner daemon: failed to listen on http://127.0.0.1:${port} (${bindError instanceof Error ? bindError.message : String(bindError)}) — continuing without a web server`,
    );
    // with no server handle, nothing keeps the event loop alive — pin it so
    // "the daemon keeps running" is literally true (in-process consumers)
    keepAlive = setInterval(() => {}, 2_147_000_000);
  } else {
    // two lines: pid, then the bound port (T3 reads the port from here)
    writeFileSync(pidFile, `${process.pid}\n${boundPort}\n`);
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
          const { warmEntryAssets } = await import("../ui/app/actions/document.tsx");
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
    port: boundPort ?? port,
    baseUrl: `http://127.0.0.1:${boundPort ?? port}`,
    close: async () => {
      // graceful shutdown (T07): stop recorded children (SIGTERM →
      // SIGKILL after 1s) — events are already durable, nothing is persisted
      stopRecordedChildren(db);
      if (keepAlive !== null) clearInterval(keepAlive);
      if (listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
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
 * (close the server, remove the pidfile, close the DB).
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
