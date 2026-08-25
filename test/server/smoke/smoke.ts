/**
 * SHOWRUNNER_SMOKE=1 capstone smoke (T13): proves the WIRING with the
 * REAL pi binary on a REAL repo, end to end.
 *
 *   SHOWRUNNER_SMOKE=1 SHOWRUNNER_PI_BINARY=$(which pi) bun packages/daemon/test/smoke/smoke.ts
 *
 * Scenarios (each env-gated by SHOWRUNNER_SMOKE=1; without it this script
 * exits 0 having done nothing — safe under any test runner):
 *
 *  1. CAPSTONE — a real git repo with a deliberately broken test; the starter
 *     kit's plan→build chain runs REAL pi: an arranged failing gate forces a
 *     real correction on the SAME --session-id, testsPass/lintClean run real
 *     commands, a live steer lands during build, a gate fails at a pause and
 *     is overridden via the CLI, ship pauses for approval and is approved.
 *     Terminal success + spend recorded.
 *  2. CRASH-WITH-LIVE-CHILD — the pi child is SIGKILLed mid-flight: the run
 *     fails with needs_review per the convention, no orphans remain; the
 *     fail verb then exercises driver.stop() against a live real-pi child.
 *  3. BACKFILL (real pi) — the daemon is SIGKILLed mid-session: on restart the
 *     missed session tail is restored from pi's own session tree and a second
 *     sweep is idempotent.
 *  4. POLL TOOL RUNTIME LOAD — the starter kit's poll extension is loaded via
 *     `pi -e` and actually CALLED by a real agent (toolName "poll" in the
 *     stream) — the format-compliant-until-now extension is proven at runtime.
 *
 * The smoke costs a little real spend; that is the ticket's point. Assertions
 * are gathered per scenario and the process exits 1 if any scenario fails.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, openSync, closeSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirFor } from "../../../src/core/index.ts";

import { freePort } from "../helpers.ts";
import { serverEntryPath } from "../../../src/server/lifecycle.ts";
import { ServerClient } from "../../../src/server/transport/client.ts";
import type { RunDetail } from "../../../src/server/transport/client.ts";
import { backfillMissedEvents } from "../../../src/server/engine/backfill.ts";
import { openDb } from "../../../src/server/repository/db.ts";

const SKIP = `skipped: set SHOWRUNNER_SMOKE=1 to run the real-pi smoke (it costs a little real spend)`;

if (process.env.SHOWRUNNER_SMOKE !== "1") {
  console.log(SKIP);
  process.exit(0);
}

// ── pi binary + CLI ──────────────────────────────────────────────────────────

function resolvePi(): string {
  const fromEnv = process.env.SHOWRUNNER_PI_BINARY ?? process.env.PI_BINARY;
  if (fromEnv) return fromEnv;
  const which = spawnSync("which", ["pi"], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim() !== "") return which.stdout.trim();
  return "pi";
}

const piBinary = resolvePi();
console.log(`smoke: pi binary = ${piBinary}`);
const version = spawnSync(piBinary, ["--version"], { encoding: "utf8" });
if (version.status !== 0) {
  console.error(`smoke: cannot run pi at ${piBinary}: ${version.stderr}`);
  process.exit(1);
}
console.log(`smoke: pi version  = ${version.stdout.trim()}`);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const CLI = join(REPO_ROOT, "src", "cli", "index.ts");
const CAPSTONE_BP = join(HERE, "capstone-blueprint.ts");
const HAPPY_BP = join(HERE, "..", "fixtures", "happy-blueprint.ts");
const POLL_TOOL = join(REPO_ROOT, "src", "starter-kit", "tools", "poll.ts");

const keep = process.env.SHOWRUNNER_SMOKE_KEEP === "1";
// the smoke's ServerClient would otherwise pool keep-alive sockets; a CLI
// subprocess holding the daemon's attention >5s (its 10s pollStatus deadline)
// lets the daemon's keepAliveTimeout close the idle socket, and a stale reuse
// then EPIPEs. Fresh connection per request — the smoke is not hot-path code.
(http.globalAgent as unknown as { keepAlive: boolean }).keepAlive = false;
const scratch: string[] = [];
function tmp(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `showrunner-smoke-${label}-`));
  scratch.push(dir);
  return dir;
}
function cleanup(): void {
  if (keep) return;
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}
process.on("exit", cleanup);

// ── helpers ──────────────────────────────────────────────────────────────────

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`smoke: timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** The daemon binds a FIXED port (SHOWRUNNER_PORT). The smoke has no discovery
 * file anymore, so it picks one port up front and both the spawned daemon and
 * the real CLI (runCli) agree on it. Scenarios run sequentially — each boots
 * and tears down its daemon before the next — so one port for the run is fine. */
