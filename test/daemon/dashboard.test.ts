process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)

import { test, expect, afterAll } from "bun:test";
import { startDaemon } from "../../src/server/lifecycle.ts";
import type { DaemonHandle } from "../../src/server/lifecycle.ts";
import { tmpDataDir, cleanupDir } from "./helpers.ts";

/**
 * The dashboard runs INSIDE the daemon process: `showrunner daemon`
 * serves the web UI automatically, same process, no separate boot, no env
 * needed. The merged web server (src/daemon/web.ts) is ONE TCP listener for
 * BOTH the JSON API (under /api/*) and the remix dashboard (everything
 * else). This proves the merged mount: a daemon answers GET / with the
 * run-list page AND /api/health on the same ephemeral port.
 *
 * The dashboard router is lazily imported on first use — the FIRST non-/api
 * request may answer 503 "dashboard warming up" while the import is in
 * flight; retry once, then assert the rendered page.
 */

const dataDir = tmpDataDir("dashboard");

let daemon: DaemonHandle | null = null;
let port = 0;

afterAll(async () => {
  await daemon?.close();
  cleanupDir(dataDir);
});

/** GET / through the daemon's own HTTP server; retries once on the lazy-router
 * 503 warm-up seam (the router import is in flight on the first request). */
async function fetchHomeWarm(): Promise<{ status: number; html: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
    if (res.status !== 503) {
      return { status: res.status, html: await res.text() };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, html: await res.text() };
}

test("the merged server serves BOTH the dashboard (GET /) and the /api JSON on ONE ephemeral port", async () => {
  daemon = await startDaemon({ dataDir, port: 0 });
  port = daemon.port;
  expect(daemon.baseUrl).toBe(`http://127.0.0.1:${port}`);
  expect(port).toBeGreaterThan(0); // 0 = ephemeral → the real port is on the handle

  // the JSON API answers on the SAME listener (no separate dashboard port)
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ ok: true });

  // the dashboard answers on the SAME listener: GET / renders the run-list page
  const home = await fetchHomeWarm();
  expect(home.status).toBe(200);
  expect(home.html).toContain("runs"); // the run-list page rendered
}, { timeout: 30_000 });

test("SHOWRUNNER_PORT=0 → the daemon binds an ephemeral port (env knob, no port option)", async () => {
  const saved = process.env.SHOWRUNNER_PORT;
  process.env.SHOWRUNNER_PORT = "0";
  const ephemeral = await startDaemon({ dataDir: tmpDataDir("dashboard-ephemeral") });
  try {
    expect(ephemeral.port).toBeGreaterThan(0);
    const health = await fetch(`${ephemeral.baseUrl}/api/health`, { signal: AbortSignal.timeout(5_000) });
    expect(health.status).toBe(200);
  } finally {
    await ephemeral.close();
    if (saved === undefined) delete process.env.SHOWRUNNER_PORT;
    else process.env.SHOWRUNNER_PORT = saved;
  }
}, { timeout: 15_000 });
