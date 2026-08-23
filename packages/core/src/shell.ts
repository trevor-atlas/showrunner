import { spawnSync } from "node:child_process";
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
 */
export function createShell(
  cwd: string,
  opts: CreateShellOptions = {},
): (cmd: string) => Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxBuffer = opts.maxBuffer ?? 4 * 1024 * 1024;
  return (cmd: string): Promise<ShellResult> => {
    const res = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer });
    return Promise.resolve({ code: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" });
  };
}

/** One-shot `createShell`: run a command in a directory and get the result. */
export async function runCommand(cwd: string, cmd: string, opts: CreateShellOptions = {}): Promise<ShellResult> {
  return createShell(cwd, opts)(cmd);
}
