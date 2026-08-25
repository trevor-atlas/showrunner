import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A scratch data dir for one test; cleaned up on return. */
export function tmpDataDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-${label}-`));
}

/** Grab a free TCP port (bind :0, read it back, release). Spawned daemons in
 * the suite bind a FIXED port — the daemon has no discovery file anymore, so
 * the test picks the port up front, hands it to the child via SHOWRUNNER_PORT,
 * and builds the base URL from the same number. Parallel-safe: each test gets
 * its own port. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export interface RawEvent {
  type: string;
  [k: string]: unknown;
}

export function rawLine(evt: RawEvent): string {
  return JSON.stringify(evt);
}

// ── raw pi event builders (verified shapes) ───────────────────────

export function toolStart(callId: string, toolName: string, args: unknown): string {
  return rawLine({ type: "tool_execution_start", toolCallId: callId, toolName, args });
}

export function toolUpdate(callId: string, toolName: string, text: string): string {
  return rawLine({
    type: "tool_execution_update",
    toolCallId: callId,
    toolName,
    partialResult: { content: [{ type: "text", text }] },
  });
}

export function toolEnd(callId: string, toolName: string, text: string, isError = false): string {
  return rawLine({
    type: "tool_execution_end",
    toolCallId: callId,
    toolName,
    result: { content: [{ type: "text", text }] },
    isError,
  });
}

export function messageUpdate(input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number; cost?: number } = {}): string {
  const usage: Record<string, unknown> = { input, output, totalTokens: input + output };
  if (extra.cacheRead !== undefined) usage.cacheRead = extra.cacheRead;
  if (extra.cacheWrite !== undefined) usage.cacheWrite = extra.cacheWrite;
  if (extra.cost !== undefined) usage.cost = { total: extra.cost };
  return rawLine({ type: "message_update", message: { id: "m", role: "assistant" }, usage });
}

export function messageEnd(input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number; cost?: number } = {}): string {
  const usage: Record<string, unknown> = { input, output, totalTokens: input + output };
  if (extra.cacheRead !== undefined) usage.cacheRead = extra.cacheRead;
  if (extra.cacheWrite !== undefined) usage.cacheWrite = extra.cacheWrite;
  if (extra.cost !== undefined) usage.cost = { total: extra.cost };
  return rawLine({ type: "message_end", message: { id: "m", role: "assistant", usage } });
}
