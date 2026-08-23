import { test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { runDirFor, socketPathFor } from "@showrunner/core";

import { cleanupDir, tmpDataDir } from "./helpers.ts";
import {
  backfillMissedEvents,
  cleanupProcesses,
  cursorEvents,
  daemonEntryPath,
  eventCount,
  insertAgentSession,
  insertPhase,
  insertProcess,
  insertRun,
  listProcesses,
  openDb,
  sessionDirNameForCwd,
  startDaemon,
  writeAgentMap,
} from "../src/index.ts";
import type { DaemonHandle } from "../src/index.ts";

/**
 * T07 crash recovery & daemon lifecycle (issue #12): kill-9 durability, §12.1
 * orphan cleanup, §12.4 backfill, §13 status/graceful shutdown. The kill-9
 * fixtures spawn REAL daemon processes against scratch data dirs — fake
 * sessions only (no pi binary, no tokens).
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");
const HAPPY_BP = join(fixturesDir, "happy-blueprint.ts");

function api(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { socketPath, method, path, headers: body === undefined ? {} : { "content-type": "application/json" } },
      (res: IncomingMessage) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // keep raw text
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function waitForStatus(socketPath: string, runId: string, status: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { json } = await api(socketPath, "GET", `/runs/${runId}`);
    const run = (json as { run: { status: string } }).run;
    if (run.status === status) return;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach ${status} in time`);
    await new Promise((r) => setTimeout(r, 20));
  }
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

/** Wait until the run's raw record has lines — i.e. the fake session has
 * actually spawned and streamed (event_count can grow from run_status before
 * any agent line exists; the kill tests need the CHILD live + streaming). */
async function waitForAgentStream(socketPath: string, runId: string): Promise<void> {
  await waitFor(async () => {
    const { json } = await api(socketPath, "GET", `/runs/${runId}/raw?n=1`);
    return ((json as { line_count: number }).line_count ?? 0) > 0;
  }, 15_000, "agent streaming");
}

// ── kill-9 durability: SIGKILL the daemon mid-run, restart, prove the run is
//    interrupted (not torn), the DB is intact, and the run resumes to success ─

test(
  "kill-9 mid-run: restart surfaces interrupted, DB intact (integrity_check, WAL, no torn rows), resume continues to success",
  async () => {
    const dir = tmpDataDir("crash-kill9");
    const runCwd = mkdtempSync(join(tmpdir(), "showrunner-kill9-cwd-"));
    let daemonPid = 0;
    const boot = (): void => {
      const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dir], {
        stdio: "ignore",
        env: { ...process.env, SHOWRUNNER_POOL_SIZE: "1" },
      });
      child.unref();
      daemonPid = child.pid ?? 0;
    };
    try {
      boot();
      const socketPath = socketPathFor(dir);
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return true;
        } catch {
          return false;
        }
      }, 15_000, "daemon up");

      // a run slow enough to be mid-flight at kill time
      const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 30 });
      const runId = (sub.json as { run_id: string }).run_id;
      await waitForAgentStream(socketPath, runId);
      const before = (await api(socketPath, "GET", `/runs/${runId}`)).json as {
        sessions: { pid: number }[];
        event_count: number;
      };
      const childPid = before.sessions[0]!.pid;
      expect(pidAlive(childPid)).toBe(true); // a live child is being driven
      const preKillEvents = before.event_count;

      // SIGKILL — no cleanup, no signal handlers: exactly what a crash is
      process.kill(daemonPid, "SIGKILL");
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return false;
        } catch {
          return true;
        }
      }, 15_000, "daemon down");

      // restart against the SAME data dir: §12.1 reaps the orphan (or notes it
      // already died on EPIPE), §12.2 surfaces the run as interrupted
      boot();
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return true;
        } catch {
          return false;
        }
      }, 15_000, "daemon up again");
      await waitForStatus(socketPath, runId, "interrupted");
      // the child is gone after the restart (reaped or died with its pipe)
      await waitFor(() => !pidAlive(childPid), 5_000, "child death");
      await new Promise((r) => setTimeout(r, 300)); // let the reap settle

      // the interrupted surfacing is an event, not a corruption
      const interruptedDetail = (await api(socketPath, "GET", `/runs/${runId}`)).json as {
        run: { status: string; needs_review: number };
        event_count: number;
      };
      expect(interruptedDetail.run.status).toBe("interrupted");
      expect(interruptedDetail.run.needs_review).toBe(0); // interruption ≠ needs_review (T04 pin)
      // the crash did not lose already-flushed events: the count only grew
      // (the reconcile run_status event) — never shrank
      expect(interruptedDetail.event_count).toBeGreaterThanOrEqual(preKillEvents);

      // resume → the continuation is REAL: the interrupted visit is relaunched
      // with the SAME session id and the run drives to success
      const resume = await api(socketPath, "POST", `/runs/${runId}/resume`, { by: "operator" });
      expect(resume.status).toBe(200);
      expect((resume.json as { needs_review: number }).needs_review).toBe(1);
      await waitForStatus(socketPath, runId, "success");
      const done = (await api(socketPath, "GET", `/runs/${runId}`)).json as {
        run: { status: string; needs_review: number };
        sessions: { pi_session_id: string }[];
      };
      expect(done.run.status).toBe("success");
      expect(done.run.needs_review).toBe(1); // T04 pin: any resume flags it, success keeps it
      expect(new Set(done.sessions.map((s) => s.pi_session_id))).toEqual(
        new Set([`${runId.slice(0, 8)}_build_v1`]),
      ); // no v2 — same --session-id

      // stop the daemon, then verify the DB cold (no concurrent writer)
      process.kill(daemonPid, "SIGKILL");
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return false;
        } catch {
          return true;
        }
      }, 15_000, "daemon down (final)");

      const db = openDb(join(dir, "showrunner.db"));
      try {
        // §4.1 durability: WAL mode survived a kill-9; the file is sound
        expect((db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
        expect((db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
        // no torn rows: every event parses, ids are strictly ascending
        const rows = db
          .query<{ id: number; type: string; data: string }, []>("SELECT id, type, data FROM events ORDER BY id")
          .all();
        expect(rows.length).toBeGreaterThan(0);
        for (let i = 1; i < rows.length; i++) expect(rows[i]!.id).toBeGreaterThan(rows[i - 1]!.id);
        for (const r of rows) expect(() => JSON.parse(r.data)).not.toThrow();
        expect(db.query("SELECT type FROM events").all().length).toBe(rows.length);
        // §12.1: the processes table is empty after the restart's cleanup
        expect((db.query("SELECT COUNT(*) AS n FROM processes").get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(runCwd, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

// ── §12.1 orphan cleanup, unit level: live orphans are SIGTERM'd + removed ───

test("cleanupProcesses removes dead-pid rows and SIGTERMs live orphans (§12.1)", async () => {
  const dir = tmpDataDir("orphan");
  try {
    const db = openDb(join(dir, "showrunner.db"));
    // a LIVE orphan: a sleep child that would never die on its own
    const orphan = spawn("/bin/sleep", ["30"]);
    const livePid = orphan.pid ?? 0;
    const t = new Date().toISOString();
    insertRun(db, { id: "r1", blueprint: "b", status: "running", cwd: "/w", needs_review: 0, started_at: t, ended_at: null });
    insertProcess(db, { id: "s1", pid: livePid, kind: "agent", started_at: t }); // alive orphan
    insertProcess(db, { id: "s2", pid: 999_999, kind: "agent", started_at: t }); // dead pid
    insertProcess(db, { id: "s3", pid: 0, kind: "agent", started_at: t }); // bogus pid

    const out = cleanupProcesses(db);
    expect(out.killed).toContain(livePid);
    expect(out.removed_dead).toBe(2);
    expect(listProcesses(db)).toHaveLength(0); // every row is cleaned

    // the live orphan actually received SIGTERM and died (§8.3 fail semantics)
    const deadline = Date.now() + 5_000;
    while (pidAlive(livePid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(pidAlive(livePid)).toBe(false);
    orphan.kill("SIGKILL"); // safety
    db.close();
  } finally {
    cleanupDir(dir);
  }
}, { timeout: 20_000 });

// ── §12.4 backfill, unit level: the missed session tail is restored and the
//    sweep is idempotent (deduplicated — the events table is append-only) ─────

test("backfill restores the missed session tail, deduplicated (idempotent sweep)", async () => {
  const dir = tmpDataDir("backfill");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-backfill-cwd-"));
  const sessionRoot = mkdtempSync(join(tmpdir(), "showrunner-backfill-sess-"));
  try {
    const db = openDb(join(dir, "showrunner.db"));
    const runId = "b0b0b0b0-0000-4000-8000-000000000001";
    const piSessionId = `${runId.slice(0, 8)}_build_v1`;
    const t = new Date().toISOString();
    insertRun(db, { id: runId, blueprint: "backfill-demo", status: "interrupted", cwd: runCwd, needs_review: 0, started_at: t, ended_at: null });
    const phaseId = "p1";
    insertPhase(db, { id: phaseId, run_id: runId, name: "build", agent: "builder", status: "in_progress", visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: t, ended_at: null });
    insertAgentSession(db, { id: "s1", run_id: runId, phase_id: phaseId, pi_session_id: piSessionId, visit: 1, pid: 9999, started_at: t, ended_at: null });

    // the session JSONL mirror (what fake-session.ts writes with
    // PI_CODING_AGENT_SESSION_DIR set): a full turn — usage + a tool call + settle
    const l = (o: Record<string, unknown>): string => JSON.stringify({ ...o, sessionId: piSessionId });
    const tail: string[] = [
      l({ type: "turn_start" }),
      l({ type: "message_update", message: { id: "m1", role: "assistant" }, usage: { input: 100, output: 20, totalTokens: 120, cost: { total: 0.0002 } } }),
      l({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: "ls" }),
      l({ type: "tool_execution_update", toolCallId: "c1", toolName: "bash", partialResult: { content: [{ type: "text", text: "ok" }] } }),
      l({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "ok" }] }, isError: false }),
      l({ type: "agent_settled" }),
    ];
    // the pre-crash daemon folded the FIRST line (in its raw file); the tail
    // (above) is what it missed while down
    const firstLine = l({ type: "agent_start", messageCount: 0, model: "fake-pi" });
    const sessionFile = join(sessionRoot, sessionDirNameForCwd(runCwd), `20240101T000000000_${piSessionId}.jsonl`);
    mkdirSync(dirname(sessionFile), { recursive: true });
    writeFileSync(sessionFile, [firstLine, ...tail].join("\n") + "\n");
    const runDir = runDirFor(dir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "raw_output.jsonl"), firstLine + "\n");
    writeAgentMap(runDir, "build", { pi_session_id: piSessionId, pid: 9999, visit: 1, model: "fake-pi" });

    const first = backfillMissedEvents(db, dir, { sessionDir: sessionRoot });
    expect(first.lines_restored).toBe(tail.length);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0]!.pi_session_id).toBe(piSessionId);

    // the restored lines are in the raw record, in order (append-only, no gaps)
    const raw = readFileSync(join(runDir, "raw_output.jsonl"), "utf8");
    expect(raw).toBe([firstLine, ...tail].join("\n") + "\n");

    // the missed tail folded into events: spend (usage) + tool_call + agent_end
    const events = cursorEvents(db, runId, 0, 10_000);
    expect(events.some((e) => e.type === "spend" && (e.data as { usd: number | null }).usd === 0.0002)).toBe(true);
    expect(events.some((e) => e.type === "tool_call" && (e.data as { tool_call_id: string }).tool_call_id === "c1")).toBe(true);
    expect(events.some((e) => e.type === "agent_end" && (e.data as { ok: boolean }).ok === false)).toBe(true);
    const countAfterFirst = eventCount(db, runId);

    // idempotent: a second sweep finds nothing (no double-inserted events)
    const second = backfillMissedEvents(db, dir, { sessionDir: sessionRoot });
    expect(second.lines_restored).toBe(0);
    expect(second.events_folded).toBe(0);
    const third = backfillMissedEvents(db, dir, { sessionDir: sessionRoot });
    expect(third.lines_restored).toBe(0);
    expect(eventCount(db, runId)).toBe(countAfterFirst); // events table is append-only
    db.close();
  } finally {
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
    rmSync(sessionRoot, { recursive: true, force: true });
  }
});

// ── §12.4 backfill end-to-end: daemon killed mid-session → restart restores
//    the missed tail and a further restart adds nothing ───────────────────────

test(
  "backfill e2e: kill the daemon mid-run, restart — the missed session tail appears and a second restart is a no-op",
  async () => {
    const dir = tmpDataDir("crash-backfill");
    const runCwd = mkdtempSync(join(tmpdir(), "showrunner-backfill-e2e-cwd-"));
    const sessionRoot = mkdtempSync(join(tmpdir(), "showrunner-backfill-e2e-sess-"));
    let daemonPid = 0;
    const boot = (): void => {
      const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dir], {
        stdio: "ignore",
        env: { ...process.env, SHOWRUNNER_POOL_SIZE: "1", PI_CODING_AGENT_SESSION_DIR: sessionRoot },
      });
      child.unref();
      daemonPid = child.pid ?? 0;
    };
    try {
      boot();
      const socketPath = socketPathFor(dir);
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return true;
        } catch {
          return false;
        }
      }, 15_000, "daemon up");

      const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 20 });
      const runId = (sub.json as { run_id: string }).run_id;
      await waitForAgentStream(socketPath, runId);
      process.kill(daemonPid, "SIGKILL");
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return false;
        } catch {
          return true;
        }
      }, 15_000, "daemon down");

      // restart: the fake's session file is the durable record of what it did
      // after the daemon died; the restart's backfill restores the missed tail
      boot();
      await waitFor(async () => {
        try {
          await api(socketPath, "GET", "/health");
          return true;
        } catch {
          return false;
        }
      }, 15_000, "daemon up again");
      await waitForStatus(socketPath, runId, "interrupted");

      // the fake writes `<ts>_<pi_session_id>.jsonl` under the sanitized-cwd
      // dir — its OWN (resolved) cwd, which on macOS /var → /private/var
      // differs from the submitted path
      const sessionDir = join(sessionRoot, sessionDirNameForCwd(realpathSync(runCwd)));
      const sessionFile = readdirSync(sessionDir)
        .filter((e) => e.endsWith(`_${runId.slice(0, 8)}_build_v1.jsonl`))
        .sort()
        .at(-1)!;
      const db = openDb(join(dir, "showrunner.db")); // read-side while the daemon idles
      try {
        // the daemon's startup backfill already ran (startDaemon is synchronous
        // before listen): the run's raw record now holds every line the session
        // file has — the missed tail is restored, deduplicated
        const rawPath = join(runDirFor(dir, runId), "raw_output.jsonl");
        const raw = readFileSync(rawPath, "utf8").split("\n").filter((x) => x !== "");
        const sessionLines = readFileSync(join(sessionDir, sessionFile), "utf8")
          .split("\n")
          .filter((x) => x !== "");
        // every session line is in the raw record (nothing missed; nothing doubled)
        expect(raw.length).toBeGreaterThan(0);
        for (const line of sessionLines) expect(raw).toContain(line);
        expect(new Set(raw).size).toBe(raw.length); // no duplicated lines in the raw file
        const countAfterRestart = eventCount(db, runId);

        // a further sweep is a no-op (idempotent — the events table stays append-only)
        const again = backfillMissedEvents(db, dir, { sessionDir: sessionRoot });
        expect(again.lines_restored).toBe(0);
        expect(eventCount(db, runId)).toBe(countAfterRestart);
      } finally {
        db.close();
      }
    } finally {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(runCwd, { recursive: true, force: true });
      rmSync(sessionRoot, { recursive: true, force: true });
    }
  },
  { timeout: 120_000 },
);

