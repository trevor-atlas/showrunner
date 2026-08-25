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
 * The merged web server's in-process state holder (Phase 2 / T4): the server
 * builds its state (db, dataDir, pool, startedAt) once and hands it to
 * createWebServer, which registers it here. The remix dashboard's server-side
 * data layer (src/server/lib/model.ts) calls the api core functions
 * IN-PROCESS against this state — the unix socket and the self-round-trip
 * ServerClient are gone, and the UI and the server share one process.
 *
 * A "server down" page state is impossible: there is no socket to miss. The
 * server never imports the UI graph (the dashboard router is lazily imported
 * by src/server/transport/http.ts), so the state holder lives server-side and the UI
 * imports it (ui→server is the only allowed direction).
 */

let webState: ApiState | null = null;

/** Register the server's state (called by createWebServer after it is built). */
export function setServerState(state: ApiState): void {
  webState = state;
}

/** The server's state, or a server-side ApiError(503) when no web server has
 * been created yet (defensive: the dashboard only runs under the server, but
 * a stray direct router import must not surface a TypeError). */
export function requireServerState(): ApiState {
  if (webState === null) {
    throw new ApiError(503, "server not running");
  }
  return webState;
}
