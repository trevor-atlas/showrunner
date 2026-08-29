process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi, never real pi
/**
 * Issue #83 — the trajectory DATA LAYER: the pure per-phase parser
 * (buildTrajectory) and the trajectory.json proxy endpoint.
 *
 * The pure tests exercise buildTrajectory over the existing single-phase
 * happy.jsonl AND a new multi-phase fixture (multiple agent_start blocks),
 * proving lane mapping, per-phase session filtering (all visits), the
 * message/tool fold, message_end dedupe, and the monotonic seq/turn/step.
 * The capped full-read helper's `truncated` flag is tested directly.
 *
 * The endpoint tests drive the app router hermetically (the same in-process
 * pattern as phase-proxies.test.ts): a seeded run + its raw_output.jsonl +
 * agent_sessions + tool_call timings, fetched through the remix proxy, 404ing
 * on a ghost run/phase.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbPathFor, runDirFor } from "../../src/core/index.ts";
import { startServer, type ServerHandle } from "../../src/server/lifecycle.ts";
import { insertAgentSession, insertEvent, insertPhase, insertRun, openDb } from "../../src/server/repository/db.ts";
import { readRawFileCapped } from "../../src/server/repository/rawfile.ts";
import { buildTrajectory, type TrajectorySession } from "../../src/server/lib/trajectory.ts";
import type { TrajectoryToolEntry, TrajectoryView } from "../../src/server/contract.ts";
import { router } from "../../src/server/router.ts";
import { routes } from "../../src/server/routes.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const HAPPY = join(HERE, "..", "..", "src", "server", "engine", "pi", "harness", "fixtures", "happy.jsonl");
const MULTI = join(HERE, "fixtures", "multi-phase.jsonl");

const readFixture = (p: string): string => readFileSync(p, "utf8");

function session(pi_session_id: string, visit: number, overrides: Partial<TrajectorySession> = {}): TrajectorySession {
  return { run_id: "r1", phase: "build", phase_id: "ph-build", pi_session_id, visit, ...overrides };
}

describe("buildTrajectory (pure #83 parser)", () => {
  it("maps lanes over the single-phase happy.jsonl: 1 input, 3 model, 3 tools", () => {
    const view = buildTrajectory(readFixture(HAPPY), [session("fake_happy", 1, { phase: "solo", phase_id: "ph-solo" })]);

    // 7 rows in raw-stream order, seq monotonic from 0
    expect(view.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(view.entries.map((e) => e.lane)).toEqual(["input", "tools", "model", "tools", "model", "tools", "model"]);
    // all under the single turn
    expect(view.entries.every((e) => e.turn === 1)).toBe(true);
    expect(view.entries.map((e) => e.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const input = view.entries[0];
    expect(input?.lane).toBe("input");
    if (input?.lane === "input") expect(input.text).toBe("Build the observation pipeline.");

    const firstTool = view.entries[1];
    expect(firstTool?.lane).toBe("tools");
    if (firstTool?.lane === "tools") {
      expect(firstTool.tool).toBe("bash");
      expect(firstTool.tool_call_id).toBe("call_01");
      expect(firstTool.result).toBe("src/\nindex.ts\n");
      expect(firstTool.ok).toBe(true);
      expect(firstTool.ts).toBeNull(); // no timings passed
      expect(firstTool.duration_ms).toBeNull();
    }

    expect(view.run_id).toBe("r1");
    expect(view.phase).toBe("solo");
    expect(view.truncated).toBe(false);
  });

  it("keeps only the target phase's blocks (all visits) — multi-phase fixture", () => {
    const raw = readFixture(MULTI);

    const build = buildTrajectory(raw, [session("sess_build_v1", 1), session("sess_build_v2", 2)]);
    // visit 1: user + tool + assistant; visit 2 (on_fail re-drive): tool + assistant
    expect(build.entries.map((e) => e.lane)).toEqual(["input", "tools", "model", "tools", "model"]);
    expect(build.entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    // turn continues across visits (turn_start per block); step resets per turn
    expect(build.entries.map((e) => e.turn)).toEqual([1, 1, 1, 2, 2]);
    expect(build.entries.map((e) => e.step)).toEqual([0, 1, 2, 0, 1]);
    // the plan block's rows are NOT present
    const texts = build.entries.map((e) => (e.lane === "tools" ? e.result : e.text));
    expect(texts).not.toContain("Plan the work.");
    expect(texts).not.toContain("Here is the plan.");
    // visit 2's failing tool is folded ok:false
    const boom = build.entries[3];
    expect(boom?.lane).toBe("tools");
    if (boom?.lane === "tools") {
      expect(boom.result).toBe("error: boom");
      expect(boom.ok).toBe(false);
    }

    const plan = buildTrajectory(raw, [
      session("sess_plan", 1, { phase: "plan", phase_id: "ph-plan" }),
    ]);
    expect(plan.entries.map((e) => e.lane)).toEqual(["input", "tools", "model"]);
    const planInput = plan.entries[0];
    if (planInput?.lane === "input") expect(planInput.text).toBe("Plan the work.");
    expect(plan.phase).toBe("plan");
  });

  it("correlates tool ts/duration_ms from the passed timings by tool_call_id", () => {
    const view = buildTrajectory(
      readFixture(MULTI),
      [session("sess_build_v1", 1)],
      { bcall_1: { ts: "2026-01-02T10:00:00.000Z", duration_ms: 1234 } },
    );
    const tool = view.entries.find((e): e is TrajectoryToolEntry => e.lane === "tools" && e.tool_call_id === "bcall_1");
    expect(tool?.ts).toBe("2026-01-02T10:00:00.000Z");
    expect(tool?.duration_ms).toBe(1234);
  });

  it("returns an empty view for a phase with no sessions", () => {
    const view = buildTrajectory(readFixture(MULTI), []);
    expect(view.entries).toEqual([]);
    expect(view.run_id).toBe("");
    expect(view.truncated).toBe(false);
  });
});

describe("readRawFileCapped (#83 capped full-file read)", () => {
  it("reads from the start and sets truncated when the cap bites", () => {
    const dir = mkdtempSync(join(tmpdir(), "showrunner-rawcap-"));
    try {
      const p = join(dir, "raw.jsonl");
      writeFileSync(p, ["a", "b", "c", "d", "e"].join("\n") + "\n");

      const capped = readRawFileCapped(p, 3);
      expect(capped.text).toBe("a\nb\nc\n");
      expect(capped.line_count).toBe(5);
      expect(capped.truncated).toBe(true);

      const whole = readRawFileCapped(p, 10);
      expect(whole.line_count).toBe(5);
      expect(whole.truncated).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty, non-truncated read for a missing file", () => {
    const capped = readRawFileCapped(join(tmpdir(), "does-not-exist-83.jsonl"), 10);
    expect(capped).toEqual({ text: "", line_count: 0, truncated: false });
  });
});

// ── the trajectory.json proxy endpoint ──────────────────────────────────────

const RUN = "83838383-0000-4000-8000-000000000001";
const GHOST = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const iso = (offsetMs: number): string => new Date(Date.now() - 60_000 + offsetMs).toISOString();

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

/** Seed a two-phase run (plan → build, build re-driven twice), its
 * agent_sessions, a tool_call timing for bcall_1, and the multi-phase raw file. */
