/**
 * LF-only framing (spec §7.1): "Clients must split records on `\n` only" -
 * Node's readline is explicitly non-compliant, so the tracer splits on `\n`
 * itself. `\r` is not treated as a record terminator and is preserved.
 */
export class LineSplitter {
  private buf = "";

  /** Feed a chunk; returns complete lines (each without its trailing `\n`). */
  push(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    return lines;
  }

  /** The remaining partial line at stream end (may be empty). */
  flush(): string[] {
    if (this.buf === "") return [];
    const last = this.buf;
    this.buf = "";
    return [last];
  }
}