// ── §13 status verb: health + pool utilization + run status counts ───────────

test("GET /status reports health, pool utilization, and run status counts (§13)", async () => {
  const dir = tmpDataDir("status");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-status-cwd-"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = startDaemon({ dataDir: dir, poolSlots: 1 });
    const { socketPath } = daemon;
    const s0 = (await api(socketPath, "GET", "/status")).json as {
      ok: boolean;
      pid: number;
      data_dir: string;
      uptime_ms: number;
      pool: { slots: number; running: string[]; queued: string[] };
      runs: Record<string, number>;
    };
    expect(s0.ok).toBe(true);
    expect(s0.pid).toBe(process.pid);
    expect(s0.data_dir).toBe(dir);
    expect(s0.uptime_ms).toBeGreaterThanOrEqual(0);
    expect(s0.pool.slots).toBe(1);
    expect(s0.pool.running).toEqual([]);
    expect(s0.pool.queued).toEqual([]);
    expect(s0.runs.total).toBe(0);

    // a slow run occupies the pool slot while running
    const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 30 });
    const runId = (sub.json as { run_id: string }).run_id;
    await waitFor(async () => {
      const { json } = await api(socketPath, "GET", `/runs/${runId}`);
      return ((json as { event_count: number }).event_count ?? 0) > 0;
    }, 15_000, "run started");
    const s1 = (await api(socketPath, "GET", "/status")).json as {
      pool: { running: string[] };
      runs: Record<string, number>;
    };
    expect(s1.pool.running).toContain(runId);
    expect(s1.runs.running).toBe(1);

    await waitForStatus(socketPath, runId, "success");
    const s2 = (await api(socketPath, "GET", "/status")).json as {
      pool: { running: string[] };
      runs: Record<string, number>;
    };
    expect(s2.pool.running).toEqual([]);
    expect(s2.runs.success).toBe(1);
    expect(s2.runs.running ?? 0).toBe(0);
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
});

