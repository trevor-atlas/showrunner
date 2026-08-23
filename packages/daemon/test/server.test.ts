import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import { startDaemon } from "../src/index.ts";
import type { DaemonHandle } from "../src/index.ts";

function api(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: body === undefined ? {} : { "content-type": "application/json" },
      },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // keep raw text
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForDone(dataDir: string, runId: string, socketPath: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { json } = await api(socketPath, "GET", `/runs/${runId}`);
    const run = (json as { run: { status: string } }).run;
    if (run.status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

test("the daemon API serves health, submit, runs, detail, events cursor, raw (§13)", async () => {
  const dir = tmpDataDir("server");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = startDaemon({ dataDir: dir });
    const { socketPath } = daemon;

    // health
    const health = await api(socketPath, "GET", "/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });

    // submit
    const submitted = await api(socketPath, "POST", "/runs", { fixture: "happy", delayMs: 0 });
    expect(submitted.status).toBe(201);
    const { run_id, phase_id, agent_session_id } = submitted.json as {
      run_id: string;
      phase_id: string;
      agent_session_id: string;
    };
    expect(run_id).toBeTypeOf("string");
    expect(phase_id).toBeTypeOf("string");
    expect(agent_session_id).toBeTypeOf("string");

    await waitForDone(dir, run_id, socketPath);

    // runs list
    const runs = await api(socketPath, "GET", "/runs");
    const list = (runs.json as { runs: { id: string; status: string; spend_usd: number }[] }).runs;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(run_id);
    expect(list[0]!.status).toBe("success");
    expect(list[0]!.spend_usd).toBeCloseTo(0.00463);

    // run detail
    const detail = await api(socketPath, "GET", `/runs/${run_id}`);
    expect(detail.status).toBe(200);
    const d = detail.json as { run: { blueprint: string }; phases: { name: string }[]; sessions: unknown[]; event_count: number };
    expect(d.run.blueprint).toBe("fixture:happy");
    expect(d.phases[0]!.name).toBe("build");
    expect(d.sessions).toHaveLength(1);
    expect(d.event_count).toBe(13);

    // events cursor, paged by limit
    let cursor = 0;
    const collected: number[] = [];
    for (let i = 0; i < 10; i++) {
      const page = await api(socketPath, "GET", `/runs/${run_id}/events?cursor=${cursor}&limit=2`);
      const body = page.json as { events: { id: number; type: string }[]; next_cursor: number };
      collected.push(...body.events.map((e) => e.id));
      if (body.events.length === 0) break; // drained
      cursor = body.next_cursor;
    }
    expect(collected).toHaveLength(13);
    expect([...collected].sort((a, b) => a - b)).toEqual(collected); // ascending, no dupes

    // raw tail
    const raw = await api(socketPath, "GET", `/runs/${run_id}/raw?n=2`);
    const rawBody = raw.json as { line_count: number; truncated: boolean };
    expect(rawBody.line_count).toBeGreaterThan(20);
    expect(rawBody.truncated).toBe(true);

    // unknown fixture -> 400; unknown run -> 404; unknown route -> 404
    const bad = await api(socketPath, "POST", "/runs", { fixture: "nope" });
    expect(bad.status).toBe(400);
    const ghost = await api(socketPath, "GET", "/runs/ghost/events");
    expect(ghost.status).toBe(404);
    const nope = await api(socketPath, "GET", "/nothing");
    expect(nope.status).toBe(404);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("a second daemon on the same data dir refuses to start (pidfile guard)", async () => {
  const dir = tmpDataDir("server-guard");
  let daemon: DaemonHandle | null = null;
  try {
    daemon = startDaemon({ dataDir: dir });
    expect(() => startDaemon({ dataDir: dir })).toThrow(/daemon already running/);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("daemon.close removes the socket and the pidfile", async () => {
  const dir = tmpDataDir("server-close");
  const daemon = startDaemon({ dataDir: dir });
  const { socketPath } = daemon;
  expect(existsSync(socketPath)).toBe(true);
  expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
  await daemon.close();
  expect(existsSync(socketPath)).toBe(false);
  expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  // socket gone: requests fail
  await expect(
    api(socketPath, "GET", "/health").then(
      () => "up",
      () => "down",
    ),
  ).resolves.toBe("down");
});
