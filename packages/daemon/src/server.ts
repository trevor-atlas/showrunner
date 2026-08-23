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
import { RunPool } from "./pool.ts";
import { tailRawFile } from "./rawfile.ts";
import { drivePreparedRun, prepareBlueprintRun } from "./runner.ts";

/**
 * The daemon's local HTTP API (spec §13) - the slice the CLI needs: health,
 * submit (fixture or blueprint module), runs list (with phase counts), run
 * detail, the events cursor (§4.3), and the raw tail. The full §13 contract
 * is T08's ticket.
 *
 * Blueprint runs go through the §5.4 pool (default 2 slots, configurable via
 * SHOWRUNNER_POOL_SIZE); fixture submits spawn immediately (observation
 * fixtures, one child each - not pool-governed).
 *
 * Listens on a unix socket (unix://~/.showrunner/daemon.sock) per §13.
 */

export interface DaemonDeps {
  db: Database;
  dataDir: string;
}

const MAX_EVENTS_LIMIT = 500;
const POOL_SLOTS = Number(process.env.SHOWRUNNER_POOL_SIZE ?? "2") || 2;

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
  const pool = new RunPool(POOL_SLOTS);

  return createServer((req, res) => {
    void handleRequest(db, dataDir, pool, req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: message });
    });
  });
}

async function handleRequest(
  db: Database,
  dataDir: string,
  pool: RunPool,
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
    const runs = listRuns(db).map((r) => ({ ...r, phase_counts: phaseStatusCounts(db, r.id) }));
    json(res, 200, { runs });
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
    if (isFixtureName(fixture)) {
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

    // blueprint module (§13.3): import + validate + snapshot at submit, then
    // drive behind the pool (§5.4)
    const blueprintPath = body.blueprint;
    if (typeof blueprintPath === "string" && blueprintPath !== "") {
      let prepared;
      try {
        prepared = await prepareBlueprintRun(db, dataDir, {
          modulePath: blueprintPath,
          cwd: typeof body.cwd === "string" && body.cwd !== "" ? body.cwd : undefined,
        });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const delayMs =
        typeof body.delayMs === "number" && Number.isFinite(body.delayMs)
          ? Math.max(0, Math.floor(body.delayMs))
          : 0;
      pool.enqueue(prepared.runId, () => {
        try {
          const run = drivePreparedRun(db, dataDir, prepared, { delayMs });
          void run.done.finally(() => pool.release(prepared.runId));
        } catch (err) {
          // synchronous failure: surface it on the run row, free the slot
          pool.release(prepared.runId);
        }
      });
      json(res, 201, { run_id: prepared.runId, blueprint: prepared.blueprint.name });
      return;
    }

    json(res, 400, { error: "request body must include a fixture name or a blueprint module path" });
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

function phaseStatusCounts(db: Database, runId: string): Record<string, number> {
  const rows = db
    .query<{ status: string; n: number }, [string]>(
      "SELECT status, COUNT(*) AS n FROM phases WHERE run_id = ? GROUP BY status",
    )
    .all(runId);
  const counts: Record<string, number> = { total: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.n);
    counts["total"] = (counts["total"] ?? 0) + Number(row.n);
  }
  return counts;
}
