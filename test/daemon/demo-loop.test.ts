process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * R7 acceptance (daemon level) — the demo-loop fixture driven through the
 * real run loop (runBlueprint, the direct API): plan → implement → review →
 * package, where review v1 exhausts its correction budget (1) and the on_fail
 * jump sends execution back to implement for a v2, then review v2 and package
 * succeed. Everything the SPA renders is derived from this run's rows/events,
 * so the fixture + these tests are the ground truth the UI test
 * (test/ui/demo-loop.test.ts) renders through the router.
 *
 * Also pins the R7 #3/#7 conventions: the zod validation of the phase_start
 * payload (round-1's core test is cited, the DB-insert path is asserted here),
 * the (run_id, rowid) cursor read the timeline endpoint uses, and SCHEMA_VERSION.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbPathFor, PhaseStartData, runDirFor } from "../../src/core/index.ts";
import type { TimelineView } from "../../src/daemon/client.ts";
import {
  cleanupDir,
  tmpDataDir,
} from "./helpers.ts";
import {
  RunPool,
  SCHEMA_VERSION,
  cursorEvents,
  getControl,
  getRun,
  handleApiRequest,
  insertEvent,
  insertRun,
  listEnvelopes,
  listPhases,
  loadBlueprintModule,
  openDb,
  resolveScriptedSessions,
  runBlueprint,
} from "../../src/daemon/index.ts";
import type { PhaseRow, ScriptedTurn } from "../../src/daemon/index.ts";

/**
 * The demo-loop fixture: the blueprint module + its scripted sessions
 * (fake-pi/<phase>.json — resolved by the daemon at submit). The module lives
 * in a fixture SUBDIRECTORY so resolveScriptedSessions finds the sessions at
 * <fixture-dir>/fake-pi (the handoff fixture's layout).
 */
const DEMO_LOOP_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "demo-loop");
const DEMO_LOOP_BP = join(DEMO_LOOP_FIXTURE_DIR, "demo-loop.ts");
const DEMO_LOOP_FAKE_PI = join(DEMO_LOOP_FIXTURE_DIR, "fake-pi");

interface Env {
  dir: string;
  db: ReturnType<typeof openDb>;
  cwd: string;
}

function openEnv(label: string): Env {
  const dir = tmpDataDir(label);
  const db = openDb(join(dir, "showrunner.db"));
  const cwd = mkdtempSync(join(tmpdir(), "showrunner-cwd-"));
  return { dir, db, cwd };
}

