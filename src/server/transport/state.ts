import type { Database } from "bun:sqlite";
import { ApiError } from "../contract.ts";
import type { RunPool } from "../engine/pool.ts";

export interface ApiState {
  db: Database;
  dataDir: string;
  /** pool — owned by the caller (hoisted out of the server) */
  pool: RunPool;
  startedAt: number;
}

/**
 * The merged web server's in-process state holder (Phase 2 / T4): the daemon
 * builds its state (db, dataDir, pool, startedAt) once and hands it to
 * createWebServer, which registers it here. The remix dashboard's server-side
 * data layer (src/server/lib/daemon.ts) calls the api core functions
 * IN-PROCESS against this state — the unix socket and the self-round-trip
 * DaemonClient are gone, and the UI and the daemon share one process.
 *
 * A "daemon down" page state is impossible: there is no socket to miss. The
 * daemon never imports the UI graph (the dashboard router is lazily imported
 * by src/daemon/web.ts), so the state holder lives daemon-side and the UI
 * imports it (ui→daemon is the only allowed direction).
 */

let webState: ApiState | null = null;

/** Register the daemon's state (called by createWebServer after it is built). */
export function setWebState(state: ApiState): void {
  webState = state;
}

/** The daemon's state, or a server-side ApiError(503) when no web server has
 * been created yet (defensive: the dashboard only runs under the daemon, but
 * a stray direct router import must not surface a TypeError). */
export function requireWebState(): ApiState {
  if (webState === null) {
    throw new ApiError(503, "daemon not running");
  }
  return webState;
}
