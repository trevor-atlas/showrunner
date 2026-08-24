/**
 * @showrunner/daemon/src/pi — the real pi session driver (T02, spec §8).
 *
 * Spawns `pi --mode rpc --session-id <id> --approve` behind the SessionDriver
 * seam: RPC command writer (id-matched responses, §8.4), LF-only stdout reader
 * (§7.1), bounded stderr capture (§8.3), and lifecycle (close stdin to reap,
 * SIGTERM → SIGKILL after 1s). The scripted FakePi stand-in (T01b) implements
 * the same interface so the run loop is byte-compatible downstream.
 */

export { FakeSessionDriver } from "./fake-session-driver.ts";
export type { FakeSessionDriverOptions } from "./fake-session-driver.ts";
export {
  DEFAULT_RPC_TIMEOUT_MS,
  FIRST_PROMPT_ACK_TIMEOUT_MS,
  PiSession,
  SIGKILL_AFTER_MS,
  resolvePiBinary,
} from "./pi-session.ts";
export type { PiSessionOptions } from "./pi-session.ts";
export {
  DEFAULT_STDERR_CAP,
  SESSION_ID_RE,
  findPiBinary,
  sessionDriverKind,
} from "./session-driver.ts";
export type { SessionDriver, SessionDriverKind } from "./session-driver.ts";
export type { RpcCommand, RpcResponse } from "./rpc-types.ts";
export { classifyLine, isSettledLine, SETTLED_KIND } from "./raw-lines.ts";
export type { ClassifiedLine, RawLineKind } from "./raw-lines.ts";
