import { test, expect } from "bun:test";

import { RunPool } from "../../src/daemon/index.ts";

test("the pool runs at most `slots` runs concurrently and queues the rest (§5.4)", async () => {
  const pool = new RunPool(2);
  const started: string[] = [];
  const finished: string[] = [];
  const release = (id: string): void => pool.release(id);

  pool.enqueue("a", () => started.push("a"));
  pool.enqueue("b", () => started.push("b"));
  pool.enqueue("c", () => started.push("c"));
  // starts are dispatched on a microtask so enqueue never re-enters its caller
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toEqual(["a", "b"]); // two slots, two running
  expect(pool.queuedIds).toEqual(["c"]);

  release("a");
  await new Promise((r) => setTimeout(r, 0));
  expect(started).toEqual(["a", "b", "c"]); // the third starts as a slot frees
  expect(pool.queuedIds).toEqual([]);

  release("b");
  release("c");
  expect(pool.runningIds).toEqual([]);
  void finished;
});

test("the pool rejects a non-positive slot count", () => {
  expect(() => new RunPool(0)).toThrow(/positive/);
});
