import { afterEach, describe, expect, test } from "bun:test";

import { dbPathFor } from "../../src/core/index.ts";
import { insertEvent, insertRun, onEventWritten, openDb } from "../../src/server/repository/db.ts";
import { emitRunChange, subscribeAll, subscribeRun } from "../../src/server/transport/change-bus.ts";
import { cleanupDir, tmpDataDir } from "./helpers.ts";

/**
 * The change bus (src/server/transport/change-bus.ts) + the db.ts event-written
 * emitter seam. The bus carries no data — only wake-ups — so the tests assert
 * wake-up counts and fan-out, never payloads. Each emitter subscription is
 * unsubscribed in teardown so no test leaks a live subscriber into the shared
 * db.test suite.
 */

const emitterCleanups: Array<() => void> = [];
afterEach(() => {
  while (emitterCleanups.length > 0) emitterCleanups.pop()!();
});

describe("change bus", () => {
  test("emitRunChange fans a run's wake-up to its run subscribers and every global subscriber", () => {
    const runHits: string[] = [];
    const allHits: string[] = [];
    subscribeRun("run-a", () => runHits.push("a"));
    subscribeRun("run-b", () => runHits.push("b"));
    subscribeAll(() => allHits.push("all"));

    emitRunChange("run-a");

    expect(runHits).toEqual(["a"]); // run-b's subscriber never fires
    expect(allHits).toEqual(["all"]); // the global subscriber always fires
  });

  test("emitting to an empty set is a no-op", () => {
    expect(() => emitRunChange("nobody-home")).not.toThrow();
  });

  test("unsubscribe stops delivery and is idempotent", () => {
    let hits = 0;
    const off = subscribeRun("run-x", () => (hits += 1));
    emitRunChange("run-x");
    expect(hits).toBe(1);

    off();
    emitRunChange("run-x");
    expect(hits).toBe(1); // no delivery after unsubscribe

    expect(() => off()).not.toThrow(); // second unsubscribe is a no-op
    emitRunChange("run-x");
    expect(hits).toBe(1);
  });

  test("subscribeAll unsubscribe is idempotent", () => {
    let hits = 0;
    const off = subscribeAll(() => (hits += 1));
    emitRunChange("any");
    expect(hits).toBe(1);
    off();
    off();
    emitRunChange("any");
    expect(hits).toBe(1);
  });

  test("a subscriber that unsubscribes mid-emit does not break the fan-out", () => {
    const order: string[] = [];
    let off2: (() => void) | null = null;
    subscribeRun("run-y", () => {
      order.push("first");
      off2?.();
    });
    off2 = subscribeRun("run-y", () => order.push("second"));
    subscribeRun("run-y", () => order.push("third"));

    expect(() => emitRunChange("run-y")).not.toThrow();
    expect(order).toContain("first");
    expect(order).toContain("third");
  });
});

describe("db.ts event-written emitter seam", () => {
  test("no emitRunChange wired → insertEvent does not reach the change bus (default unchanged)", () => {
    const dir = tmpDataDir("live-nohook");
    try {
      const db = openDb(dbPathFor(dir));
      insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
      let hits = 0;
      subscribeAll(() => (hits += 1)); // bus subscriber exists but nothing wires the emitter to it
      const id = insertEvent(db, {
        run_id: "r1",
        phase_id: null,
        agent_session_id: null,
        type: "run_status",
        ts: new Date().toISOString(),
        data: { from: "queued", to: "running" },
      });
      expect(id).toBeGreaterThan(0); // the insert still works
      expect(hits).toBe(0); // ...but nothing reached the change bus
    } finally {
      cleanupDir(dir);
    }
  });

  test("onEventWritten → insertEvent fires it with the row's run_id after the write", () => {
    const dir = tmpDataDir("live-hook");
    try {
      const db = openDb(dbPathFor(dir));
      insertRun(db, { id: "r2", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
      const seen: string[] = [];
      emitterCleanups.push(onEventWritten((runId) => seen.push(runId)));
      insertEvent(db, {
        run_id: "r2",
        phase_id: null,
        agent_session_id: null,
        type: "run_status",
        ts: new Date().toISOString(),
        data: { from: "queued", to: "running" },
      });
      expect(seen).toEqual(["r2"]);
    } finally {
      cleanupDir(dir);
    }
  });

  test("emitRunChange wired via onEventWritten reaches a run subscriber end to end", () => {
    const dir = tmpDataDir("live-wired");
    try {
      const db = openDb(dbPathFor(dir));
      insertRun(db, { id: "r3", blueprint: "b", status: "running", cwd: "/", needs_review: 0, started_at: "t", ended_at: null });
      emitterCleanups.push(onEventWritten(emitRunChange));
      let hits = 0;
      subscribeRun("r3", () => (hits += 1));
      insertEvent(db, {
        run_id: "r3",
        phase_id: null,
        agent_session_id: null,
        type: "run_status",
        ts: new Date().toISOString(),
        data: { from: "queued", to: "running" },
      });
      expect(hits).toBe(1);
    } finally {
      cleanupDir(dir);
    }
  });
});
