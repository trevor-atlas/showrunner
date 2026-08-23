import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataDir, socketPathFor, dbPathFor } from "@showrunner/core";

import { openDb } from "./db.ts";
import { createDaemonServer } from "./server.ts";

/**
 * The long-lived daemon (spec §2.1): owns SQLite, serves the local HTTP API on
 * a unix socket, and (in the full build) spawns pi. T01a's daemon serves the
 * observation pipeline: submit fixture runs, list them, and stream the event
 * cursor.
 */

export interface DaemonHandle {
  dataDir: string;
  socketPath: string;
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

export function startDaemon(opts: { dataDir?: string } = {}): DaemonHandle {
  const dataDir = opts.dataDir ?? resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  // pidfile guard: never unlink a live daemon's socket
  const pidFile = join(dataDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && isProcessAlive(pid)) {
      throw new Error(`daemon already running (pid ${pid}) at ${socketPathFor(dataDir)}`);
    }
  }

  const db = openDb(dbPathFor(dataDir));
  const socketPath = socketPathFor(dataDir);
  const server = createDaemonServer({ db, dataDir });

  try {
    unlinkSync(socketPath); // stale socket from a dead daemon
  } catch {
    // nothing to unlink
  }
  server.listen({ path: socketPath });
  writeFileSync(pidFile, `${process.pid}\n`);

  return {
    dataDir,
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        // already gone
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
