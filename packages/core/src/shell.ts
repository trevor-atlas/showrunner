import { spawn } from "node:child_process";
import type { ShellResult } from "./run.ts";

export interface CreateShellOptions {
  /** subprocess timeout in ms (default 120s — the harness rule: abandon a
   * command that blocks longer than 120s rather than hang the run) */
  timeoutMs?: number;
  /** max captured stdout/stderr in bytes (default 4 MiB) */
  maxBuffer?: number;
}

/**
 * The standard subprocess escape hatch (spec §3.7) — a `shell(cmd)` that
 * gates and hooks can use when the runtime does not provide `ctx.shell`.
 * Mirrors the daemon's hook shell exactly: `/bin/sh -c`, bounded by a
 * timeout, returns the full `{ code, stdout, stderr }` result.
 *
 * The execution is TRULY async (child_process.spawn, promisified) — a shell
 * command running inside a gate must never block the daemon's event loop
 * (§19 "Backpressure": the tracer read loop, the live feed, and every HTTP
 * response keep flowing while a gate command runs). A command that exceeds
 * the timeout cap is SIGTERM'd (SIGKILL after 1s) and reports `code: -1`
 * — a crashing/timing-out gate is a failed result for the gate to turn into
 * a violation (§5.5), never a hang. stdout/stderr are captured up to
 * `maxBuffer` each and still drained past the cap (the child never stalls
 * on a full pipe; spawnSync's overflow-kill is deliberately not mirrored).
 */
export function createShell(
  cwd: string,
  opts: CreateShellOptions = {},
): (cmd: string) => Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = opts.maxBuffer ?? 4 * 1024 * 1024;
  return (cmd: string): Promise<ShellResult> => runShellCommand(cmd, { cwd, timeoutMs, maxBuffer });
}

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
}

function runShellCommand(cmd: string, opts: RunOptions): Promise<ShellResult> {
  return new Promise<ShellResult>((resolve) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      // a timed-out command reports the cap, not a late exit code
      resolve({ code: timedOut ? -1 : (code ?? -1), stdout, stderr });
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= opts.maxBuffer) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= opts.maxBuffer) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: Error) => {
      // spawn failure (practically impossible for /bin/sh) — report like a
      // failed command, never crash the caller
      void err;
      finish(null);
    });
    child.on("close", (code: number | null) => finish(code));

    const timer = setTimeout(() => {
      // the cap: SIGTERM, then SIGKILL after 1s (the §8.3 fail-run semantics)
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 1_000);
      killTimer.unref?.();
    }, opts.timeoutMs);
    timer.unref?.();
  });
}

/** One-shot `createShell`: run a command in a directory and get the result. */
export async function runCommand(cwd: string, cmd: string, opts: CreateShellOptions = {}): Promise<ShellResult> {
  return createShell(cwd, opts)(cmd);
}
