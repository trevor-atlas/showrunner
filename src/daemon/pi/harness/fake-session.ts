/**
 * FakePi session runner (T01b) — the scripted, multi-turn pi stand-in
 * that the run loop drives.
 *
 * Mirrors pi's RPC contract: a long-lived process that reads JSON
 * commands on stdin, writes JSONL events on stdout, and is keyed by a
 * create-or-continue `--session-id`. Each `prompt` command advances the script
 * one turn: the turn's events are streamed to stdout (agent_settled ends the
 * turn) and the turn's envelope is written to <output>/envelope.json — the
 * agent's "typed result". stdin EOF exits 0 (the daemon reaps by
 * closing stdin).
 *
 * The same `--session-id` is reused across corrections: the daemon re-prompts
 * the SAME process, and the script advances to the next turn. When the script
 * runs out of turns, the last turn repeats (so a budget-exhausted phase keeps
 * producing the same failing envelope until the daemon gives up).
 *
 * Usage: bun fake-session.ts <session-file.json> --session-id <id> --output <dir>
 *
 * The session file shape (the "scripted session" seam):
 *   { turns: [{ events: [...], envelope: {...} }], unterminatedFinalLine?: bool }
 * `unterminatedFinalLine: true` makes the process emit its very last event
 * WITHOUT a trailing newline — the raw record must then be byte-identical
 * to the stream, i.e. no newline is appended to an unterminated final line.
 *
 * Env: FAKE_PI_DELAY_MS  pause between lines (default 0)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const sessionFile = args[0];
function argValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const sessionId = argValue("--session-id");
const outputDir = argValue("--output");
if (!sessionFile || !sessionId || !outputDir) {
  process.stderr.write("fake-session: usage: fake-session.ts <session-file> --session-id <id> --output <dir>\n");
  process.exit(2);
}
const SESSION_ID: string = sessionId;
const OUTPUT_DIR: string = outputDir;

interface ScriptedTurn {
  events: Record<string, unknown>[];
  envelope: Record<string, unknown>;
  /** extra files the agent "writes" to <output>/<path> (path → content); the
   * paths listed in envelope.artifacts become the next phase's inputs */
  artifacts?: Record<string, string>;
}
interface ScriptedSession {
  turns: ScriptedTurn[];
  unterminatedFinalLine?: boolean;
  /** after the last scripted turn, exit instead of waiting for more commands */
  exitAfterLastTurn?: { code?: number };
}

let script: ScriptedSession;
try {
  script = JSON.parse(readFileSync(sessionFile, "utf8")) as ScriptedSession;
} catch (err) {
  process.stderr.write(`fake-session: cannot read session file: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(2);
}
if (!Array.isArray(script.turns) || script.turns.length === 0) {
  process.stderr.write("fake-session: session file must define at least one turn\n");
  process.exit(2);
}

const delayMs = Number(process.env.FAKE_PI_DELAY_MS ?? "0") || 0;
const turns = script.turns;
const lastTurnIdx = turns.length - 1;
const unterminatedFinal = script.unterminatedFinalLine === true;

// v3 session-file mimicry (verified): real pi writes its session tree at
// <sessionDir>/--<sanitized-cwd>--/<ts>_<id>.jsonl (sanitized: leading separator
// stripped, [/\:] → "-"). FakePi mirrors that when PI_CODING_AGENT_SESSION_DIR
// is set (tests) so the daemon's "don't fight pi's session tree" contract is
// provable hermetically — env unset = no session file, no ~/.pi pollution.
const mirrorSessionFile = ((): string | null => {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (!root) return null;
  const safe = `--${process.cwd().replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(root, safe, `${ts}_${SESSION_ID}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  return path;
})();

// One process, one command at a time; commands received while a turn is
// streaming are queued (pi's FIFO steering queue). Each prompt consumes
// the next scripted turn.
const commandQueue: Record<string, unknown>[] = [];
let streaming = false;
let turnCounter = 0;
let stdinEnded = false;

// ── turn pump ────────────────────────────────────────────────────────────────

/** Stream one turn; resolve when the last event is flushed. */
function streamTurn(turn: ScriptedTurn, turnIdx: number): Promise<void> {
  return new Promise((resolve) => {
    const events = turn.events;
    let i = 0;
    const pump = (): void => {
      if (i >= events.length) {
        resolve();
        return;
      }
      const evt = events[i];
      i += 1;
      const lastOfTurn = i === events.length;
      const lastOfScript = turnIdx === lastTurnIdx && lastOfTurn;
      // the envelope must be durable before agent_settled is emitted: the
      // daemon reads the file as soon as it sees the settle line
      if (lastOfTurn) {
        writeEnvelope(turn.envelope);
        writeArtifacts(turn.artifacts);
      }
      const line = JSON.stringify({ ...evt, sessionId: SESSION_ID }) + (lastOfScript && unterminatedFinal ? "" : "\n");
      if (mirrorSessionFile !== null) appendFileSync(mirrorSessionFile, line);
      process.stdout.write(line, () => {
        if (delayMs > 0) setTimeout(pump, delayMs);
        else pump();
      });
    };
    pump();
  });
}

function writeEnvelope(envelope: Record<string, unknown>): void {
  writeFileSync(join(OUTPUT_DIR, "envelope.json"), JSON.stringify(envelope, null, 2) + "\n");
}

function writeArtifacts(artifacts: Record<string, string> | undefined): void {
  if (!artifacts) return;
  for (const [rel, content] of Object.entries(artifacts)) {
    const target = join(OUTPUT_DIR, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

// ── command dispatch ─────────────────────────────────────────────────────────

async function handleCommand(cmd: Record<string, unknown>): Promise<void> {
  const type = cmd.type;
  if (type !== "prompt" && type !== "steer" && type !== "follow_up") {
    // unknown/machinery command: ignore (the daemon only sends prompts today)
    return;
  }
  const turnIdx = Math.min(turnCounter, lastTurnIdx);
  turnCounter += 1;
  await streamTurn(turns[turnIdx]!, turnIdx);
  // a scripted death after the last turn — simulates a session dying mid-work
  if (script.exitAfterLastTurn && turnCounter >= turns.length) {
    process.exit(script.exitAfterLastTurn.code ?? 1);
  }
}

async function drain(): Promise<void> {
  if (streaming) return;
  streaming = true;
  try {
    while (commandQueue.length > 0) {
      const cmd = commandQueue.shift()!;
      await handleCommand(cmd);
    }
  } finally {
    streaming = false;
    if (stdinEnded) process.exit(0);
  }
}

// ── stdin: LF-only command framing (mirrors the stdout contract) ───────

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === "") continue;
    let cmd: Record<string, unknown>;
    try {
      cmd = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stderr.write(`fake-session: ignoring non-JSON command: ${line.slice(0, 200)}\n`);
      continue;
    }
    commandQueue.push(cmd);
    void drain();
  }
});
process.stdin.on("end", () => {
  // stdin closed = the daemon reaped us; exit 0 once the stream settles
  stdinEnded = true;
  if (!streaming && commandQueue.length === 0) process.exit(0);
});
