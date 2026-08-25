process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";

import { cleanupDir, freePort, tmpDataDir } from "./helpers.ts";
import { startServer } from "../../src/server/lifecycle.ts";
import { type ServerHandle } from "../../src/server/lifecycle.ts";

// The merged daemon listens on ONE TCP port (no unix socket anymore): the
// API is served under the same listener as the dashboard. Each test starts
// its daemon on an ephemeral port (port: 0) so parallel tests don't collide
// on the default 44100.
function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl);
    const req = request(
      {
        hostname: u.hostname,
        port: Number(u.port),
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

async function waitForDone(dataDir: string, runId: string, baseUrl: string, tries = 200): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const { json } = await api(baseUrl, "GET", `/api/runs/${runId}`);
    const run = (json as { run: { status: string } }).run;
    if (run.status !== "running") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`run ${runId} did not reach a terminal state in time`);
}

test("the daemon API serves health, submit, runs, detail, events cursor, raw", async () => {
  const dir = tmpDataDir("server");
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    // merged daemon: ONE TCP listener; baseUrl carries the (ephemeral) port
    const baseUrl = daemon.baseUrl;

    // health
    const health = await api(baseUrl, "GET", "/api/health");
    expect(health.status).toBe(200);
    expect(health.json).toEqual({ ok: true });

    // submit
    const submitted = await api(baseUrl, "POST", "/api/runs", { fixture: "happy", delayMs: 0 });
    expect(submitted.status).toBe(201);
    const { run_id, phase_id, agent_session_id } = submitted.json as {
      run_id: string;
      phase_id: string;
      agent_session_id: string;
    };
    expect(run_id).toBeTypeOf("string");
    expect(phase_id).toBeTypeOf("string");
    expect(agent_session_id).toBeTypeOf("string");

    await waitForDone(dir, run_id, baseUrl);

    // runs list
    const runs = await api(baseUrl, "GET", "/api/runs");
    const list = (runs.json as { runs: { id: string; status: string; spend_usd: number }[] }).runs;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(run_id);
    expect(list[0]!.status).toBe("success");
    expect(list[0]!.spend_usd).toBeCloseTo(0.00463);

    // run detail
    const detail = await api(baseUrl, "GET", `/api/runs/${run_id}`);
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
      const page = await api(baseUrl, "GET", `/api/runs/${run_id}/events?cursor=${cursor}&limit=2`);
      const body = page.json as { events: { id: number; type: string }[]; next_cursor: number };
      collected.push(...body.events.map((e) => e.id));
      if (body.events.length === 0) break; // drained
      cursor = body.next_cursor;
    }
    expect(collected).toHaveLength(13);
    expect([...collected].sort((a, b) => a - b)).toEqual(collected); // ascending, no dupes

    // raw tail
    const raw = await api(baseUrl, "GET", `/api/runs/${run_id}/raw?n=2`);
    const rawBody = raw.json as { line_count: number; truncated: boolean };
    expect(rawBody.line_count).toBeGreaterThan(20);
    expect(rawBody.truncated).toBe(true);

    // unknown fixture -> 400; unknown run -> 404; unknown route -> 404
    const bad = await api(baseUrl, "POST", "/api/runs", { fixture: "nope" });
    expect(bad.status).toBe(400);
    const ghost = await api(baseUrl, "GET", "/api/runs/ghost/events");
    expect(ghost.status).toBe(404);
    const nope = await api(baseUrl, "GET", "/api/nothing");
    expect(nope.status).toBe(404);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("POST /runs with a blueprint module drives it to completion (, T01b)", async () => {
  const dir = tmpDataDir("server-blueprint");
  // F3: the run's cwd is a scratch dir — context_handoff/ must never land in
  // the repo root when a test forgets to pass one
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-run-cwd-"));
  // a PARALLEL IC may have left context_handoff residue in the repo root
  // (packages/starter-kit, T12) — F3 asserts THIS test adds none
  const rootHadContextDir = existsSync(join(process.cwd(), "context_handoff"));
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    const demo = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "demo-blueprint.ts");
    const submitted = await api(baseUrl, "POST", "/api/runs", { blueprint: demo, cwd: runCwd, delayMs: 0 });
    expect(submitted.status).toBe(201);
    const { run_id, blueprint } = submitted.json as { run_id: string; blueprint: string };
    expect(run_id).toBeTypeOf("string");
    expect(blueprint).toBe("demo");

    await waitForDone(dir, run_id, baseUrl);

    // run detail: phases with status/visits/corrections/spend
    const detail = await api(baseUrl, "GET", `/api/runs/${run_id}`);
    const body = detail.json as {
      run: { status: string };
      phases: { name: string; status: string; visits: number; corrections: number }[];
      event_count: number;
    };
    expect(body.run.status).toBe("success");
    expect(body.phases.map((p) => [p.name, p.status, p.corrections])).toEqual([
      ["plan", "success", 1], // one correction (gate fail → revise)
      ["build", "success", 0],
    ]);
    expect(body.event_count).toBeGreaterThan(10);

    // the runs list carries phase counts
    const runs = await api(baseUrl, "GET", "/api/runs");
    const list = (runs.json as { runs: { phase_counts: Record<string, number> }[] }).runs;
    expect(list[0]!.phase_counts).toMatchObject({ total: 2, success: 2 });

    // snapshot is on disk
    expect(existsSync(join(dir, "runs", run_id, "blueprint.json"))).toBe(true);

    // F3: the run workspace lives under the RUN dir ({data_dir}/runs/<run_id>/<phase>),
    // never the cwd — a run can never dirty the checkout, scratch or not
    expect(existsSync(join(dir, "runs", run_id, "build", "outputs", "envelope.json"))).toBe(true);
    expect(existsSync(join(runCwd, "context_handoff"))).toBe(false);
    expect(existsSync(join(process.cwd(), "context_handoff"))).toBe(rootHadContextDir);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("POST /runs rejects a blueprint path without scripted sessions", async () => {
  const dir = tmpDataDir("server-noscript");
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const submitted = await api(baseUrl, "POST", "/api/runs", { blueprint: "/nonexistent/blueprint.ts" });
    expect(submitted.status).toBe(400);
    expect(String((submitted.json as { error: string }).error)).toMatch(/blueprint/);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("a second daemon on the same FIXED port refuses to start (bind-based EADDRINUSE guard)", async () => {
  const dir = tmpDataDir("server-guard");
  const port = await freePort();
  let daemon: ServerHandle | null = null;
  try {
    // first daemon claims the fixed port; a second boot on the same port hits
    // EADDRINUSE and is rejected with a clear "already running" error — no
    // file is consulted, the live socket IS the guard
    daemon = await startServer({ dataDir: dir, port });
    await expect(startServer({ dataDir: dir, port })).rejects.toThrow(/server already running/);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("two ephemeral (port: 0) daemons on the same data dir both start — no false guard", async () => {
  const dir = tmpDataDir("server-ephemeral-pair");
  let a: ServerHandle | null = null;
  let b: ServerHandle | null = null;
  try {
    // ephemeral binds can never collide (the OS hands back a free port), so the
    // double-boot guard must NOT fire — the test suite relies on this
    a = await startServer({ dataDir: dir, port: 0 });
    b = await startServer({ dataDir: dir, port: 0 });
    expect(a.port).toBeGreaterThan(0);
    expect(b.port).toBeGreaterThan(0);
    expect(a.port).not.toBe(b.port);
  } finally {
    await a?.close();
    await b?.close();
    cleanupDir(dir);
  }
});

test("POST /api/shutdown responds ok and raises SIGTERM on the daemon (the `stop` verb's graceful path)", async () => {
  const dir = tmpDataDir("server-shutdown");
  const daemon = await startServer({ dataDir: dir, port: 0 });
  // the endpoint self-signals SIGTERM AFTER flushing the response; catch it so
  // the graceful path is provable in-process without killing the test runner
  // (startServer installs no signal handlers, so this is the only SIGTERM sink)
  let signalled = false;
  const onTerm = (): void => {
    signalled = true;
  };
  // bun-types merges a `memoryPressure` signal overload that mis-resolves a
  // stored SIGTERM listener const; cast past it (an inline arrow would compile
  // but we need the reference back for removeListener)
  const onSignal = process.on.bind(process) as (e: string, l: () => void) => void;
  const offSignal = process.removeListener.bind(process) as (e: string, l: () => void) => void;
  onSignal("SIGTERM", onTerm);
  try {
    const res = await api(daemon.baseUrl, "POST", "/api/shutdown");
    expect(res.status).toBe(200);
    expect((res.json as { ok: boolean }).ok).toBe(true);
    const deadline = Date.now() + 2_000;
    while (!signalled && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(signalled).toBe(true);
  } finally {
    offSignal("SIGTERM", onTerm);
    await daemon.close();
    cleanupDir(dir);
  }
});

test("daemon.close stops the listener", async () => {
  const dir = tmpDataDir("server-close");
  const daemon = await startServer({ dataDir: dir, port: 0 });
  const baseUrl = daemon.baseUrl;
  expect(daemon.port).toBeGreaterThan(0);
  await daemon.close();
  // listener gone: requests fail
  await expect(
    api(baseUrl, "GET", "/api/health").then(
      () => "up",
      () => "down",
    ),
  ).resolves.toBe("down");
});

test("GET /runs/:id/spend returns exact per-phase token totals (SQL SUM — no sweep cap, no truncated)", async () => {
  const dir = tmpDataDir("server-spend-tokens");
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const submitted = await api(baseUrl, "POST", "/api/runs", { fixture: "happy", delayMs: 0 });
    expect(submitted.status).toBe(201);
    const { run_id } = submitted.json as { run_id: string };
    await waitForDone(dir, run_id, baseUrl);

    const spend = await api(baseUrl, "GET", `/api/runs/${run_id}/spend`);
    expect(spend.status).toBe(200);
    const body = spend.json as {
      phases: { name: string; tokens_in: number; tokens_out: number; cache_read: number; cache_write: number }[];
    };
    expect(body.phases).toHaveLength(1);
    expect(body.phases[0]!.name).toBe("build");
    // the happy run's three spend deltas sum exactly — SQL SUM is exact
    expect(body.phases[0]).toMatchObject({ tokens_in: 1400, tokens_out: 380, cache_read: 100, cache_write: 50 });
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("?full=1 run detail rides the initial sweep: 13 events + next_cursor 13; the flagless shape omits them", async () => {
  const dir = tmpDataDir("server-full-detail");
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const submitted = await api(baseUrl, "POST", "/api/runs", { fixture: "happy", delayMs: 0 });
    const { run_id } = submitted.json as { run_id: string };
    await waitForDone(dir, run_id, baseUrl);

    // ?full=1: the SSR sweep rides the detail call — events + next_cursor
    const full = await api(baseUrl, "GET", `/api/runs/${run_id}?full=1`);
    expect(full.status).toBe(200);
    const fullBody = full.json as { event_count: number; events: { id: number }[]; next_cursor: number };
    expect(fullBody.event_count).toBe(13);
    expect(fullBody.events).toHaveLength(13);
    expect(fullBody.events.map((e) => e.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(fullBody.next_cursor).toBe(13);

    // flagless: the exact current shape — no events, no next_cursor
    const plain = await api(baseUrl, "GET", `/api/runs/${run_id}`);
    expect(plain.status).toBe(200);
    const plainBody = plain.json as { events?: unknown[]; next_cursor?: number };
    expect(plainBody.events).toBeUndefined();
    expect(plainBody.next_cursor).toBeUndefined();
  } finally {
    await daemon?.close();
    cleanupDir(dir);
  }
});

test("GET /runs/:id/phases/:phase/outputs lists the outputs dir + FINDINGS.md; 404 for a ghost run/phase", async () => {
  const dir = tmpDataDir("server-phase-outputs");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-run-cwd-"));
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;
    const demo = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "demo-blueprint.ts");
    const submitted = await api(baseUrl, "POST", "/api/runs", { blueprint: demo, cwd: runCwd, delayMs: 0 });
    expect(submitted.status).toBe(201);
    const { run_id } = submitted.json as { run_id: string };
    await waitForDone(dir, run_id, baseUrl);

    const outputs = await api(baseUrl, "GET", `/api/runs/${run_id}/phases/build/outputs`);
    expect(outputs.status).toBe(200);
    const body = outputs.json as {
      run_id: string;
      phase: string;
      phase_id: string;
      files: string[];
      findings_md: string | null;
    };
    expect(body.run_id).toBe(run_id);
    expect(body.phase).toBe("build");
    expect(body.files).toContain("envelope.json");
    expect(body.findings_md).toBeNull();

    // a FINDINGS.md the agent wrote lands on the wire verbatim
    writeFileSync(join(dir, "runs", run_id, "build", "outputs", "FINDINGS.md"), "demo findings text");
    const withFindings = await api(baseUrl, "GET", `/api/runs/${run_id}/phases/build/outputs`);
    expect(withFindings.status).toBe(200);
    const body2 = withFindings.json as { files: string[]; findings_md: string | null };
    expect(body2.files).toContain("FINDINGS.md");
    expect(body2.findings_md).toBe("demo findings text");

    // ghost run / ghost phase → the same 404 semantics as the envelope/gate reads
    const ghostRun = await api(baseUrl, "GET", "/api/runs/ghost/phases/build/outputs");
    expect(ghostRun.status).toBe(404);
    const ghostPhase = await api(baseUrl, "GET", `/api/runs/${run_id}/phases/ghost/outputs`);
    expect(ghostPhase.status).toBe(404);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("pause viewer: override_targets = [\"neverGreen\"] on a budget pause (gate names, row order)", async () => {
  const dir = tmpDataDir("server-pause-override-targets");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-run-cwd-"));
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    // the budget-exhaustion blueprint's gate always fails → the correction
    // budget (1) exhausts and the run pauses with the override menu
    const controls = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "fixtures", "controls", "controls-blueprint.ts");
    const paused = await api(baseUrl, "POST", "/api/runs", { blueprint: controls, cwd: runCwd, delayMs: 0 });
    expect(paused.status).toBe(201);
    const pausedId = (paused.json as { run_id: string }).run_id;
    await waitForDone(dir, pausedId, baseUrl);

    const viewer = await api(baseUrl, "GET", `/api/runs/${pausedId}/pause`);
    expect(viewer.status).toBe(200);
    const view = viewer.json as { actions: string[]; override_targets?: string[] };
    expect(view.actions).toContain("override");
    // the failed gate's name rides the viewer — the override form's options
    expect(view.override_targets).toEqual(["neverGreen"]);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

test("pause viewer: override_targets absent on an approval pause (the menu offers no override)", async () => {
  const dir = tmpDataDir("server-pause-approval");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-run-cwd-"));
  let daemon: ServerHandle | null = null;
  try {
    daemon = await startServer({ dataDir: dir, port: 0 });
    const baseUrl = daemon.baseUrl;

    const approval = join(dirname(fileURLToPath(import.meta.url)), "..", "server", "fixtures", "approval-blueprint.ts");
    const appr = await api(baseUrl, "POST", "/api/runs", { blueprint: approval, cwd: runCwd, delayMs: 0 });
    expect(appr.status).toBe(201);
    const apprId = (appr.json as { run_id: string }).run_id;
    await waitForDone(dir, apprId, baseUrl);

    const viewer = await api(baseUrl, "GET", `/api/runs/${apprId}/pause`);
    expect(viewer.status).toBe(200);
    const view = viewer.json as { actions: string[]; override_targets?: string[] };
    expect(view.actions).not.toContain("override");
    expect(view.override_targets).toBeUndefined();
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});
