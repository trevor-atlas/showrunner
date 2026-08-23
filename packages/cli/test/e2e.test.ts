import { test, expect, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirFor } from "@showrunner/core";
import { fixturePath } from "@showrunner/core/test/fixtures";

/**
 * End-to-end: the real CLI against a real (detached) daemon over the unix
 * socket, with a scratch data dir. This is the deliverable's money test: a
 * fake session's life is fully visible as folded, queryable events in the CLI.
 */

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "showrunner-e2e-"));
const env = { ...process.env, SHOWRUNNER_DATA_DIR: dataDir };

function cli(args: string[], timeoutMs = 30_000): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      env,
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number; message: string };
    return { stdout: (e.stdout ?? "").toString(), status: e.status ?? -1 };
  }
}

afterAll(() => {
  // stop the daemon the CLI auto-spawned, then remove the scratch dir
  try {
    spawnSync(process.execPath, [CLI, "stop"], { encoding: "utf8", timeout: 15_000, env });
  } catch {
    // best-effort
  }
  rmSync(dataDir, { recursive: true, force: true });
});

test("runs lists nothing, then a submitted happy run is fully visible", async () => {
  const empty = cli(["runs"]);
  expect(empty.status).toBe(0);
  expect(empty.stdout).toContain("no runs yet");

  const submitted = cli(["run", "happy", "--delay", "5"]);
  expect(submitted.status).toBe(0);
  const runId = submitted.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(runId).toBeDefined();

  const list = cli(["runs"]);
  expect(list.status).toBe(0);
  expect(list.stdout).toContain(runId!);
  // the replay takes ~26 lines x 5ms - poll until the run is terminal
  let sawSuccess = false;
  for (let i = 0; i < 100 && !sawSuccess; i++) {
    const poll = cli(["runs"]);
    if (poll.stdout.includes("success")) {
      sawSuccess = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(sawSuccess).toBe(true);

  // the raw record (§10) is byte-identical to the fixture
  const rawPath = join(runDirFor(dataDir, runId!), "raw_output.jsonl");
  expect(readFileSync(rawPath, "utf8")).toBe(readFileSync(fixturePath("happy"), "utf8"));
});

test("watch streams the folded lifecycle and exits when terminal", () => {
  const submitted = cli(["run", "gate-fail", "--delay", "5"]);
  const runId = submitted.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(runId).toBeDefined();

  const out = cli(["watch", runId!, "--interval", "50"], 30_000);
  expect(out.status).toBe(0);
  const lines = out.stdout;
  expect(lines).toContain("[run] submitted");
  expect(lines).toContain("[run] submitted → running");
  expect(lines).toContain("[phase] start build");
  expect(lines).toContain("[agent] start builder");
  expect(lines).toContain("[tool] bash:");
  expect(lines).toContain("[spend]");
  expect(lines).toContain("[agent] end builder ok=true exit=0");
  expect(lines).toContain("[phase] end build status=success");
  expect(lines).toContain("[run] running → success");
});

test("a crash run surfaces as failed with a truncated tool call and needs_review", () => {
  const submitted = cli(["run", "crash", "--delay", "5"]);
  const runId = submitted.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(runId).toBeDefined();

  const out = cli(["watch", runId!, "--interval", "50"], 30_000);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("[tool] bash: git status (error, truncated");
  expect(out.stdout).toContain("[agent] end builder ok=false exit=1");
  expect(out.stdout).toContain("[phase] end build status=failed");
  expect(out.stdout).toContain("running → failed");

  const list = cli(["runs"]);
  expect(list.stdout).toContain("failed");
  expect(list.stdout).toContain("(needs review)");
});

test("stop terminates the daemon and removes the socket", async () => {
  const socket = join(dataDir, "daemon.sock");
  expect(existsSync(socket)).toBe(true);
  const out = cli(["stop"]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("daemon stopped");
  // give the daemon a moment to reap
  let gone = false;
  for (let i = 0; i < 50; i++) {
    if (!existsSync(socket)) {
      gone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(gone).toBe(true);
});
