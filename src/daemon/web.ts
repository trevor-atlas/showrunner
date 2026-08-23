import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequestListener } from "remix/node-fetch-server";

import { handleApiRequest, type ApiState } from "./server.ts";
import { setWebState } from "./web-state.ts";

/**
 * The daemon's merged web server: ONE node:http listener serving BOTH the
 * §13 JSON API (under `/api/*`, dispatched straight to the api core in
 * src/daemon/server.ts) AND the remix@next dashboard (everything else, via
 * the lazily-imported router).
 *
 * The dashboard router is imported through a dynamic import so the daemon
 * process never loads the UI graph unless a browser actually asks for a page
 * — and `/api/*` is dispatched BEFORE the router promise is ever touched, so
 * the JSON API keeps answering even while the UI import is slow.
 */

export function isApiPath(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false;
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

type RouterModule = typeof import("../ui/app/router.ts");

let routerPromise: Promise<RouterModule> | null = null;
let routerPending = false;

/** Cached lazy import of the remix dashboard router. While the import is in
 * flight `routerPending` stays true and the dashboard answers 503 — the API
 * path never waits on it. A failed import is reset so the next request
 * retries. */
function getRouter(): Promise<RouterModule> {
  if (routerPromise === null) {
    routerPending = true;
    routerPromise = import("../ui/app/router.ts")
      .then((mod) => {
        routerPending = false;
        return mod;
      })
      .catch((err) => {
        routerPending = false;
        routerPromise = null; // allow a retry on the next request
        throw err;
      });
  }
  return routerPromise;
}

export function createWebServer(state: ApiState): Server {
  // register the daemon state for in-process consumers (the UI actions call
  // the §13 api core against it — no socket round trip, Phase 2 / T4)
  setWebState(state);
  const listener = createRequestListener(async (request) => {
    if (isApiPath(request.url)) {
      return handleApiRequest(state, request);
    }
    const router = getRouter();
    if (routerPending) {
      return new Response("dashboard warming up", { status: 503 });
    }
    try {
      const mod = await router;
      return await mod.router.fetch(request);
    } catch (err) {
      console.error(err);
      return new Response("Internal Server Error", { status: 500 });
    }
  });
  return createServer(listener);
}
