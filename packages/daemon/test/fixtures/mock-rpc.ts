/**
 * A scripted pi-like RPC process for daemon unit tests — no real pi, no tokens.
 *
 * Mirrors the verified §8 wire contract: reads LF JSONL commands on stdin,
 * answers each with an id-matched `{"id":<req>,"type":"response",...}` on
 * stdout, and for `prompt` commands streams a scripted turn of agent events
 * (ending in agent_settled). stdin EOF exits 0 (the daemon reaps by closing
 * stdin, §8.3); SIGTERM exits 143 unless MOCK_RPC_IGNORE_SIGTERM=1 (pi's own
 * signal handlers, §8.1).
 *
 * Env:
 *   MOCK_RPC_EVENTS           path to a JSONL file of agent events to stream per prompt
 *                             (default: a minimal happy turn ending in agent_settled)
 *   MOCK_RPC_ACK_DELAY_MS     delay before writing each response (ack-timeout tests)
 *   MOCK_RPC_EVENT_DELAY_MS   delay between streamed events (default 1)
 *   MOCK_RPC_CHUNKED=1        write every stdout line in two halves (framing test)
 *   MOCK_RPC_STDERR           diagnostic line(s) to write to stderr, "|"-separated
 *                             chunks written as separate writes (§8.3 capture/cap)
 *   MOCK_RPC_EXIT_CODE        exit code on stdin close (default 0)
 *   MOCK_RPC_IGNORE_SIGTERM   do not exit on SIGTERM (stop() SIGKILL test)
 *   MOCK_RPC_DIE_AFTER_TURN   exit right after the first prompt's events (crash tests)
 *
 * Usage: bun mock-rpc.ts --session-id <id>
 */
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const sessionId = argValue("--session-id") ?? "mock";

const env = process.env;
const eventsPath = env.MOCK_RPC_EVENTS;
const ackDelayMs = Number(env.MOCK_RPC_ACK_DELAY_MS ?? "0") || 0;
const eventDelayMs = Number(env.MOCK_RPC_EVENT_DELAY_MS ?? "1") || 1;
const chunked = env.MOCK_RPC_CHUNKED === "1";
const exitCode = Number(env.MOCK_RPC_EXIT_CODE ?? "0") || 0;
const ignoreSigterm = env.MOCK_RPC_IGNORE_SIGTERM === "1";
const dieAfterTurn = env.MOCK_RPC_DIE_AFTER_TURN === "1";
const stderrLine = env.MOCK_RPC_STDERR;

const DEFAULT_EVENTS = [
  { type: "agent_start", messageCount: 0, model: "mock-pi" },
  { type: "turn_start" },
  { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
  { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
  { type: "agent_settled" },
];

let events: Record<string, unknown>[] = DEFAULT_EVENTS;
if (eventsPath) {
  events = readFileSync(eventsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// ── output helpers ───────────────────────────────────────────────────────────

// All stdout output is serialized per line, and process.exit() waits until
// every queued write has flushed — otherwise chunked (or backpressured) lines
// get dropped or interleaved mid-write. Chunked mode splits ONE line into two
// writes (a real mid-line chunk boundary for the §7.1 framing test) while
// keeping each line's bytes contiguous in the stream.
const lineQueue: string[] = [];
let lineWriting = false;
let wantExit: number | null = null;

function writeLine(text: string): void {
  lineQueue.push(text + "\n");
  pump();
}

function pump(): void {
  if (lineWriting) return;
  if (lineQueue.length === 0) {
    maybeExit();
    return;
  }
  lineWriting = true;
  const line = lineQueue.shift()!;
  const done = (): void => {
    lineWriting = false;
    pump();
  };
  if (!chunked) {
    process.stdout.write(line, done);
    return;
  }
  const half = Math.ceil(line.length / 2);
  process.stdout.write(line.slice(0, half), () => {
    setTimeout(() => process.stdout.write(line.slice(half), done), eventDelayMs);
  });
}

function maybeExit(): void {
  if (wantExit !== null && !lineWriting && lineQueue.length === 0 && !processing && queue.length === 0) {
    process.exit(wantExit);
  }
}

function requestExit(code: number): void {
  wantExit = code;
  maybeExit();
}

function respond(command: Record<string, unknown>): void {
  const id = command.id;
  const body: Record<string, unknown> = { id, type: "response", command: command.type, success: true };
  if (command.type === "get_state") {
    body.data = { sessionId, isStreaming: false, isCompacting: false, messageCount: 0 };
  }
  writeLine(JSON.stringify(body));
}

function streamEvents(): void {
  let i = 0;
  const pump = (): void => {
    if (i >= events.length) {
      if (dieAfterTurn) {
        requestExit(exitCode || 1);
      }
      return;
    }
    const evt = events[i];
    i += 1;
    writeLine(JSON.stringify({ ...evt, sessionId }));
    setTimeout(pump, eventDelayMs);
  };
  pump();
}

// ── stderr diagnostics (written in "|"-separated chunks) ─────────────────────

if (stderrLine) {
  const chunks = stderrLine.split("|");
  let i = 0;
  const pumpStderr = (): void => {
    if (i >= chunks.length) return;
    process.stderr.write(chunks[i]!);
    i += 1;
    setTimeout(pumpStderr, 2);
  };
  pumpStderr();
}

// ── signals (pi's convention: SIGTERM → 143, §8.1) ──────────────────────────

process.on("SIGTERM", () => {
  if (!ignoreSigterm) requestExit(143);
});
process.on("SIGHUP", () => {
  if (!ignoreSigterm) requestExit(129);
});

// ── stdin: LF-only command framing (mirrors the stdout contract, §7.1) ──────

const queue: Record<string, unknown>[] = [];
let processing = false;
let stdinEnded = false;

async function drain(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const cmd = queue.shift()!;
      if (ackDelayMs > 0) {
        await new Promise((r) => setTimeout(r, ackDelayMs));
      }
      if (cmd.type === "prompt") {
        // pi acks prompt at preflight success, then the turn streams (§8.4)
        respond(cmd);
        streamEvents();
      } else {
        respond(cmd);
      }
    }
  } finally {
    processing = false;
    maybeExit();
  }
}

const decoder = new StringDecoder("utf8");
let buf = "";
process.stdin.on("data", (chunk: Buffer) => {
  buf += decoder.write(chunk);
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === "") continue;
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(`mock-rpc: ignoring non-JSON command: ${line.slice(0, 200)}\n`);
      continue;
    }
    queue.push(cmd);
    void drain();
  }
});
process.stdin.on("end", () => {
  buf += decoder.end();
  stdinEnded = true;
  requestExit(exitCode);
});
