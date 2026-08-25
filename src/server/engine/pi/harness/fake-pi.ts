/**
 * FakePi — the scripted pi stand-in.
 *
 * Replays a fixture JSONL file to stdout, one line per write, honoring stdout
 * backpressure (pi awaits stdout backpressure before processing further
 * commands), then exits. No pi binary, no tokens — deterministic and CI-safe.
 *
 * Usage: bun fake-pi.ts <fixture.jsonl>
 *
 * Env:
 *   FAKE_PI_DELAY_MS     pause between lines (default 0)
 *   FAKE_PI_EXIT_CODE    process exit code after the last line (default 0)
 *   FAKE_PI_STDERR       a diagnostic line to write to stderr (optional)
 */
import { readFileSync } from "node:fs";

const fixturePath = process.argv[2];
if (!fixturePath) {
  process.stderr.write("fake-pi: missing fixture path argument\n");
  process.exit(2);
}

const delayMs = Number(process.env.FAKE_PI_DELAY_MS ?? "0") || 0;
const exitCode = Number(process.env.FAKE_PI_EXIT_CODE ?? "0") || 0;
const stderrLine = process.env.FAKE_PI_STDERR ?? "";

if (stderrLine) {
  process.stderr.write(stderrLine + "\n");
}

const lines = readFileSync(fixturePath, "utf8").split("\n");
// the trailing empty element produced by the final newline is not a record
if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

let i = 0;
function pump(): void {
  if (i >= lines.length) {
    process.exit(exitCode);
  }
  const line = lines[i];
  i += 1;
  process.stdout.write(line + "\n", () => {
    if (delayMs > 0) setTimeout(pump, delayMs);
    else pump();
  });
}
pump();
