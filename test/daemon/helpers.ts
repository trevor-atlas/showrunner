import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A scratch data dir for one test; cleaned up on return. */
export function tmpDataDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-${label}-`));
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

// ── raw pi event builders (verified shapes, §7.1/§7.2) ───────────────────────

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
