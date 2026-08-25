import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { LineSplitter } from "../linesplit.ts";
import { classifyLine, SETTLED_KIND } from "./raw-lines.ts";
import { DEFAULT_STDERR_CAP, SESSION_ID_RE } from "./session-driver.ts";
import type { SessionDriver } from "./session-driver.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

/** Default per-command response timeout (pi's own RpcClient uses 30s). */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * The first prompt's ack can lag while pi refreshes its model catalog (15s,
 *) — allow generous slack without blocking the loop forever. Corrections
 * go fire-and-forget (the settle signal gates the loop, not the ack).
 */
export const FIRST_PROMPT_ACK_TIMEOUT_MS = 60_000;

/** How long stop() waits between SIGTERM and SIGKILL (RpcClient.stop()). */
export const SIGKILL_AFTER_MS = 1_000;

export interface PiSessionOptions {
  /** create-or-continue session id */
  sessionId: string;
  /** spawn cwd — there is no --cwd flag (verified), cwd is set via spawn */
  cwd: string;
  /** extra env for the child (merged over process.env) */
  env?: Record<string, string>;
  /** every raw stdout line (LF-split), before parsing — feeds the tracer */
  onLine?: (line: string, final?: boolean) => void;
  /** stderr capture cap */
  stderrLimit?: number;
  /** CLI entry override (default: SHOWRUNNER_PI_BINARY ?? PI_BINARY ?? "pi") */
  cliPath?: string;
  /** CLI args override (default: the RPC invocation) */
  args?: string[];
}

export function resolvePiBinary(env: Record<string, string | undefined> = process.env): string {
  return env.SHOWRUNNER_PI_BINARY ?? env.PI_BINARY ?? "pi";
}

interface PendingRequest {
  resolve: (r: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * The real pi session driver. Spawns `pi --mode rpc --session-id
 * <id> --approve` with cwd = run.cwd (never `--session`, which errors on
 * absent sessions, and never `--cwd`, which does not exist — verified), writes
 * LF JSONL commands to stdin, reads the pure-JSONL stdout stream (LF-only
 * framing, ; pi reroutes stray stdout to stderr in rpc mode), captures
 * stderr, and owns the lifecycle: close stdin to reap (exit 0), or SIGTERM →
 * SIGKILL after 1s (the semantics of pi's bundled RpcClient.stop()).
 *
 * Backpressure: the read loop never blocks on SQLite. Raw lines are
 * handed to the `onLine` callback synchronously — the tracer appends them to
 * raw_output.jsonl (the safe buffer) and pushes folded events to the queue
 * sink — and the RPC layer only touches in-memory maps. If the server stops
 * draining stdout, pi stalls on its own pipe; the server never blocks the
 * read loop on a DB write.
 */
export class PiSession implements SessionDriver {
  private readonly child: ChildProcess;
  private readonly onLine: (line: string, final?: boolean) => void;
  private readonly stderrLimit: number;
  private exitCodeValue: number | null = null;
  private settleWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  /**
   * The stream is closed (the child exited OR was killed). Latched SEPARATELY
   * from exitCodeValue because a signal-killed child reports exitCode null —
   * and null must not mean "still alive": the run loop's sendPrompt catch
   * treats a null exit code as a slow-ack timeout and proceeds to
   * waitForSettled, which must then reject. Without this latch a death during
   * the ack window is lost forever and the run hangs (T13 capstone: SIGKILL
   * the pi child mid-flight).
   */
  private closed = false;
  /**
   * The settle latch (G1, T02 review): `agent_settled` is recorded even when
   * no waiter is registered yet, so a settle that arrives between the prompt
   * ack's resolution and the loop's `waitForSettled()` registration is NOT
   * dropped — without the latch that window would hang the run forever.
   * `settleSeq` counts every settle seen; `consumedSeq` counts settles already
   * consumed by a `waitForSettled()` resolution. Each call consumes exactly
   * the NEXT un-consumed settle (edge-triggered), so a fast stream can never
   * make one settle satisfy two waits, and a slow one never loses a settle.
   */
  private settleSeq = 0;
  private consumedSeq = 0;
  private nextRequestId = 0;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrChunks: string[] = [];
  private stderrBytes = 0;
  private exitResolve: (code: number | null) => void = () => {};
  readonly exit: Promise<number | null>;

  constructor(opts: PiSessionOptions) {
    if (!SESSION_ID_RE.test(opts.sessionId)) {
      throw new Error(
        `invalid pi session id "${opts.sessionId}" (must match ${SESSION_ID_RE.toString()})`,
      );
    }
    this.onLine = opts.onLine ?? (() => {});
    this.stderrLimit = opts.stderrLimit ?? DEFAULT_STDERR_CAP;
    this.exit = new Promise<number | null>((resolve) => {
      this.exitResolve = resolve;
    });

    const cliPath = opts.cliPath ?? resolvePiBinary(opts.env ?? process.env);
    const args = opts.args ?? ["--mode", "rpc", "--session-id", opts.sessionId, "--approve"];
    const child = spawn(cliPath, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    // stderr: real diagnostics live here — bounded capture per run
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes <= this.stderrLimit) this.stderrChunks.push(chunk.toString("utf8"));
    });
    // a dead child's pipe must not crash the server with an unhandled 'error'
    child.stdin?.on("error", () => {});

    // stdout: pure JSONL, LF-only framing — Node readline is non-compliant
    const decoder = new StringDecoder("utf8");
    const splitter = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      for (const line of splitter.push(text)) this.handleLine(line, false);
    });

