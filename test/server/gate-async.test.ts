process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, openSync, closeSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

import { cleanupDir, freePort, tmpDataDir } from "./helpers.ts";
import { serverEntryPath } from "../../src/server/lifecycle.ts";

/**
 * The capstone FINDING 1 regression seam ("Backpressure" at the HTTP
 * layer): command gates run IN the daemon process, so a synchronous gate
 * (spawnSync) freezes the daemon's event loop — every HTTP response
 * (health/runs/show/watch/UI) hangs for the gate's whole duration. These
 * tests pin the async-gate contract over a REAL daemon process:
 *
 *  1. while a gate sleeps 2.5s, /health and /runs must resolve in well under
 *     the gate's duration (the event loop stays responsive);
 *  2. a gate whose command exceeds its timeout cap becomes a violation with
 *     the error text and the daemon stays healthy afterwards.
 *
 * The daemon runs as a CHILD PROCESS (like the smoke) so a frozen event loop
 * in the daemon cannot blind the test's own HTTP probe.
 */
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const SLEEP_GATE_BP = join(fixturesDir, "sleep-gate-blueprint.ts");
const TIMEOUT_GATE_BP = join(fixturesDir, "timeout-gate-blueprint.ts");

/** Raw probe over the daemon's merged HTTP server: every path below is
 * `/api`-prefixed (the web server dispatches /api/* to the api core). */
function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<{ status: number; json: any }> {
  const url = new URL("/api" + path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port === "" ? undefined : url.port,
        method,
        path: url.pathname + url.search,
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`api timeout after ${timeoutMs}ms`)));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

interface BootedDaemon {
  child: ChildProcess;
  dir: string;
  cwd: string;
  /** the daemon's base URL — the FIXED port handed to the child (no discovery
   * file: the test picks the port up front) */
  baseUrl: string;
}

async function bootDaemon(label: string): Promise<BootedDaemon> {
  const dir = tmpDataDir(label);
  const cwd = mkdtempSync(join(tmpdir(), `showrunner-${label}-cwd-`));
  const logPath = join(dir, "daemon.log");
  const logFd = openSync(logPath, "a");
  // FIXED port: the daemon has no discovery file, so the test picks a free
  // port up front and hands it to the child via SHOWRUNNER_PORT (parallel-safe:
  // each boot gets its own port).
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntryPath(), "--data-dir", dir], {
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env, SHOWRUNNER_PORT: String(port) },
  });
  closeSync(logFd);
  child.unref();
  return { child, dir, cwd, baseUrl: `http://127.0.0.1:${port}` };
}

async function waitForHealth(baseUrl: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const h = await api(baseUrl, "GET", "/health", undefined, 1500);
      if (h.status === 200) return;
    } catch {
      // daemon not up yet (or mid-freeze)
    }
    if (Date.now() > deadline) throw new Error(`daemon not healthy at ${baseUrl}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForStatus(baseUrl: string, runId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let d: { status: number; json: any } | null = null;
    try {
      d = await api(baseUrl, "GET", `/runs/${runId}`, undefined, 1500);
    } catch {
      // daemon frozen mid-gate — keep waiting
    }
    if (d !== null && d.status === 200 && d.json?.run?.status === status) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach "${status}" in time`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`file ${path} never appeared`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function teardown(h: BootedDaemon): void {
  try {
    h.child.kill("SIGKILL");
  } catch {
    // already gone
  }
  rmSync(h.cwd, { recursive: true, force: true });
  cleanupDir(h.dir);
}

test("F1: HTTP resolves DURING a sleeping gate (2.5s) — the event loop never blocks on gate execution", async () => {
  const h = await bootDaemon("gate-async");
  try {
    await waitForHealth(h.baseUrl);
    const sub = await api(h.baseUrl, "POST", "/runs", { blueprint: SLEEP_GATE_BP, cwd: h.cwd });
    expect(sub.status).toBe(201);
    const runId = (sub.json as { run_id: string }).run_id;

    // the gate writes a marker BEFORE sleeping — when it appears, the gate is
    // executing. The daemon is a separate process, so the probe below is not
    // blinded by a frozen daemon event loop.
    const marker = join(h.cwd, "gate-started.marker");
    await waitForFile(marker);

    // while the gate sleeps 2.5s, /health must resolve in well under the
    // gate's duration. A spawnSync gate stalls it until the gate returns.
    const t0 = Date.now();
    const health = await api(h.baseUrl, "GET", "/health", undefined, 1500);
    const healthElapsed = Date.now() - t0;
    expect(health.status).toBe(200);
    expect(healthElapsed).toBeLessThan(1500);

    // /runs too — the live-feed surface must keep serving mid-gate
    const t1 = Date.now();
    const runs = await api(h.baseUrl, "GET", "/runs", undefined, 1500);
    const runsElapsed = Date.now() - t1;
    expect(runs.status).toBe(200);
    expect(runsElapsed).toBeLessThan(1500);

    await waitForStatus(h.baseUrl, runId, "success", 20_000);
  } finally {
    teardown(h);
  }
}, { timeout: 30_000 });

test("a gate that exceeds its cap → violation with the error text; the daemon stays healthy after", async () => {
  const h = await bootDaemon("gate-timeout");
  try {
    await waitForHealth(h.baseUrl);
    const sub = await api(h.baseUrl, "POST", "/runs", { blueprint: TIMEOUT_GATE_BP, cwd: h.cwd });
    expect(sub.status).toBe(201);
    const runId = (sub.json as { run_id: string }).run_id;

    // the capped gate always fails → the phase exhausts its budget → pause
    await waitForStatus(h.baseUrl, runId, "paused", 20_000);
    const p = await api(h.baseUrl, "GET", `/runs/${runId}/pause`);
    expect((p.json as any).kind).toBe("budget_exhausted");

    // every gate_result row recorded the cap failure with the error text
    const gates = await api(h.baseUrl, "GET", `/runs/${runId}/phases/build/gates`);
    const rows = (gates.json as any).gates as { gate: string; pass: number; violations: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.pass).toBe(0);
      expect(row.violations).toContain("exit -1");
    }

    // the daemon is healthy after the cap-exceeded gate (a crash/hang would 500/timing out)
    const health = await api(h.baseUrl, "GET", "/health", undefined, 3000);
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });

    // the run is still controllable — fail it to terminal
    const fail = await api(h.baseUrl, "POST", `/runs/${runId}/fail`, { by: "test" });
    expect(fail.status).toBe(200);
    await waitForStatus(h.baseUrl, runId, "failed", 10_000);
  } finally {
    teardown(h);
  }
}, { timeout: 30_000 });