function closeEnv(env: Env): void {
  env.db.close();
  rmSync(env.cwd, { recursive: true, force: true });
  cleanupDir(env.dir);
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The daemon's ApiState shape (db + dataDir + pool + startedAt) — the
 * timeline wire route is exercised through handleApiRequest, exactly like
 * test/daemon/timeline.test.ts. */
function apiState(env: Env): { db: ReturnType<typeof openDb>; dataDir: string; pool: RunPool; startedAt: number } {
  return { db: env.db, dataDir: env.dir, pool: new RunPool(2), startedAt: Date.now() };
}

async function fetchTimeline(
  state: ReturnType<typeof apiState>,
  runId: string,
): Promise<{ status: number; view: TimelineView }> {
  const res = await handleApiRequest(state, new Request(`http://127.0.0.1/api/runs/${runId}/timeline`));
  return { status: res.status, view: (await res.json()) as TimelineView };
}

/** A minimal settled turn — one agent stream ending agent_settled, then the
 * envelope the "agent" wrote (extended for the blocked-pause variant). */
function settledTurn(envelope: Record<string, unknown>): ScriptedTurn {
  return {
    events: [
      { type: "agent_start", messageCount: 0, model: "fake-pi" },
      { type: "turn_start" },
      { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_start", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "done" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
    envelope,
  };
}

// ── R7 #1: the completed demo-loop run folds into the acceptance timeline ───

test("R7 #1: the demo-loop run folds into plan/implement/review/package with 1/2/2/1 segments — on_fail cause on implement v2, review v1 failed with 1 correction", async () => {
  const env = openEnv("demo-loop-r7");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    // the four scripted sessions resolve per phase from the fixture's fake-pi/
    expect(Object.keys(scripts).sort()).toEqual(["implement", "package", "plan", "review"]);

    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    const result = await run.terminal;
    expect(result).toEqual({ status: "success", needs_review: false });

    // the run's own state: every phase eventually succeeded; implement and
    // review each took exactly two visits (the row reflects the LAST visit —
    // per-visit outcomes live in the timeline segments below)
    const phases = listPhases(env.db, run.run_id);
    expect(phases.map((p) => [p.name, p.status, p.visits, p.budget])).toEqual([
      ["plan", "success", 1, 3],
      ["implement", "success", 2, 3],
      ["review", "success", 2, 1],
      ["package", "success", 1, 3],
    ]);

    // R7 #1 endpoint: 4 phases in blueprint order, segment counts 1/2/2/1
    const state = apiState(env);
    const { status, view } = await fetchTimeline(state, run.run_id);
    expect(status).toBe(200);
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "implement", "review", "package"]);
    expect(view.phases.map((p) => p.segments.length)).toEqual([1, 2, 2, 1]);

    const impl = view.phases.find((p) => p.name === "implement")!;
    expect(impl.segments[0]!.cause).toEqual({ kind: "flow" });
    // implement's segment 2: caused by the review v1 on_fail jump
    expect(impl.segments[1]!.cause).toEqual({ kind: "on_fail", from_phase: "review", from_visit: 1 });
    expect(impl.segments[1]!.outcome).toBe("success");

    const review = view.phases.find((p) => p.name === "review")!;
    // review's segment 1: the failed visit — budget (1) exhausted, one
    // correction issued for the first rejected attempt
    expect(review.segments[0]!.outcome).toBe("failed");
    expect(review.segments[0]!.corrections).toBe(1);
    expect(review.segments[0]!.cause).toEqual({ kind: "flow" });
    // review's segment 2: reached by forward execution after implement v2
    expect(review.segments[1]!.cause).toEqual({ kind: "flow" });
    expect(review.segments[1]!.outcome).toBe("success");

    const pkg = view.phases.find((p) => p.name === "package")!;
    expect(pkg.segments).toHaveLength(1);
    expect(pkg.segments[0]!.outcome).toBe("success");

    // R2 event-level trace: the phase_start causes the fold copies verbatim
    const starts = cursorEvents(env.db, run.run_id, 0, 10_000)
      .filter((e) => e.type === "phase_start")
      .map((e) => e.data as { phase: string; visit: number; cause?: unknown });
    expect(starts.map((s) => [s.phase, s.visit, s.cause])).toEqual([
      ["plan", 1, { kind: "flow" }],
      ["implement", 1, { kind: "flow" }],
      ["review", 1, { kind: "flow" }],
      ["implement", 2, { kind: "on_fail", from_phase: "review", from_visit: 1 }],
      ["review", 2, { kind: "flow" }],
      ["package", 1, { kind: "flow" }],
    ]);
    // review v1's phase_end reports the failure (the payload also carries
    // spend_usd — match the fields the acceptance names)
    const reviewEnd = cursorEvents(env.db, run.run_id, 0, 10_000)
      .filter((e) => e.type === "phase_end")
      .map((e) => e.data as { phase: string; status: string; visits: number; corrections: number });
    expect(reviewEnd).toContainEqual(
      expect.objectContaining({ phase: "review", status: "failed", visits: 1, corrections: 1 }),
    );
  } finally {
    closeEnv(env);
  }
});

// ── R7 #1 (envelope_attempts) + the per-visit scripting seam ────────────────