    child.on("error", (err: Error) => {
      this.rejectAll(new Error(`failed to spawn ${cliPath}: ${err.message}`));
      this.exitResolve(null);
    });
    child.on("close", (code: number | null) => {
      // flush any unterminated final line byte-identically BEFORE anything
      // else — the tracer appends it without inventing a trailing newline
      for (const line of splitter.push(decoder.end())) this.handleLine(line, false);
      for (const line of splitter.flush()) this.handleLine(line, true);
      this.exitCodeValue = code;
      this.closed = true;
      this.exitResolve(code);
      const w = this.settleWaiter;
      this.settleWaiter = null;
      if (w) w.reject(new Error(`session died before agent_settled (exit ${code})`));
      this.rejectAll(new Error(`agent process exited (code=${code})`));
    });
  }

  get pid(): number {
    return this.child.pid ?? 0;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get stderr(): string {
    return this.stderrChunks.join("");
  }

  /** Send one command; resolves with the id-matched response. */
  send(command: RpcCommand, timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): Promise<RpcResponse> {
    const stdin = this.child.stdin;
    if (this.exitCodeValue !== null || !stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new Error(`agent process is not running (exit ${this.exitCodeValue})`));
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const id = `req_${++this.nextRequestId}`;
      const line = JSON.stringify({ ...command, id }) + "\n";
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response to ${command.type} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        stdin.write(line);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  waitForSettled(): Promise<void> {
    // a SIGNAL-killed child reports exitCode null — the closed latch is what
    // makes the death visible; null exitCode must not mean "still alive"
    if (this.exitCodeValue !== null || this.closed) {
      return Promise.reject(
        new Error(`session died before agent_settled (exit ${this.exitCodeValue})`),
      );
    }
    // G1: a settle already latched (arrived before this registration) is
    // consumed immediately — never dropped in the ack→register window.
    if (this.settleSeq > this.consumedSeq) {
      this.consumedSeq = this.settleSeq;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.settleWaiter = {
        // consume exactly ONE settle when it arrives (edge-triggered): a
        // second settle arriving while this waiter is pending stays latched
        // for the NEXT waitForSettled call.
        resolve: () => {
          this.consumedSeq += 1;
          resolve();
        },
        reject,
      };
    });
  }

  /** stdin EOF → pi exits 0. Resolves when the process is gone. */
  async close(): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {
      // already closed / never opened
    }
    await this.exit;
  }

  /** fail-run semantics (pi's RpcClient.stop()): SIGTERM, SIGKILL after 1s. */
  async stop(): Promise<void> {
    if (this.exitCodeValue !== null || !this.child.pid) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      // already gone
    }
    await Promise.race([
      this.exit,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // already gone
          }
          resolve();
        }, SIGKILL_AFTER_MS);
        void this.exit.then(() => clearTimeout(timer));
      }),
    ]);
  }

  // ── line dispatch ─────────────────────────────────────────────────────────

  private handleLine(line: string, final: boolean): void {
    // every raw line goes to the tracer first (append-before-parse)
    this.onLine(line, final);
    const c = classifyLine(line);
    if (c.kind === "response") {
      this.handleResponse(c.evt!);
    } else if (c.kind === SETTLED_KIND) {
      // agent_settled is authoritative — fires only when no automatic
      // retry/compaction/continuation remains. Latch FIRST (G1): a settle
      // with no waiter registered is remembered, not dropped.
      this.settleSeq += 1;
      const w = this.settleWaiter;
      this.settleWaiter = null;
      w?.resolve();
    }
  }

  private handleResponse(evt: Record<string, unknown>): void {
    const id = evt.id;
    if (typeof id !== "string" && typeof id !== "number") return;
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) return; // stray/late ack — ignore
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.resolve({
      id,
      command: typeof evt.command === "string" ? evt.command : undefined,
      success: evt.success === true,
      data: evt.data,
      error: typeof evt.error === "string" ? evt.error : undefined,
    });
  }

  private rejectAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
