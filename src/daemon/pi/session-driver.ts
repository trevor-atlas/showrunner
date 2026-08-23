import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

/** The default cap for captured stderr per session (§8.3). */
export const DEFAULT_STDERR_CAP = 256 * 1024;

/**
 * The pi session-id character set (verified §8.1): alphanumeric first and
 * last, `[A-Za-z0-9._-]` in between — `--session-id` is the create-or-continue
 * flag and rejects ids outside this set. `sessionIdFor` (driver.ts) derives
 * ids like `<run8>_<phase>_v<visit>`; this regex guards the real spawn.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/**
 * Which session driver the run loop uses (§17). Real pi is the PRODUCT default:
 * `SHOWRUNNER_FAKE=1` forces scripted FakePi sessions (tests, demos, CI);
 * `SHOWRUNNER_SMOKE=1` forces the real pi binary (the capstone smoke); with
 * neither set, the daemon auto-detects — real pi when a binary is found, the
 * scripted sessions otherwise (a fresh checkout with no pi installed still
 * runs blueprints). Explicit `SHOWRUNNER_FAKE=1` wins over everything.
 */
export type SessionDriverKind = "real" | "fake";

/**
 * Resolve the pi binary for driver selection: `SHOWRUNNER_PI_BINARY`,
 * `PI_BINARY`, else `"pi"` on PATH. Returns the resolved path, or null when no
 * binary is available. A slash-bearing override is trusted if the file exists;
 * a bare name is looked up on PATH (both cheap; this runs per run, not per
 * event).
 */
export function findPiBinary(env: Record<string, string | undefined> = process.env): string | null {
  const candidate = env.SHOWRUNNER_PI_BINARY ?? env.PI_BINARY ?? "pi";
  if (!candidate) return null;
  if (candidate.includes("/")) return existsSync(candidate) ? candidate : null;
  try {
    const out = execFileSync("which", [candidate], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const trimmed = out.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

export function sessionDriverKind(
  env: Record<string, string | undefined> = process.env,
  probe: (env: Record<string, string | undefined>) => string | null = findPiBinary,
): SessionDriverKind {
  if (env.SHOWRUNNER_FAKE === "1") return "fake";
  if (env.SHOWRUNNER_SMOKE === "1") return "real";
  return probe(env) === null ? "fake" : "real";
}

/**
 * The session driver seam (spec §8) — the interface the run loop drives. Two
 * implementations sit behind it: `PiSession` (the real pi binary, selected by
 * SHOWRUNNER_SMOKE=1) and `FakeSessionDriver` (the scripted FakePi stand-in the
 * tests use, T01b). The loop never touches the child process directly; the
 * driver owns spawn, RPC command writing, stdout framing, stderr capture, and
 * process lifecycle.
 */
export interface SessionDriver {
  /** child pid (mirrored in processes/agent_sessions, §4) */
  readonly pid: number;
  /** exit code once the process is gone; null while alive or signal-killed */
  readonly exitCode: number | null;
  /** resolves with the exit code when the process is gone (null = signal) */
  readonly exit: Promise<number | null>;
  /** captured stderr for crash debugging (§8.3) */
  readonly stderr: string;
  /**
   * Send one RPC command; resolves with the id-matched response (§8.4).
   * Rejects on stream death, or when no response arrives within `timeoutMs`
   * (default DEFAULT_RPC_TIMEOUT_MS). A rejected prompt ack (success:false)
   * still resolves with the response — the caller checks `.success`.
   */
  send(command: RpcCommand, timeoutMs?: number): Promise<RpcResponse>;
  /** resolve when the NEXT agent_settled arrives (latch: a settle arriving
   * before the waiter registers is remembered, not dropped — G1); rejects on
   * stream death */
  waitForSettled(): Promise<void>;
  /** stdin EOF → the process reaps itself (exit 0); resolves when gone (§8.3) */
  close(): Promise<void>;
  /** fail-run semantics (pi's RpcClient.stop()): SIGTERM, SIGKILL after 1s */
  stop(): Promise<void>;
}
