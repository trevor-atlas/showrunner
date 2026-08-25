process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi, never real pi
/**
 * The SSE stream factory (src/server/lib/sse.ts) at the byte level plus the
 * two remix SSE routes through `router.fetch`. The stream factory tests drive
 * a fake subscribe/signal (no daemon); the route tests start an in-process
 * daemon (so requireServerState is set) and assert the event-stream headers and
 * the run-scoped 404-before-stream.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "../../src/core/index.ts";
import { startServer, type ServerHandle } from "../../src/server/lifecycle.ts";
import { insertRun, openDb } from "../../src/server/repository/db.ts";
import {
  CHANGE_FRAME,
  HEARTBEAT_FRAME,
  createSseStream,
  createSseResponse,
} from "../../src/server/lib/sse.ts";
import { router } from "../../src/server/router.ts";
import { routes } from "../../src/server/routes.ts";

const decoder = new TextDecoder();

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done || value === undefined) return "";
  return decoder.decode(value);
}

describe("createSseStream", () => {
  it("emits the byte-exact change frame when the bus wakes it", async () => {
    let fire: (() => void) | null = null;
    const stream = createSseStream({
      subscribe: (onChange) => {
        fire = onChange;
        return () => {};
      },
      heartbeatMs: 1_000_000, // no heartbeat within the test window
    });
    const reader = stream.getReader();
    fire!();
    expect(await readFrame(reader)).toBe(CHANGE_FRAME);
    expect(CHANGE_FRAME).toBe("event: change\ndata: {}\n\n");
    await reader.cancel();
  });

  it("emits the byte-exact heartbeat frame on the injected interval", async () => {
    const stream = createSseStream({
      subscribe: () => () => {},
      heartbeatMs: 5,
    });
    const reader = stream.getReader();
    expect(await readFrame(reader)).toBe(HEARTBEAT_FRAME);
    expect(HEARTBEAT_FRAME).toBe(": keepalive\n\n");
    await reader.cancel();
  });

  it("teardown on signal abort is idempotent, unsubscribes once, and clears the interval", async () => {
    const controller = new AbortController();
    let unsubscribes = 0;
    const stream = createSseStream({
      subscribe: () => () => {
        unsubscribes += 1;
      },
      signal: controller.signal,
      heartbeatMs: 5,
    });
    const reader = stream.getReader();
    controller.abort();
    controller.abort(); // second abort must not double-teardown
    const { done } = await reader.read();
    expect(done).toBe(true); // the stream closed on abort
    expect(unsubscribes).toBe(1); // unsubscribe fired exactly once
  });

  it("teardown on stream cancel unsubscribes exactly once", async () => {
    let unsubscribes = 0;
    const stream = createSseStream({
      subscribe: () => () => {
        unsubscribes += 1;
      },
      heartbeatMs: 1_000_000,
    });
    const reader = stream.getReader();
    await reader.cancel();
    expect(unsubscribes).toBe(1);
  });

  it("a pre-aborted signal closes immediately and never subscribes", async () => {
    let subscribed = false;
    const stream = createSseStream({
      subscribe: () => {
        subscribed = true;
        return () => {};
      },
      signal: AbortSignal.abort(),
      heartbeatMs: 5,
    });
    const reader = stream.getReader();
    const { done } = await reader.read();
    expect(done).toBe(true); // closed before any frame
    expect(subscribed).toBe(false); // never wired to the bus
  });

  it("enqueues nothing after close (a late wake-up is dropped)", async () => {
    let fire: (() => void) | null = null;
    const controller = new AbortController();
    const stream = createSseStream({
      subscribe: (onChange) => {
        fire = onChange;
        return () => {};
      },
      signal: controller.signal,
      heartbeatMs: 1_000_000,
    });
    const reader = stream.getReader();
    controller.abort();
    expect(() => fire!()).not.toThrow(); // late wake-up is a safe no-op
    const { done } = await reader.read();
    expect(done).toBe(true);
  });
});

describe("createSseResponse", () => {
  it("carries the event-stream headers", () => {
    const res = createSseResponse({ subscribe: () => () => {}, heartbeatMs: 1_000_000 });
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    void res.body?.cancel();
  });
});

// ── the SSE routes through router.fetch (in-process daemon) ─────────────────

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

describe("SSE routes through router.fetch", () => {
  let daemon: ServerHandle | null = null;
  let restoreDataDir: (() => void) | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    restoreDataDir?.();
    restoreDataDir = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("GET /live.sse opens an event-stream and closes on abort", async () => {
    dir = tmpDir("live-route");
    restoreDataDir = setDataDir(dir);
    daemon = await startServer({ dataDir: dir, port: 0 });

    const ac = new AbortController();
    const res = await router.fetch(
      new Request("http://localhost" + routes.live.href(), { signal: ac.signal }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    ac.abort();
    await res.body?.cancel();
  });

  it("GET /runs/:runId/events.sse opens an event-stream for a real run", async () => {
    dir = tmpDir("run-live-route");
    restoreDataDir = setDataDir(dir);
    daemon = await startServer({ dataDir: dir, port: 0 });

    const db = openDb(dbPathFor(dir));
    insertRun(db, {
      id: "run-1",
      blueprint: "b",
      status: "running",
      cwd: "/",
      needs_review: 0,
      started_at: "t",
      ended_at: null,
    });

    const ac = new AbortController();
    const res = await router.fetch(
      new Request("http://localhost" + routes.runs.live.href({ runId: "run-1" }), {
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    ac.abort();
    await res.body?.cancel();
  });

  it("GET /runs/:runId/events.sse 404s (JSON) for a ghost run before opening a stream", async () => {
    dir = tmpDir("ghost-live-route");
    restoreDataDir = setDataDir(dir);
    daemon = await startServer({ dataDir: dir, port: 0 });

    const res = await router.fetch(
      new Request("http://localhost" + routes.runs.live.href({ runId: "ghost" })),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type") ?? "").not.toContain("text/event-stream");
    expect(await res.json()).toEqual({ error: "run ghost not found" });
  });
});
