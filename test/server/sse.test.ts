process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi, never real pi
/**
 * The browser SSE substrate: `createCoalescedNotifier` as a pure unit, plus
 * ONE end-to-end run over real TCP — a live daemon, real HTTP, the SSE frames
 * arriving in the browser wire format, and the connection surviving a
 * heartbeat before an abort tears it down.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "../../src/core/index.ts";
import { startDaemon, type DaemonHandle } from "../../src/server/lifecycle.ts";
import { insertEvent, insertRun, openDb } from "../../src/server/repository/db.ts";
import { createCoalescedNotifier } from "../../src/server/actions/public/sse.ts";
import { routes } from "../../src/server/routes.ts";

// ── createCoalescedNotifier (pure) ──────────────────────────────────────────

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A promise the test resolves by hand — the "in-flight" refetch. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("createCoalescedNotifier", () => {
  it("idle → the wrapped fn is never called", async () => {
    let calls = 0;
    createCoalescedNotifier(() => {
      calls += 1;
    });
    await tick();
    expect(calls).toBe(0);
  });

  it("a synchronous burst collapses to a single call", async () => {
    let calls = 0;
    const notify = createCoalescedNotifier(() => {
      calls += 1;
    });
    notify();
    notify();
    notify();
    await tick();
    expect(calls).toBe(1);
  });

  it("a notify during an in-flight async call schedules exactly one trailing rerun", async () => {
    let calls = 0;
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    const notify = createCoalescedNotifier(() => {
      const gate = gates[calls];
      calls += 1;
      return gate ? gate.promise : Promise.resolve();
    });

    notify(); // schedules the leading run
    await tick(); // leading run starts (call #1), now in flight
    expect(calls).toBe(1);

    notify(); // arrives mid-flight → marks ONE trailing rerun
    notify(); // folds into the same trailing rerun
    notify();
    expect(calls).toBe(1); // still only the leading run running

    first.resolve(); // leading run settles → trailing rerun fires
    await tick();
    expect(calls).toBe(2); // exactly one trailing rerun, not three

    second.resolve();
    await tick();
    expect(calls).toBe(2); // no further runs once idle
  });
});

// ── e2e over real TCP ───────────────────────────────────────────────────────

const dataDir = mkdtempSync(join(tmpdir(), "showrunner-sse-e2e-"));
let daemon: DaemonHandle | null = null;

afterAll(async () => {
  await daemon?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Open the SSE URL over real HTTP, retrying once on the lazy-router 503
 * warm-up seam (the dashboard router import is in flight on first request). */
async function openSse(
  url: string,
  signal: AbortSignal,
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
    if (res.status !== 503) return res;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 200));
  }
  return fetch(url, { headers: { Accept: "text/event-stream" }, signal });
}

describe("SSE e2e over real TCP", () => {
  it("streams a byte-exact change frame as events are written, then closes on abort", async () => {
    daemon = await startDaemon({ dataDir, port: 0 });
    const base = daemon.baseUrl;

    const db = openDb(dbPathFor(dataDir));
    insertRun(db, {
      id: "e2e-run",
      blueprint: "b",
      status: "running",
      cwd: "/",
      needs_review: 0,
      started_at: "t",
      ended_at: null,
    });

    // NOTE: Bun's in-process `fetch` client buffers a streamed loopback body
    // until a flush; a short heartbeat forces prompt flushes so change frames
    // surface without a 25s wait (real browsers flush per res.write — this knob
    // is a test-transport accommodation, not a production behavior).
    const ac = new AbortController();
    const res = await openSse(
      base + routes.runs.live.href({ runId: "e2e-run" }) + "?heartbeat_ms=100",
      ac.signal,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // SSE is lossy by design (correctness is the cursor refetch), and `fetch`
    // resolves on headers before the server-side stream subscribes — so a lone
    // early insert can race the subscription. Keep inserting until a change
    // frame lands, proving the write → hook → bus → frame path delivers.
    let seq = 1;
    const inserter = setInterval(() => {
      insertEvent(db, {
        run_id: "e2e-run",
        phase_id: null,
        agent_session_id: null,
        type: "run_status",
        ts: new Date().toISOString(),
        data: { from: "queued", to: `running-${seq++}` },
      });
    }, 200);

    let buffer = "";
    const deadline = Date.now() + 10_000;
    try {
      while (Date.now() < deadline && !buffer.includes("event: change\ndata: {}\n\n")) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
    } finally {
      clearInterval(inserter);
    }
    expect(buffer).toContain("event: change\ndata: {}\n\n");

    ac.abort();
    await reader.cancel().catch(() => {});
  }, { timeout: 30_000 });

  it("holds the socket open past one heartbeat interval (a keepalive arrives)", async () => {
    if (daemon === null) daemon = await startDaemon({ dataDir, port: 0 });
    const base = daemon.baseUrl;

    // drive a short heartbeat via the test knob and confirm a keepalive frame
    // arrives PAST that interval with no run activity — the socket stays open
    const ac = new AbortController();
    const res = await openSse(base + routes.live.href() + "?heartbeat_ms=60", ac.signal);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let buffer = "";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !buffer.includes(": keepalive\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer).toContain(": keepalive\n\n"); // the heartbeat kept the socket alive

    ac.abort();
    await reader.cancel().catch(() => {});
  }, { timeout: 30_000 });
});