// ── §13 graceful shutdown: stop children, remove socket + pidfile ────────────

test("graceful shutdown stops recorded children and removes the socket + pidfile (§13)", async () => {
  const dir = tmpDataDir("shutdown");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-shutdown-cwd-"));
  let daemon: DaemonHandle | null = null;
  try {
    daemon = startDaemon({ dataDir: dir, poolSlots: 1 });
    const { socketPath } = daemon;
    const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 30 });
    const runId = (sub.json as { run_id: string }).run_id;
    await waitFor(async () => {
      const { json } = await api(socketPath, "GET", `/runs/${runId}`);
      return ((json as { event_count: number }).event_count ?? 0) > 0;
    }, 15_000, "run started");
    const detail = (await api(socketPath, "GET", `/runs/${runId}`)).json as { sessions: { pid: number }[] };
    const childPid = detail.sessions[0]!.pid;
    expect(pidAlive(childPid)).toBe(true);

    // graceful shutdown: no run is persisted (events are already written), the
    // child is stopped, and the socket + pidfile are removed
    await daemon.close();
    daemon = null;
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
    await waitFor(() => !pidAlive(childPid), 5_000, "child death");

    // the recorded child rows were cleaned by the shutdown
    const db = openDb(join(dir, "showrunner.db"));
    try {
      expect((db.query("SELECT COUNT(*) AS n FROM processes").get() as { n: number }).n).toBe(0);
    } finally {
      db.close();
    }
    // the run left mid-flight surfaces as interrupted on the next start (§12.2)
    const daemon2 = startDaemon({ dataDir: dir, poolSlots: 1 });
    try {
      const { socketPath: sp2 } = daemon2;
      await waitForStatus(sp2, runId, "interrupted");
    } finally {
      await daemon2.close();
    }
  } finally {
    await daemon?.close();
    cleanupDir(dir);
    rmSync(runCwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

// ── resume is still the human's verb only: no auto-resume on restart (v1) ────

test("no auto-resume (v1): a restarted daemon surfaces interrupted but never drives the run itself", async () => {
  const dir = tmpDataDir("crash-noresume");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-noresume-cwd-"));
  let daemonPid = 0;
  const boot = (): void => {
    const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dir], {
      stdio: "ignore",
      env: { ...process.env, SHOWRUNNER_POOL_SIZE: "1" },
    });
    child.unref();
    daemonPid = child.pid ?? 0;
  };
  try {
    boot();
    const socketPath = socketPathFor(dir);
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return true;
      } catch {
        return false;
      }
    }, 15_000, "daemon up");
    const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 30 });
    const runId = (sub.json as { run_id: string }).run_id;
    await waitForAgentStream(socketPath, runId);
    process.kill(daemonPid, "SIGKILL");
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return false;
      } catch {
        return true;
      }
    }, 15_000, "daemon down");
    boot();
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return true;
      } catch {
        return false;
      }
    }, 15_000, "daemon up again");
    await waitForStatus(socketPath, runId, "interrupted");
    // let time pass — the run must STAY interrupted (no auto-resume, §12.6)
    await new Promise((r) => setTimeout(r, 600));
    const detail = (await api(socketPath, "GET", `/runs/${runId}`)).json as { run: { status: string } };
    expect(detail.run.status).toBe("interrupted");
  } finally {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runCwd, { recursive: true, force: true });
  }
}, { timeout: 60_000 });

