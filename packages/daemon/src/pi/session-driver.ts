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
 * Which session driver the run loop uses (§17): `SHOWRUNNER_SMOKE=1` selects
 * the real pi binary (the env-gated smoke path); the default build stays
 * FakePi-only so the full test suite passes with no pi binary installed.
 */
export type SessionDriverKind = "real" | "fake";

export function sessionDriverKind(
  env: Record<string, string | undefined> = process.env,
): SessionDriverKind {
  return env.SHOWRUNNER_SMOKE === "1" ? "real" : "fake";
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
  /** resolve when the NEXT agent_settled arrives (one-shot; rejects on stream death) */
  waitForSettled(): Promise<void>;
  /** stdin EOF → the process reaps itself (exit 0); resolves when gone (§8.3) */
  close(): Promise<void>;
  /** fail-run semantics (pi's RpcClient.stop()): SIGTERM, SIGKILL after 1s */
  stop(): Promise<void>;
}
