import { test, expect, afterAll } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirFor } from "../../src/core/index.ts";
import { fixturePath } from "../core/fixtures.ts";

/**
 * End-to-end: the real CLI against a real (detached) daemon over HTTP (the
 * daemon's merged web server on one TCP port, pidfile-discovered), with a
 * scratch data dir. This is the deliverable's money test: a fake session's
 * life is fully visible as folded, queryable events in the CLI.
 */

const CLI = fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url));
const DEMO_BLUEPRINT = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon", "fixtures", "demo-blueprint.ts");
const dataDir = mkdtempSync(join(tmpdir(), "showrunner-e2e-"));
// F3: blueprint runs drive in this scratch cwd — context_handoff/ must never
// land in the repo root (the test runner's working directory)
const blueprintCwd = mkdtempSync(join(tmpdir(), "showrunner-e2e-cwd-"));

// Phase 2: the daemon serves HTTP on ONE port (default 44100, SHOWRUNNER_PORT
// override). Pin a free port so the suite never collides with a dev daemon on
// the default.
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}
const port = await freePort();
const env = {
  ...process.env,
  SHOWRUNNER_DATA_DIR: dataDir,
  SHOWRUNNER_FAKE: "1",
  SHOWRUNNER_PORT: String(port),
};
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// F3 tolerance: a parallel IC (packages/starter-kit, T12) may leave
// context_handoff residue in the repo root while this suite runs
const rootHadContextDir = existsSync(join(REPO_ROOT, "context_handoff"));

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
  // Hermetic daemon teardown (T13 #15): the CLI auto-spawned a detached
  // daemon for this suite's data dir — it must NEVER outlive the suite, even
  // when a test failed mid-run or the graceful verb misbehaved.
  // 1. the graceful CLI verb (removes pidfile, stops children)
  try {
    spawnSync(process.execPath, [CLI, "stop"], { encoding: "utf8", timeout: 15_000, env });
  } catch {
    // best-effort
  }
  // 2. hermetic fallback: SIGTERM the pidfile's pid directly — a detached
  // daemon is our own child; if the verb above did not take it down, the
  // pidfile still names it and the signal still stops it
  try {
    const pidFile = join(dataDir, "daemon.pid");
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8").split("\n")[0]?.trim());
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
  // 3. wait for the pidfile to disappear (bounded) before deleting the dirs
  const pidFile = join(dataDir, "daemon.pid");
  const deadline = Date.now() + 5_000;
  while (existsSync(pidFile) && Date.now() < deadline) {
    // busy-wait — afterAll must stay synchronous
  }
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(blueprintCwd, { recursive: true, force: true });
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

test("a blueprint run shows the full §5 loop in watch: correction, envelope, gates, phases", () => {
  const submitted = cli(["run", DEMO_BLUEPRINT, "--cwd", blueprintCwd, "--delay", "2"]);
  expect(submitted.status).toBe(0);
  const runId = submitted.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(runId).toBeDefined();

  const out = cli(["watch", runId!, "--interval", "50"], 30_000);
  expect(out.status).toBe(0);
  const lines = out.stdout;
  // the demo plan phase fails its gate once, is corrected, then passes
  expect(lines).toContain("[run] submitted");
  expect(lines).toContain("[phase] start plan");
  expect(lines).toContain("[gate] qualityGate fail: quality 4 is below the required 7");
  expect(lines).toContain("[correction] plan visit=1 reason=gate_violations");
  expect(lines).toContain("[envelope] plan visit=1 attempt=1 valid=true");
  expect(lines).toContain("[phase] end plan status=success visits=1 corrections=1");
  expect(lines).toContain("[phase] start build");
  expect(lines).toContain("[phase] end build status=success");
  expect(lines).toContain("[run] running → success");

  // run detail shows both phases with visits/corrections
  const show = cli(["show", runId!]);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain("status: success");
  expect(show.stdout).toMatch(/plan\s+success\s+visits=1 corrections=1/);
  expect(show.stdout).toMatch(/build\s+success\s+visits=1 corrections=0/);

  // the runs list shows the phase counts
  const list = cli(["runs"]);
  expect(list.stdout).toContain("2/2");

  // F3: the run workspace lives under the RUN dir ({data_dir}/runs/<run_id>/<phase>/outputs)
  // — never the scratch cwd or the repo root (§9.1)
  const runDir = runDirFor(dataDir, runId!);
  expect(existsSync(join(runDir, "plan", "outputs", "envelope.json"))).toBe(true);
  expect(existsSync(join(blueprintCwd, "context_handoff"))).toBe(false);
  expect(existsSync(join(REPO_ROOT, "context_handoff"))).toBe(rootHadContextDir);
});

test("FINDING-1: --prompt rides the §13.3 args into the snapshot (the composed-prompt input)", async () => {
  const submitted = cli(["run", DEMO_BLUEPRINT, "--cwd", blueprintCwd, "--delay", "2", "--prompt", "map the auth flow"]);
  expect(submitted.status).toBe(0);
  const runId = submitted.stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
  expect(runId).toBeDefined();

  // §13.3: the snapshot records the submit-time args verbatim — the daemon
  // composes the --prompt value into the run's first prompt (§8.2, [User request])
  const snap = JSON.parse(readFileSync(join(runDirFor(dataDir, runId!), "blueprint.json"), "utf8")) as {
    args: string[] | null;
  };
  expect(snap.args).toEqual(["--prompt", "map the auth flow"]);

  // the prompt must not break the loop — the run still reaches success
  let sawSuccess = false;
  for (let i = 0; i < 200 && !sawSuccess; i++) {
    const poll = cli(["runs"]);
    if (poll.stdout.includes("success")) {
      sawSuccess = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(sawSuccess).toBe(true);
});

test("stop terminates the daemon and removes the pidfile", async () => {
  const pidFile = join(dataDir, "daemon.pid");
  expect(existsSync(pidFile)).toBe(true);
  const out = cli(["stop"]);
  expect(out.status).toBe(0);
  expect(out.stdout).toContain("daemon stopped");
  // give the daemon a moment to reap
  let gone = false;
  for (let i = 0; i < 50; i++) {
    if (!existsSync(pidFile)) {
      gone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(gone).toBe(true);
});