test("R7 #1 envelope_attempts: the fold counts `envelopes` TABLE rows per (phase, visit) — review v1 (two rejected attempts) reports 2, the same source the drill-in's per-attempt list reads. The byVisit seam drives review v1 (quality 5, 6) vs v2 (quality 9)", async () => {
  const env = openEnv("demo-loop-attempts");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    expect((await run.terminal).status).toBe("success");

    // The REAL run's per-visit script behavior — the byVisit seam delivered
    // DIFFERENT turns per visit: review v1 wrote quality 5 then 6 (both gate
    // violations → the budget of 1 exhausts), review v2 wrote quality 9.
    const reviewId = listPhases(env.db, run.run_id).find((p) => p.name === "review")!.id;
    const reviewEnvelopes = listEnvelopes(env.db, run.run_id)
      .filter((e) => e.phase_id === reviewId)
      .sort((a, b) => a.visit - b.visit || a.attempt - b.attempt);
    expect(reviewEnvelopes.map((e) => [e.visit, e.attempt, JSON.parse(e.json).quality])).toEqual([
      [1, 0, 5],
      [1, 1, 6],
      [2, 0, 9],
    ]);
    // the per-visit session files the driver wrote prove which turns each
    // visit replayed (review-v1.json = the two failing turns, review-v2.json
    // = the single passing turn)
    const runDir = runDirFor(env.dir, run.run_id);
    const v1Script = JSON.parse(readFileSync(join(runDir, "sessions", "review-v1.json"), "utf8")) as {
      turns: { envelope: { quality: number } }[];
    };
    const v2Script = JSON.parse(readFileSync(join(runDir, "sessions", "review-v2.json"), "utf8")) as {
      turns: { envelope: { quality: number } }[];
    };
    expect(v1Script.turns.map((t) => t.envelope.quality)).toEqual([5, 6]);
    expect(v2Script.turns.map((t) => t.envelope.quality)).toEqual([9]);
    // a visit without a byVisit key replays `turns` unchanged (plan: one turn)
    const planScript = JSON.parse(readFileSync(join(runDir, "sessions", "plan-v1.json"), "utf8")) as {
      turns: { envelope: { quality: number } }[];
    };
    expect(planScript.turns.map((t) => t.envelope.quality)).toEqual([9]);

    // envelope_attempts on the wire: the fold counts the `envelopes` TABLE
    // rows per (phase_id, visit) — the SAME source the phase drill-in's
    // attempt list reads (test/daemon/timeline.test.ts seeds those rows and
    // asserts the same counts). review v1's segment reports 2 (rows attempts
    // 0 and 1, quality 5 and 6 — both gate-rejected: valid=1 rows with gate
    // violations), review v2 reports 1 (attempt 0, quality 9). The §6 #8
    // `envelope` EVENT would undercount here — it fires only on acceptance,
    // and review v1 accepted nothing.
    const state = apiState(env);
    const { view } = await fetchTimeline(state, run.run_id);
    const review = view.phases.find((p) => p.name === "review")!;
    expect(review.segments[0]!.envelope_attempts).toBe(2); // two rows: attempts 0 + 1, both rejected
    expect(review.segments[1]!.envelope_attempts).toBe(1); // v2: one row
    expect(view.phases.find((p) => p.name === "plan")!.segments[0]!.envelope_attempts).toBe(1);
  } finally {
    closeEnv(env);
  }
});

// ── R7 #2: the R1 invariant observed mid-run ────────────────────────────────

