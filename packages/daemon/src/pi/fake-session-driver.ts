import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fakeSessionEntryPath } from "@showrunner/core/test/fixtures";
import { LineSplitter } from "../linesplit.ts";
import { DEFAULT_STDERR_CAP } from "./session-driver.ts";
import type { SessionDriver } from "./session-driver.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

export interface FakeSessionDriverOptions {
  /** create-or-continue session id (§8.1) — same shape pi expects */
  sessionId: string;
  /** spawn cwd */
  cwd: string;
  /**
   * The scripted session (spec §17) — written to `sessionFile`, which
   * fake-session.ts reads. The run record stays self-contained in the run dir.
   */
  script: unknown;
  /** absolute path to write the session file to (runDir/sessions/<slug>-v<visit>.json) */
  sessionFile: string;
  /** context_handoff/<phase>/outputs — where the fake writes envelope.json */
  outputsDir: string;
  /** pause between streamed lines (FAKE_PI_DELAY_MS) */
  delayMs?: number;
  /** extra env for the child (merged over process.env) */
  env?: Record<string, string>;
  /** every raw stdout line (LF-split, §7.1), before parsing — feeds the tracer */
  onLine?: (line: string, final?: boolean) => void;
  /** stderr capture cap (§8.3) */
  stderrLimit?: number;
}

/**
 * The scripted FakePi session driver (spec §17, T01b) — the deterministic,
 * no-pi, no-token stand-in behind the same SessionDriver seam. It spawns
 * packages/core/test/fake-session.ts (the exact process T01b's loop spawned)
 * with the exact same arguments and env, so downstream behavior is
 * byte-compatible: prompt commands advance the script one turn, agent_settled
 * ends the turn, stdin EOF exits 0.
 *
 * The fake does not speak RPC acks (fake-session.ts never writes responses),
 * so `send` is fire-and-forget: it writes the command line and resolves with
 * a synthetic `success: true` — matching the T01b loop's usage of a plain
 * stdin write. The settle signal is what actually gates the loop (§8.3).
 */
export class FakeSessionDriver implements SessionDriver {
  private readonly child: ChildProcess;
  private readonly onLine: (line: string, final?: boolean) => void;
  private readonly stderrLimit: number;
  private exitCodeValue: number | null = null;
  private settleWaiter: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private readonly stderrChunks: string[] = [];
  private stderrBytes = 0;
  private exitResolve: (code: number | null) => void = () => {};
  readonly exit: Promise<number | null>;

  constructor(opts: FakeSessionDriverOptions) {
    this.onLine = opts.onLine ?? (() => {});
    this.stderrLimit = opts.stderrLimit ?? DEFAULT_STDERR_CAP;
    // the scripted session file lives in the run dir — the run record is
    // self-contained (T01b wrote it here; the driver owns it now)
    mkdirSync(dirname(opts.sessionFile), { recursive: true });
    writeFileSync(opts.sessionFile, JSON.stringify(opts.script));
    this.exit = new Promise<number | null>((resolve) => {
      this.exitResolve = resolve;
    });

    const child = spawn(
      process.execPath,
      [
        fakeSessionEntryPath(),
        opts.sessionFile,
        "--session-id",
        opts.sessionId,
        "--output",
        opts.outputsDir,
      ],
      {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...opts.env, FAKE_PI_DELAY_MS: String(opts.delayMs ?? 0) },
      },
    );
    this.child = child;

    // stderr: same bounded capture convention as the real driver (§8.3)
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes <= this.stderrLimit) this.stderrChunks.push(chunk.toString("utf8"));
    });
    child.stdin?.on("error", () => {});

    // stdout: LF-only framing, byte-identical to T01b's read loop
    const decoder = new StringDecoder("utf8");
    const splitter = new LineSplitter();
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      for (const line of splitter.push(text)) this.handleLine(line, false);
    });

    child.on("error", (err: Error) => {
      // send() is fire-and-forget (no pending acks), so a dead stream surfaces
      // through waitForSettled, which the close handler rejects
      this.exitResolve(null);
      void err;
    });
    child.on("close", (code: number | null) => {
      for (const line of splitter.push(decoder.end())) this.handleLine(line, false);
      for (const line of splitter.flush()) this.handleLine(line, true);
      this.exitCodeValue = code;
      this.exitResolve(code);
      const w = this.settleWaiter;
      this.settleWaiter = null;
      if (w) w.reject(new Error(`session died before agent_settled (exit ${code})`));
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

  /** Fire-and-forget (the fake does not ack); resolves success immediately. */
  send(command: RpcCommand): Promise<RpcResponse> {
    const stdin = this.child.stdin;
    if (this.exitCodeValue !== null || !stdin || stdin.destroyed || !stdin.writable) {
      return Promise.reject(new Error(`agent process is not running (exit ${this.exitCodeValue})`));
    }
    try {
      stdin.write(JSON.stringify(command) + "\n");
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return Promise.resolve({ success: true });
  }

  waitForSettled(): Promise<void> {
    if (this.exitCodeValue !== null) {
      return Promise.reject(
        new Error(`session died before agent_settled (exit ${this.exitCodeValue})`),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.settleWaiter = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {
      // already closed / never opened
    }
    await this.exit;
  }

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
        }, 1_000);
        void this.exit.then(() => clearTimeout(timer));
      }),
    ]);
  }

  // ── line dispatch ─────────────────────────────────────────────────────────

  private handleLine(line: string, final: boolean): void {
    this.onLine(line, final);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const evt = parsed as Record<string, unknown>;
    if (evt.type === "agent_settled") {
      const w = this.settleWaiter;
      this.settleWaiter = null;
      w?.resolve();
    }
  }

}
