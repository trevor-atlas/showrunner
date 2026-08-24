import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShell, runCommand } from "../../src/core/index.ts";

/**
 * The shell seam — `createShell(cwd)` returns `(cmd) => Promise<ShellResult>`.
 *
 * The backpressure doctrine ("the tracer's stdout read loop must never
 * block on ... gate execution") and the capstone finding that command gates
 * froze the daemon's event loop (spawnSync): the shell MUST be truly async —
 * a shell command running must not block unrelated timers/IO in the process.
 * These tests pin the result shape AND the non-blocking contract.
 */

function tmpCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `core-shell-${label}-`));
}

test("createShell runs /bin/sh -c and returns the full result", async () => {
  const cwd = tmpCwd("run");
  try {
    const res = await createShell(cwd)("printf 'hello %s\\n' world; printf 'err\\n' >&2");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("hello world\n");
    expect(res.stderr).toBe("err\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("createShell reports a non-zero exit code with output tails", async () => {
  const cwd = tmpCwd("fail");
  try {
    const res = await createShell(cwd)("printf 'boom\\n' >&2; exit 3");
    expect(res.code).toBe(3);
    expect(res.stdout).toBe("");
    expect(res.stderr).toBe("boom\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a command that exceeds the timeout cap is killed: code -1, no hang", async () => {
  const cwd = tmpCwd("timeout");
  try {
    const t0 = Date.now();
    const res = await createShell(cwd, { timeoutMs: 400 })("sleep 5");
    const elapsed = Date.now() - t0;
    expect(res.code).toBe(-1); // killed by the cap — a gate sees a failed result, never a hang
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(5_000); // the cap fired, the child was reaped
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("backpressure: the event loop stays responsive WHILE a shell command runs (no spawnSync)", async () => {
  const cwd = tmpCwd("async");
  try {
    const t0 = Date.now();
    let timerAt = 0;
    // a 50ms timer armed BEFORE the 2s command starts
    const timer = setTimeout(() => {
      timerAt = Date.now();
    }, 50);
    const res = await createShell(cwd)("sleep 2");
    const cmdDone = Date.now();
    clearTimeout(timer);
    expect(res.code).toBe(0);
    // the command really slept ~2s
    expect(cmdDone - t0).toBeGreaterThanOrEqual(1900);
    // the 50ms timer fired while the command was still running (a spawnSync
    // implementation would defer it until the 2s block returned)
    expect(timerAt).toBeGreaterThan(0);
    expect(timerAt - t0).toBeLessThan(cmdDone - t0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("runCommand one-shot matches createShell", async () => {
  const cwd = tmpCwd("oneshot");
  try {
    const res = await runCommand(cwd, "echo one-shot");
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("one-shot\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