test("R7 #2: a DB snapshot while implement v2 runs shows in_progress + ended_at NULL; after the run the row keeps v1's started_at and gains v2's ended_at", async () => {
  const env = openEnv("demo-loop-r1");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    // FakePi pacing (delayMs per streamed line) widens implement v2's visit
    // into a pollable window — the run takes ~4s, implement v2 ~0.5s
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts, delayMs: 40 });
    const runId = run.run_id;

    // poll until implement's row reads visits=2 + in_progress — exactly the
    // moment implement v2 is mid-visit (v1 set visits=1; the row is not
    // touched again until v2 starts)
    let mid: PhaseRow | null = null;
    await waitFor(() => {
      const impl = listPhases(env.db, runId).find((p) => p.name === "implement");
      if (impl !== undefined && impl.visits === 2 && impl.status === "in_progress") {
        mid = impl;
        return true;
      }
      return false;
    }, 20_000, "implement v2 in_progress");

    // the R1 invariant snapshot, taken while the visit was running
    expect(mid).not.toBeNull();
    expect(mid!.status).toBe("in_progress");
    expect(mid!.ended_at).toBeNull();
    expect(mid!.visits).toBe(2);
    expect(mid!.corrections).toBe(0); // reset at visit start (R1)
    // the run itself is still running at that moment
    expect(getRun(env.db, runId)!.status).toBe("running");
    const v1StartedAt = mid!.started_at;
    expect(v1StartedAt).not.toBeNull();

    // after the run: visits=2, started_at unchanged (the LIFETIME start from
    // v1), ended_at from v2 — the row never showed in_progress + ended_at
    const result = await run.terminal;
    expect(result.status).toBe("success");
    const after = listPhases(env.db, runId).find((p) => p.name === "implement")!;
    expect(after.visits).toBe(2);
    expect(after.started_at).toBe(v1StartedAt);
    expect(after.ended_at).not.toBeNull();
  } finally {
    closeEnv(env);
  }
});

// ── R7 #6 (daemon level): the fixture paused mid-run ────────────────────────

test("R7 #6: a second run of the SAME blueprint whose package envelope asserts blocked parks paused with package's segment OPEN and the row in_progress", async () => {
  const env = openEnv("demo-loop-blocked");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    // the same blueprint, a scripted package envelope that asserts blocked
    // (EnvelopeBase.blocked) — the loop parks at the §3.2 blocked pause with
    // package's phase_start emitted and NO phase_end (the segment stays open)
    scripts.package = {
      turns: [settledTurn({
        summary: "blocked on release credentials",
        artifacts: [],
        notes_for_next_agent: "need a human",
        quality: 9,
        blocked: true,
        blocked_reason: "no release token configured",
      })],
    };
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    const result = await run.done;
    expect(result).toEqual({ status: "paused", needs_review: false });

    // the phase row stays in_progress (never ended), the run row is paused
    expect(listPhases(env.db, run.run_id).find((p) => p.name === "package")!.status).toBe("in_progress");
    expect(getRun(env.db, run.run_id)!.status).toBe("paused");

    // the timeline: package's segment is OPEN — phase_start without phase_end
    const state = apiState(env);
    const { view } = await fetchTimeline(state, run.run_id);
    const pkg = view.phases.find((p) => p.name === "package")!;
    expect(pkg.status).toBe("in_progress");
    expect(pkg.segments).toHaveLength(1);
    expect(pkg.segments[0]!.ended_at).toBeNull();
    expect(pkg.segments[0]!.outcome).toBe("in_progress"); // run paused → rule 2
    // the phases BEFORE package completed normally
    expect(view.phases.find((p) => p.name === "review")!.segments.map((s) => s.outcome)).toEqual([
      "failed",
      "success",
    ]);

    // cleanup: fail the parked run so its control unregisters and terminal resolves
    getControl(run.run_id)!.fail("test");
    expect((await run.terminal).status).toBe("failed");
  } finally {
    closeEnv(env);
  }
});

// ── R7 #3 / #7: validation + cursor + schema conventions ────────────────────

