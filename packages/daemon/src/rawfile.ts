import { openSync, writeSync, closeSync } from "node:fs";
import { readFileSync } from "node:fs";

/**
 * The raw record file (spec §10): every raw pi JSONL line appended verbatim,
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

  /** Append one raw line verbatim (the caller adds the trailing newline). */
  append(text: string): void {
    writeSync(this.fd, text + "\n");
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
