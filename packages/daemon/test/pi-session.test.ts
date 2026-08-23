import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_RPC_TIMEOUT_MS,
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  SESSION_ID_RE,
  sessionDriverKind,
  sessionIdFor,
} from "../src/index.ts";
import { cleanupDir, tmpDataDir } from "./helpers.ts";

/**
 * The real-pi session driver (T02, spec §8) — unit-tested against a scripted
 * mock RPC process (no real pi, no tokens): LF framing, id-matched responses,
 * ack timeouts, stderr capture, settle/crash detection, and stop() lifecycle.
 * The byte-compat proof for the FakeSessionDriver lives in runner.test.ts
 * (the whole T01b suite drives the loop through it).
 */

function mockRpcPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "fixtures", "mock-rpc.ts");
}

function openSession(opts: {
  sessionId?: string;
  cwd: string;
  env?: Record<string, string>;
  onLine?: (line: string, final?: boolean) => void;
  stderrLimit?: number;
  cliPath?: string;
}): PiSession {
  return new PiSession({
    sessionId: opts.sessionId ?? "t_build_v1",
    cwd: opts.cwd,
    onLine: opts.onLine,
    stderrLimit: opts.stderrLimit,
    cliPath: opts.cliPath ?? process.execPath,
    args: [mockRpcPath(), "--session-id", opts.sessionId ?? "t_build_v1"],
    env: opts.env,
  });
}

function collectLines(): { lines: string[]; onLine: (line: string) => void } {
  const lines: string[] = [];
  return {
    lines,
    onLine: (line) => {
      lines.push(line);
    },
  };
}

function tmpCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-pi-${label}-`));
}

// ── driver kind selection (§17) ──────────────────────────────────────────────

test("SHOWRUNNER_SMOKE=1 selects the real driver; otherwise FakePi", () => {
  expect(sessionDriverKind({})).toBe("fake");
  expect(sessionDriverKind({ SHOWRUNNER_SMOKE: "0" })).toBe("fake");
  expect(sessionDriverKind({ SHOWRUNNER_SMOKE: "1" })).toBe("real");
  expect(sessionDriverKind({ SHOWRUNNER_SMOKE: "1", OTHER: "x" })).toBe("real");
});

// ── session id charset (§8.1) ────────────────────────────────────────────────

test("derived session ids match the pi charset; the driver rejects invalid ids", () => {
  const runId = "0123456789abcdef0123456789abcdef";
  for (const id of [sessionIdFor(runId, "build", 1), sessionIdFor(runId, "plan-review", 2), sessionIdFor(runId, "A", 3)]) {
    expect(id).toMatch(SESSION_ID_RE);
  }
  // a phase with hostile characters is sanitized into the charset
  const nasty = sessionIdFor(runId, "ship it/now!", 1);
  expect(nasty).toMatch(SESSION_ID_RE);
  expect(nasty).toBe(`${runId.slice(0, 8)}_ship_it_now__v1`);

  for (const bad of ["", "_lead", "trail_", "a b", "dash-"]) {
    expect(SESSION_ID_RE.test(bad)).toBe(false);
  }
});

// ── basic prompt flow: ack, stream, settle, reap ─────────────────────────────

test("prompt ack is id-matched; events stream raw; settle resolves; stdin EOF reaps exit 0", async () => {
  const cwd = tmpCwd("basic");
  const eventsDir = tmpDataDir("pi-events");
  const { lines, onLine } = collectLines();
  try {
    const eventsPath = join(eventsDir, "turn.jsonl");
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "agent_start", messageCount: 0, model: "mock-pi" }),
        JSON.stringify({ type: "turn_start" }),
        JSON.stringify({ type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } }),
        JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "ls" }),
        JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
        JSON.stringify({ type: "turn_end" }),
        JSON.stringify({ type: "agent_settled" }),
      ].join("\n") + "\n",
    );

    const session = openSession({ cwd, onLine, env: { MOCK_RPC_EVENTS: eventsPath } });
    const ack = await session.send({ type: "prompt", message: "go" }, DEFAULT_RPC_TIMEOUT_MS);
    expect(ack).toMatchObject({ id: "req_1", command: "prompt", success: true });

    await session.waitForSettled();
    expect(session.exitCode).toBeNull(); // still alive after settle

    await session.close();
    expect(await session.exit).toBe(0);
    expect(session.exitCode).toBe(0);

    // every raw line was delivered to the tracer callback, byte-identical,
    // including the response line (recorded raw, §7.4) and agent_settled
    const rawLines = lines.filter((l) => l.trim() !== "");
    expect(rawLines).toContain(JSON.stringify({ type: "agent_settled", sessionId: "t_build_v1" }));
    expect(rawLines.some((l) => l.includes('"type":"response"'))).toBe(true);
    expect(rawLines).toContain(
      JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "ls", sessionId: "t_build_v1" }),
    );
    // the response line carried the request id (echoed verbatim)
    expect(rawLines.some((l) => l.includes('"id":"req_1"'))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    cleanupDir(eventsDir);
  }
});

// ── LF-only framing: a line split across chunk boundaries (§7.1) ─────────────

test("partial lines across chunk boundaries are reassembled (LF-only framing)", async () => {
  const cwd = tmpCwd("chunked");
  try {
    const { lines, onLine } = collectLines();
    const session = openSession({ cwd, onLine, env: { MOCK_RPC_CHUNKED: "1" } });
    await session.send({ type: "prompt", message: "go" });
    await session.waitForSettled();
    await session.close();

    const rawLines = lines.filter((l) => l.trim() !== "");
    const settled = rawLines.find((l) => l.includes('"type":"agent_settled"'));
    expect(settled).toBe(JSON.stringify({ type: "agent_settled", sessionId: "t_build_v1" }));
    // the ack and every event arrived whole despite two writes per line
    expect(rawLines.some((l) => l.includes('"type":"response"') && l.includes('"id":"req_1"'))).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── concurrent id matching (§8.4) ────────────────────────────────────────────

test("concurrent commands each get their own id-matched response", async () => {
  const cwd = tmpCwd("ids");
  try {
    const session = openSession({ cwd });
    const [a, b, c] = await Promise.all([
      session.send({ type: "get_state" }),
      session.send({ type: "get_state" }),
      session.send({ type: "get_state" }),
    ]);
    expect(a).toMatchObject({ id: "req_1", command: "get_state", success: true });
    expect(b).toMatchObject({ id: "req_2", command: "get_state", success: true });
    expect(c).toMatchObject({ id: "req_3", command: "get_state", success: true });
    expect((a.data as { sessionId: string }).sessionId).toBe("t_build_v1");
    await session.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── ack timeout handling (§8.1: the model catalog refresh makes the first
//    prompt slow — a timed-out ack must not kill the session) ─────────────────

test("a slow ack times out the send without killing the process; later commands work", async () => {
  const cwd = tmpCwd("timeout");
  try {
    const session = openSession({ cwd, env: { MOCK_RPC_ACK_DELAY_MS: "1500" } });
    await expect(session.send({ type: "get_state" }, 200)).rejects.toThrow(/timeout waiting for response to get_state/);
    // the process is still alive and still answers id-matched
    const ack = await session.send({ type: "get_state" }, DEFAULT_RPC_TIMEOUT_MS);
    expect(ack).toMatchObject({ success: true, id: "req_2" });
    await session.close();
    expect(await session.exit).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the first-prompt ack budget is generous (slow catalog refresh)", () => {
  expect(FIRST_PROMPT_ACK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  expect(DEFAULT_RPC_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
});

// ── stream death before settle (§8.3 crash detection) ───────────────────────

test("stdout EOF without agent_settled rejects the settle waiter and pending sends", async () => {
  const cwd = tmpCwd("crash");
  const eventsDir = tmpDataDir("pi-crashevents");
  try {
    // a turn WITHOUT agent_settled; the mock dies right after streaming it
    const eventsPath = join(eventsDir, "turn.jsonl");
    writeFileSync(eventsPath, JSON.stringify({ type: "turn_start" }) + "\n");
    const session = openSession({ cwd, env: { MOCK_RPC_EVENTS: eventsPath, MOCK_RPC_DIE_AFTER_TURN: "1", MOCK_RPC_EXIT_CODE: "1" } });
    void session.send({ type: "prompt", message: "go" }).catch(() => {});
    await expect(session.waitForSettled()).rejects.toThrow(/agent_settled/);
    expect(await session.exit).toBe(1);
    expect(session.exitCode).toBe(1);
    // a send after death rejects instead of hanging
    await expect(session.send({ type: "get_state" })).rejects.toThrow(/not running/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    cleanupDir(eventsDir);
  }
});

// ── stop(): SIGTERM → SIGKILL after 1s (RpcClient.stop(), §8.3) ──────────────

test("stop() SIGTERMs the child; pi's handler exits 143", async () => {
  const cwd = tmpCwd("stop");
  try {
    const session = openSession({ cwd });
    await session.send({ type: "get_state" });
    await session.stop();
    expect(await session.exit).toBe(143); // pi's own SIGTERM handler (§8.1)
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("stop() escalates to SIGKILL when the child ignores SIGTERM", async () => {
  const cwd = tmpCwd("stopkill");
  try {
    const session = openSession({ cwd, env: { MOCK_RPC_IGNORE_SIGTERM: "1" } });
    await session.send({ type: "get_state" });
    const started = Date.now();
    await session.stop();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000); // SIGKILL fired after ~1s
    // the SIGKILL actually killed it: the exit promise resolves (not a hang)
    const exitCode = await Promise.race([
      session.exit,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5_000)),
    ]);
    expect(exitCode).not.toBe("timeout");
    // a signal-killed child reports code null (§8.1: pi's handlers exit 143/129;
    // SIGKILL bypasses them)
    expect(session.exitCode).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── stderr capture (§8.3) ────────────────────────────────────────────────────

test("stderr is captured per session and bounded by the cap", async () => {
  const cwd = tmpCwd("stderr");
  try {
    const session = openSession({
      cwd,
      env: { MOCK_RPC_STDERR: "AAAA|BBBB|CCCC" },
      stderrLimit: 12,
    });
    await session.send({ type: "get_state" });
    await new Promise((r) => setTimeout(r, 50)); // let the stderr chunks flush
    expect(session.stderr).toBe("AAAABBBBCCCC");
    await session.close();

    const capped = openSession({ cwd, env: { MOCK_RPC_STDERR: "AAAA|BBBB|CCCC" }, stderrLimit: 8 });
    await capped.send({ type: "get_state" });
    await new Promise((r) => setTimeout(r, 50));
    expect(capped.stderr).toBe("AAAABBBB"); // the chunk that crossed the cap is dropped
    await capped.close();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── the fake driver behind the same seam ─────────────────────────────────────

test("FakeSessionDriver speaks the same seam: prompt → turn → settle → exit 0", async () => {
  const cwd = tmpCwd("fakedrv");
  const eventsDir = tmpDataDir("pi-fake");
  try {
    const outputsDir = join(cwd, "context_handoff", "build", "outputs");
    mkdirSync(outputsDir, { recursive: true });
    const sessionFile = join(eventsDir, "session.json");
    const script = {
      turns: [
        {
          events: [
            { type: "agent_start", messageCount: 0, model: "fake-pi" },
            { type: "turn_start" },
            { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
            { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
            { type: "agent_settled" },
          ],
          envelope: { summary: "s", artifacts: [], notes_for_next_agent: "n" },
        },
      ],
    };
    const { lines, onLine } = collectLines();
    const session = new FakeSessionDriver({
      sessionId: "t_build_v1",
      cwd,
      script,
      sessionFile,
      outputsDir,
      delayMs: 0,
      onLine,
    });
    await session.send({ type: "prompt", message: "go" });
    await session.waitForSettled();
    await session.close();
    expect(await session.exit).toBe(0);
    expect(session.exitCode).toBe(0);
    expect(lines.some((l) => l.includes('"type":"agent_settled"'))).toBe(true);
    // the agent's envelope landed in context_handoff/<phase>/outputs (the §9 path)
    expect(readFileSync(join(outputsDir, "envelope.json"), "utf8")).toContain('"notes_for_next_agent"');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    cleanupDir(eventsDir);
  }
});
