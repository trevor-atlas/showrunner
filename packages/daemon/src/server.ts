import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { isFixtureName } from "@showrunner/core/test/fixtures";

import {
  cursorEvents,
  eventCount,
  getRun,
  listAgentSessions,
  listPhases,
  listRuns,
  sumRunSpend,
} from "./db.ts";
import { submitFixture } from "./driver.ts";
import type { SubmitOptions, SubmittedRun } from "./driver.ts";
import { tailRawFile } from "./rawfile.ts";

/**
 * The daemon's local HTTP API (spec §13) - deliberately the minimal slice the
 * CLI needs for T01a: health, submit, runs list, run detail, the events
 * cursor (§4.3), and the raw tail. The full §13 contract is T08's ticket.
 *
 * Listens on a unix socket (unix://~/.showrunner/daemon.sock) per §13.
 */

export interface DaemonDeps {
  db: Database;
  dataDir: string;
}

const MAX_EVENTS_LIMIT = 500;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on("error", reject);
  });
}

function intParam(v: string | null, fallback: number, max: number): number {
  if (v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return Math.min(n, max);
}

export function createDaemonServer(deps: DaemonDeps): Server {
  const { db, dataDir } = deps;

  return createServer((req, res) => {
    void handleRequest(db, dataDir, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    });
  });
}

async function handleRequest(
  db: Database,
  dataDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://daemon.local");
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (method === "GET" && path === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && path === "/runs") {
    json(res, 200, { runs: listRuns(db) });
    return;
  }

  if (method === "POST" && path === "/runs") {
    let body: Record<string, unknown>;
    try {
      const parsed = (await readJsonBody(req)) as Record<string, unknown>;
      body = parsed;
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const fixture = body.fixture;
    if (!isFixtureName(fixture)) {
      json(res, 400, {
        error: `unknown fixture "${String(fixture)}" (expected one of: happy, gate-fail, crash)`,
      });
      return;
    }
    const opts: SubmitOptions = { fixture };
    if (typeof body.cwd === "string" && body.cwd !== "") opts.cwd = body.cwd;
    if (typeof body.delayMs === "number" && Number.isFinite(body.delayMs)) {
      opts.delayMs = Math.max(0, Math.floor(body.delayMs));
    }
    if (typeof body.agent === "string" && body.agent !== "") opts.agent = body.agent;
    if (typeof body.model === "string" && body.model !== "") opts.model = body.model;
    if (typeof body.phase === "string" && body.phase !== "") opts.phase = body.phase;
    const sub: SubmittedRun = submitFixture(db, dataDir, opts);
    json(res, 201, {
      run_id: sub.run_id,
      phase_id: sub.phase_id,
      agent_session_id: sub.agent_session_id,
      fixture,
    });
    return;
  }

  const runMatch = path.match(/^\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const runId = runMatch[1]!;
    const run = getRun(db, runId);
    if (!run) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    json(res, 200, {
      run,
      spend_usd: sumRunSpend(db, runId),
      phases: listPhases(db, runId),
      sessions: listAgentSessions(db, runId),
      event_count: eventCount(db, runId),
    });
    return;
  }

  const eventsMatch = path.match(/^\/runs\/([^/]+)\/events$/);
  if (eventsMatch && method === "GET") {
    const runId = eventsMatch[1]!;
    if (!getRun(db, runId)) {
      json(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const cursor = intParam(url.searchParams.get("cursor"), 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(url.searchParams.get("limit"), MAX_EVENTS_LIMIT, MAX_EVENTS_LIMIT);
    const events = cursorEvents(db, runId, cursor, limit);
    const nextCursor = events.length > 0 ? events[events.length - 1]!.id : cursor;
    json(res, 200, { events, next_cursor: nextCursor });
    return;
  }

  const rawMatch = path.match(/^\/runs\/([^/]+)\/raw$/);
  if (rawMatch && method === "GET") {
    const runId = rawMatch[1]!;
    const n = intParam(url.searchParams.get("n"), 200, 5000);
    const tail = tailRawFile(join(dataDir, "runs", runId, "raw_output.jsonl"), n);
    json(res, 200, tail);
    return;
  }

  json(res, 404, { error: `no such route: ${method} ${path}` });
}