const SMOKE_PORT = await freePort();
const SMOKE_BASE_URL = `http://127.0.0.1:${SMOKE_PORT}`;

async function waitForHealth(_dataDir: string): Promise<void> {
  await waitFor(async () => {
    try {
      await new ServerClient({ baseUrl: SMOKE_BASE_URL }).health();
      return true;
    } catch {
      return false;
    }
  }, 20_000, `daemon up at ${SMOKE_BASE_URL}`);
}

async function waitForStatus(client: ServerClient, runId: string, status: string, timeoutMs = 120_000): Promise<void> {
  await waitFor(async () => {
    const d = await client.getRun(runId);
    return d.run.status === status;
  }, timeoutMs, `run ${runId} → ${status}`);
}

/** Wait until the run has a live agent session; return its pid. */
async function waitForLiveChild(client: ServerClient, runId: string, timeoutMs = 120_000): Promise<number> {
  let pid = 0;
  await waitFor(async () => {
    const d = await client.getRun(runId);
    if (d.sessions.length > 0 && d.sessions[0]!.pid > 0) {
      pid = d.sessions[0]!.pid;
      return true;
    }
    return false;
  }, timeoutMs, "live agent child");
  return pid;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCli(args: string[], dataDir: string): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, SHOWRUNNER_DATA_DIR: dataDir, SHOWRUNNER_PORT: String(SMOKE_PORT) },
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer; status?: number; message: string };
    return { stdout: (e.stdout ?? "").toString(), status: e.status ?? -1 };
  }
}

function bootDaemon(dataDir: string, extra: Record<string, string> = {}): { child: ChildProcess; baseUrl: string; logPath: string } {
  // real pi writes its session tree wherever PI_CODING_AGENT_SESSION_DIR points
  // — always redirect it into the scratch data dir so a smoke never pollutes
  // the user's ~/.pi/agent/sessions (the capstone/backfill probes verify the
  // layout directly).
  const sessionRoot = extra.PI_CODING_AGENT_SESSION_DIR ?? join(dataDir, "pi-sessions");
  mkdirSync(sessionRoot, { recursive: true });
  // daemon stdout/stderr go to a log file so a mid-smoke crash is diagnosable
  const logPath = join(dataDir, "daemon.log");
  const logFd = openSync(logPath, "a");
  // FIXED port (SHOWRUNNER_PORT=SMOKE_PORT): the daemon has no discovery file,
  // so the smoke chose the port up front and the CLI reaches it on the same port
  const child = spawn(process.execPath, [serverEntryPath(), "--data-dir", dataDir], {
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      SHOWRUNNER_SMOKE: "1",
      SHOWRUNNER_PORT: String(SMOKE_PORT),
      SHOWRUNNER_PI_BINARY: piBinary,
      PI_CODING_AGENT_SESSION_DIR: sessionRoot,
      ...extra,
    },
  });
  child.unref();
  closeSync(logFd);
  return {
    child,
    baseUrl: SMOKE_BASE_URL,
    logPath,
  };
}

function pgrepMatches(pattern: string): string[] {
  const res = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  if (res.status !== 0) return [];
  return res.stdout.trim().split("\n").filter((l) => l !== "");
}

