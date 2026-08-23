import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { ToolCallData } from "../../src/core/index.ts";
import {
  DEFAULT_RPC_TIMEOUT_MS,
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  FakeSessionDriver,
  PiSession,
  SESSION_ID_RE,
  Tracer,
  findPiBinary,
  sessionDriverKind,
  sessionIdFor,
} from "../../src/daemon/index.ts";
import type { FoldedEvent } from "../../src/daemon/index.ts";
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

// a probe stub: "pi" present on PATH vs absent — keeps the detection tests
// deterministic on any machine
const probe = (env: Record<string, string | undefined>) => (env.PI_BINARY === "none" ? null : "/usr/bin/pi");

test("SHOWRUNNER_FAKE=1 forces FakePi; SHOWRUNNER_SMOKE=1 forces real; else auto-detect", () => {
  // explicit fake wins over everything, including the smoke
  expect(sessionDriverKind({ SHOWRUNNER_FAKE: "1", SHOWRUNNER_SMOKE: "1" }, probe)).toBe("fake");
  expect(sessionDriverKind({ SHOWRUNNER_FAKE: "1" }, probe)).toBe("fake");
  // the smoke forces real even when detection would fail
  expect(sessionDriverKind({ SHOWRUNNER_SMOKE: "1" }, probe)).toBe("real");
  expect(sessionDriverKind({ SHOWRUNNER_SMOKE: "1", PI_BINARY: "none" }, probe)).toBe("real");
  // no env: real by default when a binary is found, fake when not
  expect(sessionDriverKind({}, probe)).toBe("real");
  expect(sessionDriverKind({ PI_BINARY: "none" }, probe)).toBe("fake");
});

test("findPiBinary resolves the override path, a bare name on PATH, or null", () => {
  // slash-bearing override: trusted only when the file exists
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "/usr/bin/true" })).toBe("/usr/bin/true");
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "/definitely/missing/pi" })).toBeNull();
  // bare name: looked up on PATH (this machine has /usr/bin/true)
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "true" })).toBe("/usr/bin/true");
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "definitely-not-a-binary-xyz" })).toBeNull();
  // fallback chain: SHOWRUNNER_PI_BINARY > PI_BINARY > the bare "pi" name. An
  // explicitly EMPTY override is "no binary" (the daemon auto-selects FakePi);
  // the bare-name fallback resolves via `which`, so its exact result depends on
  // whether pi is on THIS machine's PATH — assert only the precedence/emptying.
  expect(findPiBinary({ PI_BINARY: "/usr/bin/true" })).toBe("/usr/bin/true");
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "/usr/bin/true", PI_BINARY: "/definitely/missing/pi" })).toBe("/usr/bin/true");
  expect(findPiBinary({ SHOWRUNNER_PI_BINARY: "", PI_BINARY: "" })).toBeNull();
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

// ── G1 (T02 review): the settle latch — a settle arriving in the ack→register
//    window must NOT be dropped (a dropped settle would hang the run) ─────────

test("G1: a settle landing in the same stdout chunk as the prompt ack is latched, not dropped", async () => {
  const cwd = tmpCwd("g1");
  try {
    // MOCK_RPC_ONE_WRITE: the ack AND the whole turn arrive in ONE write — the
    // settle is processed before the caller's waitForSettled() can register
    // (without the latch this window drops the settle and hangs forever)
    const session = openSession({ cwd, env: { MOCK_RPC_ONE_WRITE: "1" } });
    await session.send({ type: "prompt", message: "go" }, DEFAULT_RPC_TIMEOUT_MS);
    const settled = await Promise.race([
      session.waitForSettled().then(
        () => "settled",
        () => "rejected",
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 4_000)),
    ]);
    expect(settled).toBe("settled"); // the latched settle resolves the waiter
    await session.close();
    expect(await session.exit).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 15_000 });

test("G1: each settle satisfies exactly one wait — a fast stream cannot double-resolve the next turn's waiter", async () => {
  const cwd = tmpCwd("g1seq");
  try {
    const session = openSession({ cwd });
    // two full turns back-to-back (each settles): two prompts, two settles
    for (let i = 0; i < 2; i++) {
      await session.send({ type: "prompt", message: `turn ${i}` }, DEFAULT_RPC_TIMEOUT_MS);
      const settled = await Promise.race([
        session.waitForSettled().then(
          () => "settled",
          () => "rejected",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 4_000)),
      ]);
      expect(settled).toBe("settled");
    }
    await session.close();
    expect(await session.exit).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, { timeout: 15_000 });

// ── §19 child-death flush, pinned against the raw stream through the REAL
//    driver seam (mock RPC): the settle waiter resolves with a crash verdict
//    (no hang) and the tracer flushes the open tool call as truncated ─────────

test("mid-tool-call death via the real seam: crash verdict + open tool call flushed ok:false truncated:true (§19)", async () => {
  const cwd = tmpCwd("flush");
  const eventsDir = tmpDataDir("pi-flush");
  try {
    // a turn that dies mid tool call: tool_execution_start, no end, no settle
    const eventsPath = join(eventsDir, "turn.jsonl");
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({ type: "agent_start", messageCount: 0, model: "mock-pi" }),
        JSON.stringify({ type: "turn_start" }),
        JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "hang" }),
        JSON.stringify({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "half" }] } }),
      ].join("\n") + "\n",
    );
    const folded: FoldedEvent[] = [];
    const tracer = new Tracer({
      phase: "build",
      visit: 1,
      agent: "builder",
      piSessionId: "t_build_v1",
      sink: (evt) => folded.push(evt),
      now: () => 1_000,
    });
    const session = openSession({
      cwd,
      env: { MOCK_RPC_EVENTS: eventsPath, MOCK_RPC_DIE_AFTER_TURN: "1", MOCK_RPC_EXIT_CODE: "1" },
      onLine: (line) => tracer.onLine(line),
    });
    void session.send({ type: "prompt", message: "go" }).catch(() => {});
    // the run does not hang: the settle waiter resolves with a crash verdict
    await expect(session.waitForSettled()).rejects.toThrow(/agent_settled/);
    expect(await session.exit).toBe(1);
    // §19: the open tool call is flushed as ok:false, truncated:true
    tracer.onEnd({ exitCode: session.exitCode }, { settled: false });
    const tool = folded.find((e) => e.type === "tool_call")!.data as z.infer<typeof ToolCallData>;
    expect(tool).toMatchObject({
      tool: "bash",
      tool_call_id: "c1",
      ok: false,
      truncated: true,
      args: "hang",
      result_snippet: "half", // the accumulated partial result, captured
    });
    const agentEnd = folded.find((e) => e.type === "agent_end")!.data as { exit: number | null; ok: boolean };
    expect(agentEnd).toMatchObject({ exit: 1, ok: false });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    cleanupDir(eventsDir);
  }
});


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
