import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequestListener } from "remix/node-fetch-server";

import { setEventInsertHook } from "./db.ts";
import { emitRunChange } from "./live.ts";
import { handleApiRequest, type ApiState } from "./server.ts";
import { setWebState } from "./web-state.ts";

/**
 * The daemon's merged web server: ONE node:http listener serving BOTH the
 * JSON API (under `/api/*`, dispatched straight to the api core in
 * src/daemon/server.ts) AND the remix@next dashboard (everything else, via
 * the lazily-imported router).
 *
 * The dashboard router is imported through a dynamic import so the daemon
 * process never loads the UI graph unless a browser actually asks for a page
 * — and `/api/*` is dispatched BEFORE the router promise is ever touched, so
 * the JSON API keeps answering even while the UI import is slow. A dashboard
 * request AWAITS that import (it never 503s); in production the daemon warms
 * the import + entry assets at boot (src/daemon/daemon.ts) so the first
 * request is already a cache hit.
 */

export function isApiPath(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false;
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

type RouterModule = typeof import("../ui/app/router.ts");

let routerPromise: Promise<RouterModule> | null = null;

/** Cached lazy import of the remix dashboard router. The dashboard listener
 * awaits this promise — a slow import delays the page, it never 503s. A failed
 * import is reset so the next request retries. Exported so the daemon can warm
 * it at boot in production. */
export function getRouter(): Promise<RouterModule> {
  if (routerPromise === null) {
    routerPromise = import("../ui/app/router.ts").catch((err) => {
      routerPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return routerPromise;
}

export function createWebServer(state: ApiState): Server {
  // register the daemon state for in-process consumers (the UI actions call
  // the api core against it — no socket round trip, Phase 2 / T4)
  setWebState(state);
  // wire the events-write chokepoint to the live change bus: every insertEvent
  // now fires a per-run wake-up the SSE proxies push to the browser. With zero
  // subscribers this is a functional no-op (the existing suite proves it).
  setEventInsertHook(emitRunChange);
  const listener = createRequestListener(async (request) => {
    if (isApiPath(request.url)) {
      return handleApiRequest(state, request);
    }
    try {
      const mod = await getRouter();
      return await mod.router.fetch(request);
    } catch (err) {
      console.error(err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
  return createServer(listener);
}