// ── the scratch repo: a tiny REAL git repo with a genuinely failing test ─────

function makeRepo(dir: string): void {
  mkdirSync(join(dir, "src", "types"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src", "add.ts"), "export function add(a: number, b: number): number {\n  return a - b; // deliberate smoke bug: subtracts\n}\n");
  writeFileSync(
    join(dir, "test", "add.test.ts"),
    ['import { test, expect } from "bun:test";', 'import { add } from "../src/add.ts";', 'test("add adds", () => {', "  expect(add(1, 2)).toBe(3);", "});", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "src", "types", "bun-test.d.ts"),
    ['declare module "bun:test" {', "  export function test(name: string, fn: () => void | Promise<void>): void;", "  export function expect<T>(actual: T): { toBe(expected: unknown): void };", "}", ""].join("\n"),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "bundler", strict: true, noEmit: true, types: [], allowImportingTsExtensions: true, skipLibCheck: true }, include: ["src", "test"] },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "README.md"),
    ["# smoke repo", "", "A tiny repo for the Showrunner capstone smoke. src/add.ts is broken", "(subtracts instead of adding); test/add.test.ts fails until a builder fixes it.", ""].join("\n"),
  );
  // bunx tsc resolves typescript from the monorepo root's node_modules
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  const git = (args: string[]): void => {
    spawnSync("git", args, { cwd: dir, stdio: "ignore", timeout: 30_000 });
  };
  git(["init", "-q"]);
  git(["-c", "user.email=smoke@showrunner.local", "-c", "user.name=smoke", "add", "-A"]);
  git(["-c", "user.email=smoke@showrunner.local", "-c", "user.name=smoke", "commit", "-q", "-m", "init"]);
}

