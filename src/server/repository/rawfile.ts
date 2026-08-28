import { openSync, writeSync, closeSync } from "node:fs";
import { readFileSync } from "node:fs";

/**
 * The raw record file: every raw pi JSONL line appended verbatim,
 * by the tracer, *before* parsing. The DB is the queryable mirror; this file is
 * the record of truth. Opened once and written synchronously so ordering is
 * guaranteed and the read loop never awaits an async append.
 */
export class RawOutputFile {
  private fd: number;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.fd = openSync(path, "a");
  }

  /**
   * Append one raw line verbatim. Callers pass newline-terminated lines; the
   * FINAL line of a stream may be unterminated and must be appended
   * byte-identically (`final: true` — no invented trailing newline).
   */
  append(text: string, final = false): void {
    writeSync(this.fd, text + (final ? "" : "\n"));
  }

  close(): void {
    if (this.fd >= 0) {
      closeSync(this.fd);
      this.fd = -1;
    }
  }
}

/** Tail the last `n` lines of a raw file (for GET /runs/:id/raw). */
export function tailRawFile(path: string, n: number): { raw: string; line_count: number; truncated: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { raw: "", line_count: 0, truncated: false };
  }
  const lines = text === "" ? [] : text.split("\n");
  // the trailing "" from a final newline is not a line
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(-Math.max(1, n));
  return { raw: kept.join("\n") + (kept.length > 0 ? "\n" : ""), line_count: lines.length, truncated: kept.length < lines.length };
}

/**
 * Read a raw file from the START, capped at `maxLines` (the trajectory parser
 * needs the whole conversation, in order — unlike tailRawFile, which drops the
 * head). `truncated` is set when the file exceeds the cap and later lines were
 * dropped. Returns the kept lines newline-joined plus the FULL line count.
 */
export function readRawFileCapped(
  path: string,
  maxLines: number,
): { text: string; line_count: number; truncated: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { text: "", line_count: 0, truncated: false };
  }
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const kept = lines.slice(0, Math.max(1, maxLines));
  return {
    text: kept.join("\n") + (kept.length > 0 ? "\n" : ""),
    line_count: lines.length,
    truncated: kept.length < lines.length,
  };
}