// ── events table sanity across the kill: the append-only log is complete ─────

test("kill-9 does not tear the events log: ids are contiguous and strictly ascending", async () => {
  const dir = tmpDataDir("crash-tear");
  const runCwd = mkdtempSync(join(tmpdir(), "showrunner-tear-cwd-"));
  let daemonPid = 0;
  const boot = (): void => {
    const child = spawn(process.execPath, [daemonEntryPath(), "--data-dir", dir], {
      stdio: "ignore",
      env: { ...process.env, SHOWRUNNER_POOL_SIZE: "1" },
    });
    child.unref();
    daemonPid = child.pid ?? 0;
  };
  try {
    boot();
    const socketPath = socketPathFor(dir);
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return true;
      } catch {
        return false;
      }
    }, 15_000, "daemon up");
    const sub = await api(socketPath, "POST", "/runs", { blueprint: HAPPY_BP, cwd: runCwd, delayMs: 30 });
    const runId = (sub.json as { run_id: string }).run_id;
    await waitForAgentStream(socketPath, runId);
    const before = (await api(socketPath, "GET", `/runs/${runId}/events?cursor=0&limit=500`)).json as {
      events: { id: number }[];
    };
    const preKillIds = before.events.map((e) => e.id);
    process.kill(daemonPid, "SIGKILL");
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return false;
      } catch {
        return true;
      }
    }, 15_000, "daemon down");
    boot();
    await waitFor(async () => {
      try {
        await api(socketPath, "GET", "/health");
        return true;
      } catch {
        return false;
      }
    }, 15_000, "daemon up again");
    await waitForStatus(socketPath, runId, "interrupted");

    // every pre-kill event is still readable and in order — the tail may have
    // been lost (unflushed sink), but nothing before it is torn
    const db = openDb(join(dir, "showrunner.db"));
    try {
      const ids = (db.query("SELECT id FROM events ORDER BY id").all() as { id: number }[]).map((r) => r.id);
      for (let i = 1; i < ids.length; i++) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);
      // the pre-kill ids are a PREFIX of the final log (nothing after a gap)
      for (let i = 0; i < preKillIds.length - 1; i++) {
        expect(ids[i]).toBe(preKillIds[i]);
      }
    } finally {
      db.close();
    }
  } finally {
    try {
      process.kill(daemonPid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(runCwd, { recursive: true, force: true });
  }
}, { timeout: 120_000 });