// the harness itself must see a genuinely RED suite before the fix
function assertRepoBroken(repo: string): void {
  const res = spawnSync("bun", ["test"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  if (res.status === 0) {
    throw new Error(`smoke: the scratch repo's suite is unexpectedly GREEN before any fix (${repo})`);
  }
}

// ── scenario 1: the capstone (correction + real-command gates + steer + override + approve) ─

const failures: string[] = [];
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

async function scenarioCapstone(): Promise<void> {
  console.log("\n=== scenario 1: capstone — plan → build → verify → ship on a real repo (real pi) ===");
  const dataDir = tmp("capstone-data");
  const repo = tmp("capstone-repo");
  makeRepo(repo);
  assertRepoBroken(repo);
  console.log(`smoke: repo     = ${repo} (test suite is red — the builder must fix it)`);

  const daemon = bootDaemon(dataDir);
  await waitForHealth(dataDir);
  console.log(`smoke: daemon up (pid ${daemon.child.pid ?? "?"})`);

  const client = new ServerClient({ baseUrl: daemon.baseUrl });
  const startedAt = Date.now();
  const sub = await client.submitRun({ blueprint: CAPSTONE_BP, cwd: repo });
  const runId = sub.run_id;
  console.log(`smoke: capstone run ${runId} submitted (queue_position ${sub.queue_position})`);

  // LIVE STEER during the build phase: poll until the build session is live
  await waitFor(async () => {
    const d = await client.getRun(runId);
    const build = d.phases.find((p) => p.name === "build");
    return build?.status === "in_progress" && d.sessions.length > 0;
  }, 300_000, "build phase live");
  const steerOut = runCli(["steer", runId, "remember: the fix must make `bun test` green AND keep `bunx tsc --noEmit` clean"], dataDir);
  check("steer via CLI accepted", steerOut.status === 0, steerOut.stdout.split("\n")[0]);
  console.log(`smoke: steered during build: ${steerOut.stdout.split("\n").slice(0, 2).join(" / ")}`);

  // the verify phase exhausts its budget (quality 5 < 8) → pause
  await waitForStatus(client, runId, "paused", 600_000);
  const pause1 = await client.pause(runId);
  check("paused on verify's gate failure", pause1.kind === "budget_exhausted", `kind=${pause1.kind} phase=${pause1.phase}`);

  // OVERRIDE the failed gate via the CLI → the run continues
  const over = runCli(["override", runId, "--gate", "qualityGate", "--reason", "smoke: manual review accepts quality 5"], dataDir);
  check("override via CLI accepted", over.status === 0, over.stdout.split("\n")[0]);

  // the ship phase requires approval → pause → approve
  await waitForStatus(client, runId, "paused", 300_000);
  const pause2 = await client.pause(runId);
  check("paused on ship approval", pause2.kind === "approval", `kind=${pause2.kind} phase=${pause2.phase}`);
  const appr = runCli(["approve", runId, "--by", "smoke"], dataDir);
  check("approve via CLI accepted", appr.status === 0, appr.stdout.split("\n")[0]);

  await waitForStatus(client, runId, "success", 600_000);
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`smoke: capstone run finished in ${elapsedSec}s`);

  const detail = await client.getRun(runId);
  check("terminal success", detail.run.status === "success" && detail.run.needs_review === 0, `status=${detail.run.status} needs_review=${detail.run.needs_review}`);

  const events = (await client.getEvents(runId, { cursor: 0, limit: 500 })).events;
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  console.log("smoke: event counts by type:");
  for (const [t, n] of [...byType.entries()].sort()) console.log(`  ${t.padEnd(14)} ${n}`);

  // the arranged first-fail gate forced a REAL correction on the SAME session
  const corrections = events.filter((e) => e.type === "correction");
  check("correction issued (gate failed → fix loop)", corrections.length >= 1, `${corrections.length} correction(s)`);
  const buildSessions = detail.sessions.filter((s) => detail.phases.find((p) => p.id === s.phase_id)?.name === "build");
  const buildSessionIds = buildSessions.map((s) => s.pi_session_id);
  check("build used ONE session (same --session-id across the correction)", buildSessionIds.length === 1, `sessions=${buildSessionIds.length} ids=${buildSessionIds.join(",")}`);

  // gates ran REAL commands: the build's testsPass/lintClean passed
  const buildGates = await client.getPhaseGates(runId, "build");
  const testsPassRows = buildGates.gates.filter((g) => g.gate === "testsPass");
  const lintRows = buildGates.gates.filter((g) => g.gate === "lintClean");
  check("testsPass ran and passed (real `bun test`)", testsPassRows.length > 0 && testsPassRows.some((g) => g.pass === 1), `${testsPassRows.length} run(s)`);
  check("lintClean ran and passed (real `bunx tsc --noEmit`)", lintRows.length > 0 && lintRows.some((g) => g.pass === 1), `${lintRows.length} run(s)`);
  const verifyGates = await client.getPhaseGates(runId, "verify");
  check("the verify gate carries an override badge", verifyGates.gates.some((g) => g.overridden === 1), `overridden=${verifyGates.gates.filter((g) => g.overridden === 1).length}`);

  // the human actions: steer + override_gate + approve
  const humans = events.filter((e) => e.type === "human_action").map((e) => (e.data as { action: string }).action);
  check("steer audited", humans.includes("steer"), humans.join(","));
  check("override_gate audited", humans.includes("override_gate"), humans.join(","));
  check("approve audited", humans.includes("approve"), humans.join(","));

  // spend recorded (tokens always; dollars when pi reports them)
  const spendEvents = events.filter((e) => e.type === "spend");
  check("spend events recorded", spendEvents.length > 0, `${spendEvents.length} spend events`);
  const spendUsd = spendEvents.reduce((s, e) => s + (((e.data as { usd: number | null }).usd) ?? 0), 0);
  check("spend_usd >= 0", Number.isFinite(spendUsd) && spendUsd >= 0, `spend_usd=$${spendUsd.toFixed(6)} estimated=${events.some((e) => e.type === "spend" && (e.data as { estimated?: boolean }).estimated) ? "yes" : "no"}`);

  // phases all success; the repo is genuinely fixed
  const phaseStatus = Object.fromEntries(detail.phases.map((p) => [p.name, p.status]));
  check("plan success", phaseStatus.plan === "success", JSON.stringify(phaseStatus));
  check("build success", phaseStatus.build === "success", JSON.stringify(phaseStatus));
  check("verify success (after override)", phaseStatus.verify === "success", JSON.stringify(phaseStatus));
  check("ship success (after approval)", phaseStatus.ship === "success", JSON.stringify(phaseStatus));
  const tsc = spawnSync("bunx", ["tsc", "--noEmit"], { cwd: repo, encoding: "utf8", timeout: 60_000 });
  check("repo is genuinely fixed (bun test green)", spawnSync("bun", ["test"], { cwd: repo, encoding: "utf8", timeout: 60_000 }).status === 0);
  check("repo typecheck clean", tsc.status === 0, tsc.stderr.slice(0, 120));

  // raw record + settle lines + no orphans
  const rawPath = join(runDirFor(dataDir, runId), "raw_output.jsonl");
  const rawText = existsSync(rawPath) ? readFileSync(rawPath, "utf8") : "";
  check("raw record written", rawText.split("\n").filter(Boolean).length > 0, `${rawText.split("\n").filter(Boolean).length} lines`);
  check("agent_settled >= 4 phases", rawText.split("agent_settled").length - 1 >= 4, `${rawText.split("agent_settled").length - 1} settles`);

  // no orphan pi children from this run (pgrep the session id prefix)
  const orphanPattern = runId.slice(0, 8);
  await new Promise((r) => setTimeout(r, 500));
  const orphans = pgrepMatches(orphanPattern);
  check("no orphan pi children (pgrep)", orphans.length === 0, orphans.join(","));

  daemon.child.kill("SIGKILL");
  console.log(`smoke: capstone raw record at ${rawPath}${keep ? " (kept)" : ""}`);
}

// ── scenario 2: crash-with-live-child (kill the pi child) + the fail verb's driver.stop() ─

async function scenarioCrash(): Promise<void> {
  console.log("\n=== scenario 2: crash-with-live-child — SIGKILL the pi child mid-flight (real pi) ===");
  const dataDir = tmp("crash-data");
  const repo = tmp("crash-repo");
  makeRepo(repo);

  const daemon = bootDaemon(dataDir);
  await waitForHealth(dataDir);
  const client = new ServerClient({ baseUrl: daemon.baseUrl });

  // 2a: the child dies mid-flight (not the daemon) → crash/needs_review, no orphans
  const sub = await client.submitRun({ blueprint: HAPPY_BP, cwd: repo });
  const runId = sub.run_id;
  const childPid = await waitForLiveChild(client, runId);
  check("real pi child is live", pidAlive(childPid), `pid=${childPid}`);
  console.log(`smoke: SIGKILLing the pi child ${childPid} mid-flight…`);
  process.kill(childPid, "SIGKILL");
  await waitForStatus(client, runId, "failed", 120_000);
  const d1 = await client.getRun(runId);
  check("run failed after child death", d1.run.status === "failed");
  check("needs_review flagged ( mid-tool-crash)", d1.run.needs_review === 1, `needs_review=${d1.run.needs_review}`);
  await waitFor(() => !pidAlive(childPid), 5_000, "child death");
  // the daemon's process bookkeeping reaped it — no orphan pi children
  const db1 = openDb(join(dataDir, "showrunner.db"));
  const leftOver1 = db1.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM processes WHERE pid = ?").get(childPid)?.n ?? 0;
  db1.close();
  check("no processes row left for the dead child", leftOver1 === 0, `rows=${leftOver1}`);
  check("no orphan pi children (pgrep)", pgrepMatches(runId.slice(0, 8)).length === 0, pgrepMatches(runId.slice(0, 8)).join(","));

  // 2b: the fail verb exercises driver.stop() against a LIVE real-pi child
  const sub2 = await client.submitRun({ blueprint: HAPPY_BP, cwd: repo });
  const runId2 = sub2.run_id;
  const childPid2 = await waitForLiveChild(client, runId2);
  check("second real pi child is live", pidAlive(childPid2), `pid=${childPid2}`);
  await client.failRun(runId2, { by: "smoke" });
  await waitForStatus(client, runId2, "failed", 120_000);
  const d2 = await client.getRun(runId2);
  check("fail verb → failed", d2.run.status === "failed");
  check("deliberate fail is NOT needs_review", d2.run.needs_review === 0, `needs_review=${d2.run.needs_review}`);
  await waitFor(() => !pidAlive(childPid2), 8_000, "child stopped via driver.stop()");
  check("driver.stop() killed the live child (SIGTERM → SIGKILL, )", !pidAlive(childPid2), `pid=${childPid2}`);

  daemon.child.kill("SIGKILL");
}

// ── scenario 3: backfill against a REAL pi session ───────────────────

async function scenarioBackfill(): Promise<void> {
  console.log("\n=== scenario 3: backfill — daemon SIGKILLed mid-session, restart restores the missed tail (real pi) ===");
  const dataDir = tmp("backfill-data");
  const sessionRoot = tmp("backfill-sessions");
  const repo = tmp("backfill-repo");
  makeRepo(repo);

  let daemon = bootDaemon(dataDir, { PI_CODING_AGENT_SESSION_DIR: sessionRoot });
  await waitForHealth(dataDir);
  let client = new ServerClient({ baseUrl: daemon.baseUrl });

  const sub = await client.submitRun({ blueprint: HAPPY_BP, cwd: repo });
  const runId = sub.run_id;
  const runId8 = runId.slice(0, 8);
  // real pi writes its session tree under PI_CODING_AGENT_SESSION_DIR (verified
  // against 0.84.2) — and with a CUSTOM session root it writes FLAT files,
  // <root>/<ts>_<id>.jsonl, with NO --<cwd>-- subdir. Wait until the session
  // file has REAL lines (the first completed message), THEN kill the daemon —
  // the orphan pi continues until its next stdout write EPIPEs, so the session
  // file holds a tail the daemon never folded.
  const sessionRootList = sessionRoot;
  await waitFor(async () => {
    const d = await client.getRun(runId);
    return d.sessions.length > 0;
  }, 300_000, "real pi session spawned");
  let sessionFile = "";
  await waitFor(() => {
    let entries: string[] = [];
    try {
      entries = readdirSync(sessionRootList);
    } catch {
      return false;
    }
    const hit = entries.filter((f) => f.endsWith(`_${runId8}_build_v1.jsonl`)).sort().at(-1);
    if (!hit) return false;
    const lines = readFileSync(join(sessionRootList, hit), "utf8").split("\n").filter((l) => l !== "");
    if (lines.length >= 3) {
      sessionFile = hit;
      return true;
    }
    return false;
  }, 300_000, "session file with a completed message");
  const beforeKill = readFileSync(join(sessionRootList, sessionFile), "utf8").split("\n").filter((l) => l !== "").length;
  console.log(`smoke: session file has ${beforeKill} line(s) — SIGKILLing the daemon mid-session (run ${runId8}…)…`);
  daemon.child.kill("SIGKILL");
  await waitFor(async () => {
    try {
      await client.health();
      return false;
    } catch {
      return true;
    }
  }, 20_000, "daemon down");
  // give the orphan pi a moment to write to its session file before it dies
  await new Promise((r) => setTimeout(r, 1500));

  // restart against the SAME data dir: reaps, interrupts, backfills
  daemon = bootDaemon(dataDir, { PI_CODING_AGENT_SESSION_DIR: sessionRoot });
  await waitForHealth(dataDir);
  // the restarted daemon bound a NEW ephemeral port — re-point the client at it
  client = new ServerClient({ baseUrl: daemon.baseUrl });
  await waitForStatus(client, runId, "interrupted", 120_000);
  const detail = await client.getRun(runId);
  check("run surfaced interrupted after restart", detail.run.status === "interrupted");

  // pi's own session file is the durable record of what the orphan processed:
  // every line of it must be in the run's raw record (nothing missed, nothing doubled)
  const sessionLines = readFileSync(join(sessionRootList, sessionFile), "utf8").split("\n").filter((l) => l !== "");
  const rawPath = join(runDirFor(dataDir, runId), "raw_output.jsonl");
  const rawLines = readFileSync(rawPath, "utf8").split("\n").filter((l) => l !== "");
  const missing = sessionLines.filter((l) => !rawLines.includes(l));
  check("every session line is in the raw record (no missed events)", missing.length === 0, `session=${sessionLines.length} raw=${rawLines.length} missing=${missing.length}`);

  // idempotent: a further sweep restores nothing (events table is append-only)
  const db = openDb(join(dataDir, "showrunner.db"));
  try {
    const again = backfillMissedEvents(db, dataDir, { sessionDir: sessionRoot });
    check("second backfill sweep is a no-op (idempotent)", again.lines_restored === 0 && again.events_folded === 0, `restored=${again.lines_restored} folded=${again.events_folded}`);
  } finally {
    db.close();
  }

  daemon.child.kill("SIGKILL");
}

// ── scenario 4: the poll tool extension loads and RUNS under real pi ─────────

async function scenarioPollTool(): Promise<void> {
  console.log("\n=== scenario 4: poll tool runtime load — the starter-kit extension called by a real agent ===");
  if (!existsSync(POLL_TOOL)) {
    check("poll tool file present", false, POLL_TOOL);
    return;
  }
  const sessionId = `smoke_poll_${Date.now().toString(36)}`;
  const child = spawn(piBinary, ["--mode", "rpc", "--session-id", sessionId, "--approve", "-e", POLL_TOOL], {
    cwd: tmp("poll-repo"),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stream = "";
  const sawPoll: Promise<boolean> = new Promise((resolve) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stream += c;
      if (stream.includes('"toolName":"poll"')) resolve(true);
    });
  });
  child.stdin.write(JSON.stringify({ type: "prompt", message: 'Call the poll tool exactly once with command="true" (it exits 0 immediately). Then reply with just: done.' }) + "\n");
  let called = false;
  try {
    called = await Promise.race([sawPoll, new Promise<false>((r) => setTimeout(() => r(false), 300_000))]);
  } finally {
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
  }
  check("the agent CALLED the poll tool (runtime load proven)", called, called ? '"toolName":"poll" in stream' : "no tool call within 300s");
  child.kill("SIGKILL");
  if (called) console.log("smoke: poll extension loaded via `pi -e` and executed a real poll (command=true)");
}

// ── run every scenario (isolated: one crash reports, the rest still run) ─────

console.log("smoke: SHOWRUNNER_SMOKE=1 — running the capstone against REAL pi (spend: a little).");

const scenarios: [string, () => Promise<void>][] = [
  ["capstone", scenarioCapstone],
  ["crash-with-live-child", scenarioCrash],
  ["backfill", scenarioBackfill],
  ["poll tool runtime load", scenarioPollTool],
];
for (const [name, fn] of scenarios) {
  try {
    await fn();
  } catch (err) {
    console.error(`smoke: scenario "${name}" crashed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    failures.push(`scenario ${name} crashed`);
  }
}

console.log("\n=== smoke summary ===");
if (failures.length === 0) {
  console.log("smoke PASSED: capstone (correction + real gates + steer + override + approve + spend), crash-with-live-child, real-pi backfill, poll runtime load.");
  console.log("smoke: run `SHOWRUNNER_SMOKE_KEEP=1 …` to keep the scratch dirs for inspection.");
  // FINDING 4: the PASS path must exit explicitly — a leaked handle (the
  // daemon children / keep-alive sockets) otherwise keeps the process alive
  // after "smoke PASSED" with no exit code.
  process.exit(0);
} else {
  console.error(`smoke FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
