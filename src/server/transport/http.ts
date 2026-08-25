import { createServer } from "node:http";
import type { Server } from "node:http";
import { createRequestListener } from "remix/node-fetch-server";

import { onEventWritten } from "../repository/db.ts";
import { ApiError } from "../contract.ts";
import { emitRunChange } from "./change-bus.ts";
import { setServerState, type ApiState } from "./state.ts";
import {
  apiEvents,
  apiHealth,
  apiListRuns,
  apiPhaseEnvelopes,
  apiPhaseGates,
  apiPhaseOutputs,
  apiRaw,
  apiRunDetail,
  apiSpend,
  apiStats,
  apiStatus,
  apiTimeline,
} from "../services/runs.ts";
import {
  apiApprove,
  apiFailRun,
  apiOverrideGate,
  apiPause,
  apiRestartFresh,
  apiResume,
  apiSessionSteer,
  apiShutdown,
  apiSteerRun,
  apiSubmitRun,
} from "../services/control.ts";

/**
 * The server's merged web server: ONE node:http listener serving BOTH the
 * JSON API (under `/api/*`, dispatched straight to the api core in
 * src/server/transport/http.ts) AND the remix@next dashboard (everything else, via
 * the lazily-imported router).
 *
 * The dashboard router is imported through a dynamic import so the server
 * process never loads the UI graph unless a browser actually asks for a page
 * — and `/api/*` is dispatched BEFORE the router promise is ever touched, so
 * the JSON API keeps answering even while the UI import is slow. A dashboard
 * request AWAITS that import (it never 503s); in production the server warms
 * the import + entry assets at boot (src/server/lifecycle.ts) so the first
 * request is already a cache hit.
 */

export function isApiPath(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return false;
  const pathname = new URL(url, "http://127.0.0.1").pathname;
  return pathname === "/api" || pathname.startsWith("/api/");
}

type RouterModule = typeof import("../router.ts");

let routerPromise: Promise<RouterModule> | null = null;

/** Cached lazy import of the remix dashboard router. The dashboard listener
 * awaits this promise — a slow import delays the page, it never 503s. A failed
 * import is reset so the next request retries. Exported so the server can warm
 * it at boot in production. */
