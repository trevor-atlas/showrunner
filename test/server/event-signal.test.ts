process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi, never real pi
/**
 * T5 (#73) — the repository-owned "event row written" emitter and its wiring to
 * the live change bus.
 *
 * Two seams:
 *   1. the repository emitter (src/server/repository/db.ts): `onEventWritten`
 *      fires with the row's run_id AFTER `insertEvent`, and its unsubscribe
 *      stops delivery. `insertEvent` is the SINGLE events-write chokepoint.
 *   2. the transport wiring (src/server/transport/http.ts): `createWebServer`
 *      subscribes `emitRunChange` to the repository emitter, so a write through
 *      `insertEvent` reaches a `subscribeRun` listener — and the subscription is
 *      disposed when the server tears down.
 *
 * The bus carries no data — only wake-ups — so these assert wake-up COUNTS,
 * never payloads. The chokepoint test is the bypass guard: one write must fire
 * exactly one signal; it FAILS if the signal is dropped (0) or double-fired (2).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor } from "../../src/core/index.ts";
import { insertEvent, insertRun, onEventWritten, openDb } from "../../src/server/repository/db.ts";
import { subscribeRun } from "../../src/server/transport/change-bus.ts";
import { startServer, type ServerHandle } from "../../src/server/lifecycle.ts";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-t5-${label}-`));
}

function newRunEvent(runId: string): Parameters<typeof insertEvent>[1] {
  return {
    run_id: runId,
    phase_id: null,
    agent_session_id: null,
    type: "run_status",
    ts: new Date().toISOString(),
    data: { from: "queued", to: "running" },
  };
}

describe("repository event-written emitter", () => {
  const cleanups: Array<() => void> = [];
  const dirs: string[] = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
    while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it("fires with the row's run_id after insertEvent", () => {
    const dir = tmpDir("emit");
    dirs.push(dir);
    const db = openDb(dbPathFor(dir));
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });

    const seen: string[] = [];
    cleanups.push(onEventWritten((runId) => seen.push(runId)));
    insertEvent(db, newRunEvent("r1"));

    expect(seen).toEqual(["r1"]);
  });

  it("unsubscribe stops delivery", () => {
    const dir = tmpDir("unsub");
    dirs.push(dir);
    const db = openDb(dbPathFor(dir));
    insertRun(db, { id: "r2", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });

    let hits = 0;
    const off = onEventWritten(() => (hits += 1));
    insertEvent(db, newRunEvent("r2"));
    expect(hits).toBe(1);

    off();
    insertEvent(db, newRunEvent("r2"));
    expect(hits).toBe(1); // no delivery after unsubscribe
  });

  it("insertEvent still writes with no subscriber", () => {
    const dir = tmpDir("nosub");
    dirs.push(dir);
    const db = openDb(dbPathFor(dir));
    insertRun(db, { id: "r3", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });

    const id = insertEvent(db, newRunEvent("r3"));
    expect(id).toBeGreaterThan(0);
  });
});

describe("createWebServer wiring: event-write → change bus", () => {
  let daemon: ServerHandle | null = null;
  let dir: string | null = null;
  const savedDataDir = process.env.SHOWRUNNER_DATA_DIR;

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
    if (savedDataDir === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = savedDataDir;
  });

  it("a write through insertEvent wakes a run subscriber (exactly one signal — chokepoint guard)", async () => {
    dir = tmpDir("wire");
    process.env.SHOWRUNNER_DATA_DIR = dir;
    daemon = await startServer({ dataDir: dir, port: 0 });

    const db = openDb(dbPathFor(dir));
    insertRun(db, { id: "run-a", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });

    let hits = 0;
    const off = subscribeRun("run-a", () => (hits += 1));
    try {
      insertEvent(db, newRunEvent("run-a"));
      expect(hits).toBe(1); // one write → exactly one wake-up
    } finally {
      off();
    }
  });

  it("disposes the subscription when the server tears down", async () => {
    dir = tmpDir("dispose");
    process.env.SHOWRUNNER_DATA_DIR = dir;
    daemon = await startServer({ dataDir: dir, port: 0 });

    const db = openDb(dbPathFor(dir));
    insertRun(db, { id: "run-b", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });

    let hits = 0;
    const off = subscribeRun("run-b", () => (hits += 1));
    try {
      insertEvent(db, newRunEvent("run-b"));
      expect(hits).toBe(1); // wired while the server is up

      await daemon.close();
      daemon = null;

      insertEvent(db, newRunEvent("run-b"));
      expect(hits).toBe(1); // subscription disposed on shutdown — no new wake-up
    } finally {
      off();
    }
  });
});