test("R7 #3: a phase_start payload WITHOUT cause validates through the zod path AND the DB insert path (round-1's zod test is core.test.ts)", async () => {
  const env = openEnv("demo-loop-prer2-zod");
  try {
    // round-1's zod-level test — verify it exists and cite it:
    //   test/core/core.test.ts "R2: an old-style phase_start payload (no
    //   cause) still validates (§6 back-compat)" — parseEventData +
    //   PhaseStartData.parse accept { phase, agent, visit, budget } with no
    //   cause key. Re-assert the schema contract here:
    const oldStyle = { phase: "build", agent: "builder", visit: 1, budget: 3 };
    expect(PhaseStartData.parse(oldStyle)).toEqual(oldStyle);

    // the DB insert path (db.ts insertEvent → parseEventData → zod): a
    // no-cause phase_start inserts fine — a run recorded before R2 is readable
    const runId = "pre-r2-run";
    insertRun(env.db, {
      id: runId,
      blueprint: "demo-loop",
      status: "success",
      cwd: "/tmp/scratch",
      needs_review: 0,
      started_at: new Date().toISOString(),
      ended_at: null,
    });
    const id = insertEvent(env.db, {
      run_id: runId,
      phase_id: null,
      agent_session_id: null,
      type: "phase_start",
      ts: new Date().toISOString(),
      data: oldStyle,
    });
    expect(id).toBeGreaterThan(0);

    // every new event payload field is zod-validated on insert: a malformed
    // cause is REJECTED at the insert boundary, not silently stored
    expect(() =>
      insertEvent(env.db, {
        run_id: runId,
        phase_id: null,
        agent_session_id: null,
        type: "phase_start",
        ts: new Date().toISOString(),
        data: { ...oldStyle, cause: { kind: "steer" } },
      }),
    ).toThrow();
  } finally {
    closeEnv(env);
  }
});

test("R7 #7: the timeline endpoint reads via the (run_id, rowid) cursor; SCHEMA_VERSION is unchanged at 2", async () => {
  const env = openEnv("demo-loop-cursor");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    await run.terminal;

    // the timeline endpoint's one read transport is the §4.3 cursor query:
    // collectTimelineEvents (server.ts) sweeps cursorEvents(db, runId, after,
    // MAX_EVENTS_LIMIT) from rowid 0, batching 500 — the events the fold
    // derives the segments from ARE that cursor sweep, in rowid order.
    const swept = cursorEvents(env.db, run.run_id, 0, 10_000);
    const state = apiState(env);
    const { view } = await fetchTimeline(state, run.run_id);

    // the folded segment timestamps are exactly the phase_start/phase_end
    // event ts the cursor returned (rowid order = the fold's order)
    const startTs = swept
      .filter((e) => e.type === "phase_start" && (e.data as { phase: string }).phase === "implement")
      .map((e) => e.ts);
    expect(startTs).toHaveLength(2); // implement v1 + v2, both in the sweep
    const implSegs = view.phases.find((p) => p.name === "implement")!.segments;
    expect(implSegs.map((s) => s.started_at)).toEqual(startTs);
    const reviewEnd = swept
      .filter((e) => e.type === "phase_end" && (e.data as { phase: string }).phase === "review")
      .map((e) => e.ts);
    expect(reviewEnd).toHaveLength(2); // review v1 (failed) + v2 (success)
    expect(view.phases.find((p) => p.name === "review")!.segments.map((s) => s.ended_at)).toEqual(reviewEnd);

    // SCHEMA_VERSION is unchanged — this work adds no schema migration (the
    // per-visit script seam is test-side; the cause field was R2's, already in)
    expect(SCHEMA_VERSION).toBe(2);
  } finally {
    closeEnv(env);
  }
});

test("R7 wire: GET /api/runs/:id/timeline serves the demo-loop run and 404s a ghost", async () => {
  const env = openEnv("demo-loop-wire");
  try {
    const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
    const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
    const run = runBlueprint(env.db, env.dir, { blueprint, cwd: env.cwd, scripts });
    await run.terminal;
    const state = apiState(env);
    const { status, view } = await fetchTimeline(state, run.run_id);
    expect(status).toBe(200);
    expect(view.run_id).toBe(run.run_id);
    expect(view.blueprint).toBe("demo-loop");
    const ghost = await handleApiRequest(state, new Request("http://127.0.0.1/api/runs/ghost/timeline"));
    expect(ghost.status).toBe(404);
  } finally {
    closeEnv(env);
  }
});