export function getRouter(): Promise<RouterModule> {
  if (routerPromise === null) {
    routerPromise = import("../router.ts").catch((err) => {
      routerPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return routerPromise;
}

export function createWebServer(state: ApiState): Server {
  // register the server state for in-process consumers (the UI actions call
  // the api core against it — no socket round trip, Phase 2 / T4)
  setServerState(state);
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
  const server = createServer(listener);
  // wire the repository's events-write chokepoint to the live change bus: every
  // insertEvent fires a per-run wake-up the SSE proxies push to the browser.
  // With zero subscribers this is a functional no-op. Disposed when the server
  // tears down so a torn-down server leaves no live subscriber behind.
  const unsubscribe = onEventWritten(emitRunChange);
  server.on("close", unsubscribe);
  return server;
}

/** Read a JSON object body. Empty bodies resolve to {}; invalid JSON → 400. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(len) && len > 1024 * 1024) {
    throw new ApiError(400, "request body too large");
  }
  const text = await request.text();
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ApiError(400, `invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Control verbs tolerate a missing/empty body (empty → {}). */
async function readBodyLenient(request: Request): Promise<Record<string, unknown>> {
  try {
    return await readBody(request);
  } catch {
    return {};
  }
}

// ── wire dispatcher: Request → Response (used by src/server/transport/http.ts for every
// `/api/*` request; pure JS, no remix dependency) ────────────────────────────

export async function handleApiRequest(state: ApiState, request: Request): Promise<Response> {
  const url = new URL(request.url, "http://127.0.0.1");
  const method = request.method ?? "GET";
  const path = url.pathname === "/api" ? "/" : url.pathname.startsWith("/api/") ? url.pathname.slice(4) : url.pathname;

  try {
    if (method === "GET" && path === "/health") return Response.json(apiHealth(state));
    if (method === "POST" && path === "/shutdown") return Response.json(apiShutdown(state));
    if (method === "GET" && path === "/status") return Response.json(apiStatus(state));
    if (method === "GET" && path === "/stats") return Response.json(apiStats(state));
    if (method === "GET" && path === "/runs") return Response.json(apiListRuns(state));
    if (method === "POST" && path === "/runs") {
      return Response.json(await apiSubmitRun(state, await readBody(request)), { status: 201 });
    }

    const runMatch = path.match(/^\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      return Response.json(apiRunDetail(state, runMatch[1]!, url.searchParams));
    }

    const spendMatch = path.match(/^\/runs\/([^/]+)\/spend$/);
    if (spendMatch && method === "GET") return Response.json(apiSpend(state, spendMatch[1]!));

    const timelineMatch = path.match(/^\/runs\/([^/]+)\/timeline$/);
    if (timelineMatch && method === "GET") return Response.json(apiTimeline(state, timelineMatch[1]!));

    const phaseEnvelopesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/envelopes$/);
    if (phaseEnvelopesMatch && method === "GET") {
      return Response.json(
        apiPhaseEnvelopes(state, phaseEnvelopesMatch[1]!, decodeURIComponent(phaseEnvelopesMatch[2]!)),
      );
    }

    const phaseGatesMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/gates$/);
    if (phaseGatesMatch && method === "GET") {
      return Response.json(apiPhaseGates(state, phaseGatesMatch[1]!, decodeURIComponent(phaseGatesMatch[2]!)));
    }

    const phaseOutputsMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/outputs$/);
    if (phaseOutputsMatch && method === "GET") {
      return Response.json(
        apiPhaseOutputs(state, phaseOutputsMatch[1]!, decodeURIComponent(phaseOutputsMatch[2]!)),
      );
    }

    const eventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
    if (eventsMatch && method === "GET") return Response.json(apiEvents(state, eventsMatch[1]!, url.searchParams));

    const rawMatch = path.match(/^\/runs\/([^/]+)\/raw$/);
    if (rawMatch && method === "GET") return Response.json(apiRaw(state, rawMatch[1]!, url.searchParams));

    const pauseMatch = path.match(/^\/runs\/([^/]+)\/pause$/);
    if (pauseMatch && method === "GET") return Response.json(apiPause(state, pauseMatch[1]!));

    const steerMatch = path.match(/^\/runs\/([^/]+)\/steer$/);
    if (steerMatch && method === "POST") {
      return Response.json(apiSteerRun(state, steerMatch[1]!, await readBodyLenient(request)));
    }

    const sessionSteerMatch = path.match(/^\/sessions\/([^/]+)\/steer$/);
    if (sessionSteerMatch && method === "POST") {
      return Response.json(apiSessionSteer(state, sessionSteerMatch[1]!, await readBodyLenient(request)));
    }

    const approveMatch = path.match(/^\/runs\/([^/]+)\/approve$/);
    if (approveMatch && method === "POST") {
      return Response.json(apiApprove(state, approveMatch[1]!, await readBodyLenient(request)));
    }

    const failMatch = path.match(/^\/runs\/([^/]+)\/fail$/);
    if (failMatch && method === "POST") {
      return Response.json(apiFailRun(state, failMatch[1]!, await readBodyLenient(request)));
    }

    const resumeMatch = path.match(/^\/runs\/([^/]+)\/resume$/);
    if (resumeMatch && method === "POST") {
      return Response.json(await apiResume(state, resumeMatch[1]!, await readBodyLenient(request)));
    }

    const controlPhaseMatch = path.match(/^\/runs\/([^/]+)\/phases\/([^/]+)\/(override|restart-fresh)$/);
    if (controlPhaseMatch && method === "POST") {
      const body = await readBodyLenient(request);
      const runId = controlPhaseMatch[1]!;
      const phase = decodeURIComponent(controlPhaseMatch[2]!);
      if (controlPhaseMatch[3] === "restart-fresh") {
        return Response.json(apiRestartFresh(state, runId, phase, body));
      }
      return Response.json(apiOverrideGate(state, runId, phase, body));
    }

    throw new ApiError(404, `no such route: ${method} ${path}`);
  } catch (err) {
    if (err instanceof ApiError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