function seedRun(dir: string): void {
  const db = openDb(dbPathFor(dir));
  insertRun(db, {
    id: RUN,
    blueprint: "demo",
    status: "success",
    cwd: "/tmp/none",
    needs_review: 0,
    started_at: iso(0),
    ended_at: iso(9_000),
  });
  insertPhase(db, {
    id: "ph-plan", run_id: RUN, name: "plan", agent: "planner", status: "success",
    visits: 1, corrections: 0, budget: 3, spend_usd: 0, started_at: iso(1_000), ended_at: iso(2_000),
  });
  insertPhase(db, {
    id: "ph-build", run_id: RUN, name: "build", agent: "builder", status: "success",
    visits: 2, corrections: 1, budget: 3, spend_usd: 0, started_at: iso(3_000), ended_at: iso(8_000),
  });
  insertAgentSession(db, {
    id: "as-plan", run_id: RUN, phase_id: "ph-plan", pi_session_id: "sess_plan", visit: 1,
    pid: 101, started_at: iso(1_000), ended_at: iso(2_000),
  });
  insertAgentSession(db, {
    id: "as-build-1", run_id: RUN, phase_id: "ph-build", pi_session_id: "sess_build_v1", visit: 1,
    pid: 102, started_at: iso(3_000), ended_at: iso(5_000),
  });
  insertAgentSession(db, {
    id: "as-build-2", run_id: RUN, phase_id: "ph-build", pi_session_id: "sess_build_v2", visit: 2,
    pid: 103, started_at: iso(6_000), ended_at: iso(8_000),
  });
  insertEvent(db, {
    run_id: RUN, phase_id: "ph-build", agent_session_id: "as-build-1", type: "tool_call", ts: iso(4_000),
    data: { tool: "bash", tool_call_id: "bcall_1", args: "make", result_snippet: "built ok", ok: true, duration_ms: 4242, agent: "builder" },
  });
  db.close();

  const runDir = runDirFor(dir, RUN);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "raw_output.jsonl"), readFixture(MULTI));
}

async function fetchTrajectory(runId: string, phase: string): Promise<{ status: number; json: unknown }> {
  const href = routes.runs.phases.trajectory.href({ runId, phase });
  const response = await router.fetch(new Request("http://localhost" + href));
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // keep the status assertion below
  }
  return { status: response.status, json };
}

describe("trajectory.json proxy (#83)", () => {
  it("serves the build phase's trajectory — filtered to its sessions, tool timing correlated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "showrunner-traj-"));
    const restore = setDataDir(dir);
    let daemon: ServerHandle | null = null;
    try {
      daemon = await startServer({ dataDir: dir, port: 0 });
      seedRun(dir);

      const res = await fetchTrajectory(RUN, "build");
      expect(res.status).toBe(200);
      const view = res.json as TrajectoryView;
      expect(view.run_id).toBe(RUN);
      expect(view.phase).toBe("build");
      expect(view.phase_id).toBe("ph-build");
      expect(view.truncated).toBe(false);
      // build's two visits only (plan excluded): input, tools, model, tools, model
      expect(view.entries.map((e) => e.lane)).toEqual(["input", "tools", "model", "tools", "model"]);
      const bcall1 = view.entries.find(
        (e): e is TrajectoryToolEntry => e.lane === "tools" && e.tool_call_id === "bcall_1",
      );
      expect(bcall1?.duration_ms).toBe(4242); // from the DB tool_call event
      expect(bcall1?.ts).not.toBeNull();
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404s (as JSON) for a ghost run and a ghost phase", async () => {
    const dir = mkdtempSync(join(tmpdir(), "showrunner-traj-404-"));
    const restore = setDataDir(dir);
    let daemon: ServerHandle | null = null;
    try {
      daemon = await startServer({ dataDir: dir, port: 0 });
      seedRun(dir);

      const ghostRun = await fetchTrajectory(GHOST, "build");
      expect(ghostRun.status).toBe(404);
      expect((ghostRun.json as { error: string }).error).toContain("not found");

      const ghostPhase = await fetchTrajectory(RUN, "ghost");
      expect(ghostPhase.status).toBe(404);
      expect((ghostPhase.json as { error: string }).error).toContain("not found");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
