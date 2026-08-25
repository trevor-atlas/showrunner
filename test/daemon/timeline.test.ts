// R3 — GET /runs/:id/timeline derivation unit tests.
//
// The endpoint folds a run's phase_start/phase_end events into per-visit
// segments (server.ts apiTimeline). These tests pin the derivation rules
// against a SYNTHETIC log seeded directly into SQLite (insertRun /
// insertPhase / insertEvent for the event fold, insertEnvelope for the
// per-attempt record — no daemon, no FakePi): the runner's event ordering is
// rowid order, so insertion order IS the log order the fold reads. The
// ApiState is built the way server.test.ts builds the daemon's (db + dataDir
// + a stub pool + startedAt).
//
// envelope_attempts derives from the `envelopes` TABLE (R7 resolution:
// #8's `envelope` event fires only on acceptance, so a rejected visit would
// report 0 attempts from events) — those tests seed envelope ROWS per
// attempt, the same source the phase drill-in's attempt list reads.
import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dbPathFor, runDirFor } from "../../src/core/index.ts";
import type { EventType } from "../../src/core/index.ts";
import { cursorEvents, getRun, insertEnvelope, insertEvent, insertPhase, insertRun, openDb } from "../../src/server/repository/db.ts";
import type { PhaseRow, RunRow } from "../../src/server/repository/db.ts";
import { RunPool } from "../../src/server/engine/pool.ts";
import { ApiError, apiTimeline, handleApiRequest } from "../../src/server/services/api.ts";
import type { ApiState } from "../../src/server/services/api.ts";
import type { TimelineView } from "../../src/server/contract.ts";
import { countEnvelopeAttempts, foldPhaseSegments } from "../../src/server/services/timeline.ts";

import { cleanupDir, tmpDataDir } from "./helpers.ts";

interface TimelineEnv {
  dir: string;
  db: ReturnType<typeof openDb>;
  state: ApiState;
}

function makeEnv(label: string): TimelineEnv {
  const dir = tmpDataDir(label);
  const db = openDb(dbPathFor(dir));
  const state: ApiState = { db, dataDir: dir, pool: new RunPool(2), startedAt: Date.now() };
  return { dir, db, state };
}

function closeEnv(env: TimelineEnv): void {
  env.db.close();
  cleanupDir(env.dir);
}

// ── seeding helpers ──────────────────────────────────────────────────────────

/** An ISO ts at `sec` seconds within the synthetic day (rowid order = ts order). */
function ts(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `2025-01-01T00:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.000Z`;
}

function seedRun(state: ApiState, runId: string, overrides: Partial<RunRow> = {}): void {
  insertRun(state.db, {
    id: runId,
    blueprint: "demo",
    status: "success",
    cwd: "/tmp/scratch",
    needs_review: 0,
    started_at: ts(0),
    ended_at: ts(99),
    ...overrides,
  });
}

function seedPhase(state: ApiState, runId: string, phaseId: string, name: string, overrides: Partial<PhaseRow> = {}): void {
  insertPhase(state.db, {
    id: phaseId,
    run_id: runId,
    name,
    agent: "builder",
    status: "success",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: null,
    ended_at: null,
    ...overrides,
  });
}

/** Phase ids are a GLOBAL primary key — scope them per run so sibling runs in
 * the same env never collide. */
function phaseId(runId: string, name: string): string {
  return `${runId}-${name}`;
}

function logEvent(state: ApiState, runId: string, phaseId: string, type: EventType, t: string, data: unknown): number {
  return insertEvent(state.db, { run_id: runId, phase_id: phaseId, agent_session_id: null, type, ts: t, data });
}

/** phase_start with an optional cause — omit the cause to simulate a pre-R2 row. */
function startPhase(
  state: ApiState,
  runId: string,
  phaseId: string,
  name: string,
  visit: number,
  t: string,
  cause?: unknown,
): number {
  return logEvent(state, runId, phaseId, "phase_start", t, {
    phase: name,
    agent: "builder",
    visit,
    budget: 3,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function endPhase(state: ApiState, runId: string, phaseId: string, name: string, visit: number, t: string, status = "success"): number {
  return logEvent(state, runId, phaseId, "phase_end", t, { phase: name, status, visits: visit, corrections: 0, spend_usd: 0 });
}

function correction(state: ApiState, runId: string, phaseId: string, name: string, visit: number, t: string): number {
  return logEvent(state, runId, phaseId, "correction", t, { phase: name, visit, reason: "gate fail", message: "revise" });
}

/** An `envelopes` TABLE row for one attempt — the canonical per-attempt record
 * (valid or rejected), the same source the phase drill-in's attempt list
 * reads. The R7 resolution derives the timeline's envelope_attempts from
 * these rows per (phase_id, visit), NOT from `envelope` events (which
 * fire only on acceptance). Quality < 8 mirrors the demo-loop fixture's
 * gate-rejected review v1 rows: parse-valid (valid=1) with gate violations. */
function envelopeRow(
  state: ApiState,
  runId: string,
  phaseId: string,
  visit: number,
  attempt: number,
  t: string,
  quality = 9,
): void {
  insertEnvelope(state.db, {
    id: `${runId}-${phaseId}-v${visit}-a${attempt}`,
    run_id: runId,
    phase_id: phaseId,
    visit,
    attempt,
    json: JSON.stringify({ summary: "synthetic", quality }),
    source: "synthetic",
    validated_at: t,
    valid: 1,
    violations: quality < 8 ? JSON.stringify([`quality ${quality} is below the required 8`]) : "[]",
    correction: null,
  });
}

function timeline(state: ApiState, runId: string): TimelineView {
  // apiTimeline's return type IS the TimelineView contract (issue #23) — no bridge
  return apiTimeline(state, runId);
}

// ── the R7 acceptance shape ──────────────────────────────────────────────────

test("R7 acceptance: plan/implement/review/package fold into 1/2/2/1 segments with causes, corrections, and envelope attempts from the `envelopes` table (review v1 = 2 rejected rows)", () => {
  const env = makeEnv("timeline-r7");
  try {
    const runId = "r7";
    seedRun(env.state, runId);
    // OUT-OF-ORDER started_at: listPhases (row order) would return
    // plan, review, implement, package — the endpoint must not use it
    seedPhase(env.state, runId, "p-plan", "plan", { started_at: ts(1) });
    seedPhase(env.state, runId, "p-review", "review", { started_at: ts(2) });
    seedPhase(env.state, runId, "p-impl", "implement", { started_at: ts(3) });
    seedPhase(env.state, runId, "p-pkg", "package", { started_at: ts(4) });

    // plan: one clean visit (its single envelope row, quality 9)
    startPhase(env.state, runId, "p-plan", "plan", 1, ts(10), { kind: "flow" });
    envelopeRow(env.state, runId, "p-plan", 1, 0, ts(10));
    endPhase(env.state, runId, "p-plan", "plan", 1, ts(11));

    // implement v1: forward (one envelope row)
    startPhase(env.state, runId, "p-impl", "implement", 1, ts(20), { kind: "flow" });
    envelopeRow(env.state, runId, "p-impl", 1, 0, ts(20));
    endPhase(env.state, runId, "p-impl", "implement", 1, ts(21));

    // review v1: one correction, two envelope attempts, then FAILED — the
    // attempts are `envelopes` TABLE rows (the drill-in's per-attempt
    // record): quality 5 then 6, both gate-rejected (valid=1 rows with
    // violations — exactly the demo-loop fixture's review v1 rows)
    startPhase(env.state, runId, "p-review", "review", 1, ts(30), { kind: "flow" });
    correction(env.state, runId, "p-review", "review", 1, ts(31));
    envelopeRow(env.state, runId, "p-review", 1, 0, ts(32), 5);
    envelopeRow(env.state, runId, "p-review", 1, 1, ts(33), 6);
    endPhase(env.state, runId, "p-review", "review", 1, ts(34), "failed");

    // review v1 failed → on_fail jumps BACK to implement v2 (one row)
    startPhase(env.state, runId, "p-impl", "implement", 2, ts(40), {
      kind: "on_fail",
      from_phase: "review",
      from_visit: 1,
    });
    envelopeRow(env.state, runId, "p-impl", 2, 0, ts(40));
    endPhase(env.state, runId, "p-impl", "implement", 2, ts(41));

    // review v2: reached by forward execution after implement v2 → flow
    startPhase(env.state, runId, "p-review", "review", 2, ts(50), { kind: "flow" });
    envelopeRow(env.state, runId, "p-review", 2, 0, ts(50));
    endPhase(env.state, runId, "p-review", "review", 2, ts(51));

    startPhase(env.state, runId, "p-pkg", "package", 1, ts(60), { kind: "flow" });
    envelopeRow(env.state, runId, "p-pkg", 1, 0, ts(60));
    endPhase(env.state, runId, "p-pkg", "package", 1, ts(61));

    const view = timeline(env.state, runId);
    expect(view.run_id).toBe(runId);
    expect(view.status).toBe("success");
    // blueprint order via the no-snapshot fallback (first phase_start order)
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "implement", "review", "package"]);
    expect(view.phases.map((p) => p.segments.length)).toEqual([1, 2, 2, 1]);

    const plan = view.phases.find((p) => p.name === "plan")!;
    expect(plan.segments[0]!.visit).toBe(1);
    expect(plan.segments[0]!.outcome).toBe("success");
    expect(plan.segments[0]!.ended_at).toBe(ts(11));
    // envelope_attempts counts the `envelopes` TABLE rows per (phase, visit)
    expect(plan.segments[0]!.envelope_attempts).toBe(1);

    const impl = view.phases.find((p) => p.name === "implement")!;
    expect(impl.segments[0]!.cause).toEqual({ kind: "flow" });
    expect(impl.segments[1]!.cause).toEqual({ kind: "on_fail", from_phase: "review", from_visit: 1 });
    expect(impl.segments[1]!.outcome).toBe("success");
    expect(impl.segments[0]!.envelope_attempts).toBe(1); // implement v1: one row
    expect(impl.segments[1]!.envelope_attempts).toBe(1); // implement v2: one row

    const review = view.phases.find((p) => p.name === "review")!;
    expect(review.segments[0]!.outcome).toBe("failed");
    expect(review.segments[0]!.corrections).toBe(1);
    // review v1: TWO rows (attempts 0 + 1, both gate-rejected) — the
    // `envelope` event fires only on acceptance, so only the row count can
    // report the rejected visit's 2 attempts (R7)
    expect(review.segments[0]!.envelope_attempts).toBe(2);
    expect(review.segments[0]!.cause).toEqual({ kind: "flow" });
    expect(review.segments[1]!.cause).toEqual({ kind: "flow" });
    expect(review.segments[1]!.outcome).toBe("success");
    expect(review.segments[1]!.envelope_attempts).toBe(1); // review v2: one row

    const pkg = view.phases.find((p) => p.name === "package")!;
    expect(pkg.segments).toHaveLength(1);
    expect(pkg.segments[0]!.outcome).toBe("success");
    expect(pkg.segments[0]!.envelope_attempts).toBe(1); // package: one row
  } finally {
    closeEnv(env);
  }
});

// ── open / dangling visits (rule 2) ──────────────────────────────────────────

test("an open visit on a running run reads in_progress with ended_at null (paused too)", () => {
  const env = makeEnv("timeline-open");
  try {
    const runId = "open";
    seedRun(env.state, runId, { status: "running", ended_at: null });
    seedPhase(env.state, runId, phaseId(runId, "build"), "build", { status: "in_progress", visits: 1 });
    startPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(10));

    const view = timeline(env.state, runId);
    const seg = view.phases[0]!.segments[0]!;
    expect(seg.outcome).toBe("in_progress");
    expect(seg.ended_at).toBeNull();
    expect(seg.started_at).toBe(ts(10));

    // a paused run also reads in_progress (rule 2: running OR paused)
    const runId2 = "open-paused";
    seedRun(env.state, runId2, { status: "paused", ended_at: null });
    seedPhase(env.state, runId2, phaseId(runId2, "build"), "build", { status: "in_progress", visits: 1 });
    startPhase(env.state, runId2, phaseId(runId2, "build"), "build", 1, ts(10));
    expect(timeline(env.state, runId2).phases[0]!.segments[0]!.outcome).toBe("in_progress");
  } finally {
    closeEnv(env);
  }
});

test("a dangling phase_start reads interrupted once the run is over (interrupted status, or ended_at set)", () => {
  const env = makeEnv("timeline-interrupted");
  try {
    // run interrupted: ended_at null, one dangling start with mid-visit events
    const runId = "int";
    seedRun(env.state, runId, { status: "interrupted", ended_at: null });
    seedPhase(env.state, runId, phaseId(runId, "build"), "build", { status: "in_progress", visits: 1 });
    startPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(10));
    correction(env.state, runId, phaseId(runId, "build"), "build", 1, ts(11));
    envelopeRow(env.state, runId, phaseId(runId, "build"), 1, 0, ts(12));

    const view = timeline(env.state, runId);
    const seg = view.phases[0]!.segments[0]!;
    expect(seg.outcome).toBe("interrupted");
    expect(seg.ended_at).toBeNull();
    expect(seg.corrections).toBe(1);
    expect(seg.envelope_attempts).toBe(1);

    // the rule is "status interrupted, OR ended_at set" — a run that is over
    // any other way (here: success + ended_at) also reads interrupted
    const runId2 = "ended";
    seedRun(env.state, runId2, { status: "success", ended_at: ts(50) });
    seedPhase(env.state, runId2, phaseId(runId2, "build"), "build", { status: "in_progress", visits: 1 });
    startPhase(env.state, runId2, phaseId(runId2, "build"), "build", 1, ts(10));
    expect(timeline(env.state, runId2).phases[0]!.segments[0]!.outcome).toBe("interrupted");
  } finally {
    closeEnv(env);
  }
});

// ── phases with no events ────────────────────────────────────────────────────

test("a skipped phase with no events still appears with empty segments", () => {
  const env = makeEnv("timeline-skipped");
  try {
    const runId = "skip";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, "p-plan", "plan", { started_at: ts(1) });
    startPhase(env.state, runId, "p-plan", "plan", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, "p-plan", "plan", 1, ts(11));
    seedPhase(env.state, runId, "p-skip", "unused", { status: "skipped", visits: 0 });

    const view = timeline(env.state, runId);
    const skipped = view.phases.find((p) => p.name === "unused")!;
    expect(skipped.status).toBe("skipped");
    expect(skipped.segments).toEqual([]);
    // the started phase still folds its segment
    expect(view.phases.find((p) => p.name === "plan")!.segments).toHaveLength(1);
    // started phases come first, never-started (no row started_at) last
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "unused"]);
  } finally {
    closeEnv(env);
  }
});

test("a pending phase with no events has empty segments", () => {
  const env = makeEnv("timeline-pending");
  try {
    const runId = "pend";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, "p-plan", "plan", { started_at: ts(1) });
    startPhase(env.state, runId, "p-plan", "plan", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, "p-plan", "plan", 1, ts(11));
    seedPhase(env.state, runId, "p-pend", "later", { status: "pending", visits: 0 });

    const view = timeline(env.state, runId);
    const pending = view.phases.find((p) => p.name === "later")!;
    expect(pending.status).toBe("pending");
    expect(pending.visits).toBe(0);
    expect(pending.segments).toEqual([]);
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "later"]);
  } finally {
    closeEnv(env);
  }
});

// ── duration / pre-R2 ────────────────────────────────────────────────────────

test("a zero-duration visit (phase_start and phase_end at the same ts) is one closed segment", () => {
  const env = makeEnv("timeline-zero");
  try {
    const runId = "zero";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, "p1", "build", {});
    startPhase(env.state, runId, "p1", "build", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, "p1", "build", 1, ts(10));

    const view = timeline(env.state, runId);
    expect(view.phases[0]!.segments).toHaveLength(1);
    const seg = view.phases[0]!.segments[0]!;
    expect(seg.started_at).toBe(ts(10));
    expect(seg.ended_at).toBe(ts(10)); // non-null: the visit is closed
    expect(seg.outcome).toBe("success");
  } finally {
    closeEnv(env);
  }
});

test("a pre-R2 run (phase_start payload without cause) reports cause null — never reconstructed", () => {
  const env = makeEnv("timeline-prer2");
  try {
    const runId = "old";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, "p1", "build", {});
    startPhase(env.state, runId, "p1", "build", 1, ts(10)); // no cause key
    endPhase(env.state, runId, "p1", "build", 1, ts(11));

    const view = timeline(env.state, runId);
    const seg = view.phases[0]!.segments[0]!;
    expect(seg.cause).toBeNull();
    expect(seg.outcome).toBe("success");
    expect(seg.ended_at).toBe(ts(11));
  } finally {
    closeEnv(env);
  }
});

// ── blueprint order ──────────────────────────────────────────────────────────

test("phases with out-of-order started_at return in blueprint order from the snapshot", () => {
  const env = makeEnv("timeline-order");
  try {
    const runId = "ord";
    seedRun(env.state, runId);
    // started_at in REVERSE blueprint order — row order would be
    // package, review, implement, plan
    seedPhase(env.state, runId, phaseId(runId, "plan"), "plan", { started_at: ts(4) });
    seedPhase(env.state, runId, phaseId(runId, "implement"), "implement", { started_at: ts(3) });
    seedPhase(env.state, runId, phaseId(runId, "review"), "review", { started_at: ts(2) });
    seedPhase(env.state, runId, phaseId(runId, "package"), "package", { started_at: ts(1) });
    // events start review BEFORE plan — event order alone would mis-order
    startPhase(env.state, runId, phaseId(runId, "review"), "review", 1, ts(5), { kind: "flow" });
    startPhase(env.state, runId, phaseId(runId, "plan"), "plan", 1, ts(6), { kind: "flow" });

    // the snapshot: plan, implement, review, package (what actually ran)
    const runDir = runDirFor(env.dir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "blueprint.json"),
      JSON.stringify({
        name: "demo",
        module: null,
        args: null,
        max_visits: 3,
        phases: ["plan", "implement", "review", "package"].map((name) => ({
          name,
          agent: { name: "builder", model: "fake-pi", prompt: "p", tools: [], context: [] },
          budget: 3,
          require_approval: false,
          on_fail: null,
          gates: [],
          envelope: {},
        })),
        hooks: { onPhaseStart: false, onPhaseEnd: false },
      }),
    );

    const view = timeline(env.state, runId);
    expect(view.phases.map((p) => p.name)).toEqual(["plan", "implement", "review", "package"]);
    // the snapshot-driven order wins over the (mis-ordered) event order
    expect(view.phases[0]!.segments).toHaveLength(1); // plan's segment, from its event

    // NO snapshot: the fallback is FIRST phase_start event order — all four
    // phases started, so the events' first-start order wins over row order
    const runId2 = "ord-fallback";
    seedRun(env.state, runId2);
    seedPhase(env.state, runId2, phaseId(runId2, "plan"), "plan", { started_at: ts(2) });
    seedPhase(env.state, runId2, phaseId(runId2, "implement"), "implement", { started_at: ts(1) });
    seedPhase(env.state, runId2, phaseId(runId2, "review"), "review", { started_at: ts(4) });
    seedPhase(env.state, runId2, phaseId(runId2, "package"), "package", { started_at: ts(3) });
    startPhase(env.state, runId2, phaseId(runId2, "review"), "review", 1, ts(5), { kind: "flow" });
    startPhase(env.state, runId2, phaseId(runId2, "plan"), "plan", 1, ts(6), { kind: "flow" });
    startPhase(env.state, runId2, phaseId(runId2, "package"), "package", 1, ts(7), { kind: "flow" });
    startPhase(env.state, runId2, phaseId(runId2, "implement"), "implement", 1, ts(8), { kind: "flow" });
    const view2 = timeline(env.state, runId2);
    expect(view2.phases.map((p) => p.name)).toEqual(["review", "plan", "package", "implement"]);
  } finally {
    closeEnv(env);
  }
});

// ── the resume fold ──────────────────────────────────────────────────────

test("the resume fold: two phase_start events with the SAME visit collapse into one segment", () => {
  const env = makeEnv("timeline-resume");
  try {
    const runId = "resume";
    seedRun(env.state, runId, { ended_at: ts(60), needs_review: 1 });
    seedPhase(env.state, runId, phaseId(runId, "implement"), "implement", { status: "success", visits: 2 });

    // the crashed visit's start (visit 2), a correction, then the resumed
    // visit's start (SAME visit 2), an envelope, then the ONE phase_end
    startPhase(env.state, runId, phaseId(runId, "implement"), "implement", 2, ts(10), { kind: "flow" });
    correction(env.state, runId, phaseId(runId, "implement"), "implement", 2, ts(11));
    startPhase(env.state, runId, phaseId(runId, "implement"), "implement", 2, ts(20), {
      kind: "human",
      action: "resume",
      by: "operator",
    });
    envelopeRow(env.state, runId, phaseId(runId, "implement"), 2, 0, ts(21));
    endPhase(env.state, runId, phaseId(runId, "implement"), "implement", 2, ts(30));

    const view = timeline(env.state, runId);
    expect(view.phases[0]!.segments).toHaveLength(1); // no phantom open segment
    const seg = view.phases[0]!.segments[0]!;
    expect(seg.visit).toBe(2);
    expect(seg.started_at).toBe(ts(10)); // the ORIGINAL start
    expect(seg.ended_at).toBe(ts(30));
    expect(seg.outcome).toBe("success");
    expect(seg.cause).toEqual({ kind: "flow" }); // the FIRST start's cause
    expect(seg.corrections).toBe(1); // both visit-2 events land in the one segment
    expect(seg.envelope_attempts).toBe(1);
    expect(view.needs_review).toBe(true); // needs_review pin

    // a second crash before the resume completes: still ONE segment, and rule
    // 2 makes the collapsed open segment read interrupted
    const runId2 = "resume-again";
    seedRun(env.state, runId2, { status: "interrupted", ended_at: null });
    seedPhase(env.state, runId2, phaseId(runId2, "implement"), "implement", { status: "in_progress", visits: 2 });
    startPhase(env.state, runId2, phaseId(runId2, "implement"), "implement", 2, ts(10), { kind: "flow" });
    startPhase(env.state, runId2, phaseId(runId2, "implement"), "implement", 2, ts(20), {
      kind: "human",
      action: "resume",
      by: "operator",
    });
    const view2 = timeline(env.state, runId2);
    expect(view2.phases[0]!.segments).toHaveLength(1);
    expect(view2.phases[0]!.segments[0]!.outcome).toBe("interrupted");
    expect(view2.phases[0]!.segments[0]!.started_at).toBe(ts(10));
    expect(view2.phases[0]!.segments[0]!.cause).toEqual({ kind: "flow" });
  } finally {
    closeEnv(env);
  }
});

test("a redrive from a blocked pause (start v1 with no end, then start v2) keeps v1 as an open segment per rule 2", () => {
  const env = makeEnv("timeline-blocked");
  try {
    const runId = "blocked";
    seedRun(env.state, runId, { ended_at: ts(60) });
    seedPhase(env.state, runId, "p1", "build", { status: "success", visits: 2 });

    // the runner re-enters the visit loop with a NEW visit and emits NO
    // phase_end for the blocked one — v1 pairs with nothing, v2 with the end
    startPhase(env.state, runId, "p1", "build", 1, ts(10), { kind: "flow" });
    startPhase(env.state, runId, "p1", "build", 2, ts(20), { kind: "human", action: "restart", by: "operator" });
    endPhase(env.state, runId, "p1", "build", 2, ts(30));

    const view = timeline(env.state, runId);
    expect(view.phases[0]!.segments).toHaveLength(2);
    const v1 = view.phases[0]!.segments[0]!;
    expect(v1.visit).toBe(1);
    expect(v1.ended_at).toBeNull(); // the blocked visit never ended
    expect(v1.outcome).toBe("interrupted"); // run over → rule 2
    const v2 = view.phases[0]!.segments[1]!;
    expect(v2.visit).toBe(2);
    expect(v2.outcome).toBe("success");
  } finally {
    closeEnv(env);
  }
});

// ── the wire route + 404 ─────────────────────────────────────────────────────

test("GET /runs/:id/timeline serves the derived timeline; a missing run 404s on the wire", async () => {
  const env = makeEnv("timeline-wire");
  try {
    const runId = "wire";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, "p1", "build", {});
    startPhase(env.state, runId, "p1", "build", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, "p1", "build", 1, ts(11));

    const ok = await handleApiRequest(env.state, new Request(`http://127.0.0.1/api/runs/${runId}/timeline`));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as TimelineView;
    expect(body.run_id).toBe(runId);
    expect(body.phases[0]!.segments).toHaveLength(1);
    expect(body.phases[0]!.segments[0]!.outcome).toBe("success");

    const missing = await handleApiRequest(env.state, new Request("http://127.0.0.1/api/runs/ghost/timeline"));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "run ghost not found" });
  } finally {
    closeEnv(env);
  }
});

test("a missing run 404s from the core function (ApiError with status 404)", () => {
  const env = makeEnv("timeline-404");
  try {
    let caught: unknown;
    try {
      apiTimeline(env.state, "ghost");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
    expect((caught as ApiError).message).toBe("run ghost not found");
  } finally {
    closeEnv(env);
  }
});

// ── the module boundary: the fold's own signature (src/daemon/timeline.ts) ──
// The endpoint tests above drive apiTimeline + handleApiRequest (the wire
// route stays pinned); these call the derivation functions directly at the
// module boundary — the same helpers, the same seeded SQLite.

function foldedSegments(state: ApiState, runId: string) {
  const run = getRun(state.db, runId)!;
  const events = cursorEvents(state.db, runId, 0, 10_000);
  return foldPhaseSegments(run, events, countEnvelopeAttempts(state.db, runId));
}

test("the fold: an unexpected phase_end status reads failed (terminal but not a pass)", () => {
  const env = makeEnv("timeline-fold-failed");
  try {
    const runId = "fold-fail";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, phaseId(runId, "build"), "build", {});
    startPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(11), "unexpected-status");

    const segs = foldedSegments(env.state, runId).get(phaseId(runId, "build"))!;
    expect(segs).toHaveLength(1);
    expect(segs[0]!.ended_at).toBe(ts(11)); // the end still closes the segment
    expect(segs[0]!.outcome).toBe("failed");
  } finally {
    closeEnv(env);
  }
});

test("the fold: a dangling phase_end with no open segment produces nothing", () => {
  const env = makeEnv("timeline-fold-dangling");
  try {
    const runId = "fold-dangle";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, phaseId(runId, "build"), "build", {});
    // the dangling end pairs with nothing (rule 1: starts pair with ends,
    // never ends alone) — no phantom segment
    endPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(5));
    // a real pair after it still folds normally
    startPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, phaseId(runId, "build"), "build", 1, ts(11));

    const segs = foldedSegments(env.state, runId).get(phaseId(runId, "build"))!;
    expect(segs).toHaveLength(1);
    expect(segs[0]!.started_at).toBe(ts(10));
    expect(segs[0]!.outcome).toBe("success");
  } finally {
    closeEnv(env);
  }
});

test("countEnvelopeAttempts: per-(phase, visit) attempt counts from the envelopes table, empty for a run with none", () => {
  const env = makeEnv("timeline-fold-attempts");
  try {
    const runId = "fold-attempts";
    seedRun(env.state, runId);
    // no envelope rows yet → the empty map
    expect(countEnvelopeAttempts(env.state.db, runId).size).toBe(0);

    // the envelopes table FKs to phases — the phases must exist to hold rows
    seedPhase(env.state, runId, phaseId(runId, "plan"), "plan", {});
    seedPhase(env.state, runId, phaseId(runId, "review"), "review", {});

    envelopeRow(env.state, runId, phaseId(runId, "plan"), 1, 0, ts(10));
    envelopeRow(env.state, runId, phaseId(runId, "plan"), 1, 1, ts(11));
    envelopeRow(env.state, runId, phaseId(runId, "plan"), 2, 0, ts(20));
    envelopeRow(env.state, runId, phaseId(runId, "review"), 1, 0, ts(30));

    const counts = countEnvelopeAttempts(env.state.db, runId);
    expect(counts.size).toBe(2); // plan + review only
    expect([...counts.keys()].sort()).toEqual([phaseId(runId, "plan"), phaseId(runId, "review")].sort());
    expect(counts.get(phaseId(runId, "plan"))!.get(1)).toBe(2); // plan v1: attempts 0 + 1
    expect(counts.get(phaseId(runId, "plan"))!.get(2)).toBe(1); // plan v2: one row
    expect(counts.get(phaseId(runId, "review"))!.get(1)).toBe(1);
    expect(counts.get(phaseId(runId, "package"))).toBeUndefined(); // no rows for it
  } finally {
    closeEnv(env);
  }
});

test("the fold's own signature: per-visit pairing and the resume collapse", () => {
  const env = makeEnv("timeline-fold-signature");
  try {
    const runId = "fold-sig";
    seedRun(env.state, runId);
    seedPhase(env.state, runId, phaseId(runId, "impl"), "impl", { status: "success", visits: 2 });

    // visit 1 pairs with its end; then the resume fold: TWO same-visit
    // starts collapse into ONE segment (original started_at + first cause)
    startPhase(env.state, runId, phaseId(runId, "impl"), "impl", 1, ts(10), { kind: "flow" });
    endPhase(env.state, runId, phaseId(runId, "impl"), "impl", 1, ts(20));
    startPhase(env.state, runId, phaseId(runId, "impl"), "impl", 2, ts(30), { kind: "flow" });
    startPhase(env.state, runId, phaseId(runId, "impl"), "impl", 2, ts(40), {
      kind: "human",
      action: "resume",
      by: "operator",
    });
    endPhase(env.state, runId, phaseId(runId, "impl"), "impl", 2, ts(50));

    const segs = foldedSegments(env.state, runId).get(phaseId(runId, "impl"))!;
    expect(segs).toHaveLength(2); // one per VISIT — no phantom open segment
    expect(segs[0]!.visit).toBe(1);
    expect(segs[0]!.started_at).toBe(ts(10));
    expect(segs[0]!.ended_at).toBe(ts(20));
    expect(segs[0]!.outcome).toBe("success");
    expect(segs[1]!.visit).toBe(2);
    expect(segs[1]!.started_at).toBe(ts(30)); // the ORIGINAL start
    expect(segs[1]!.ended_at).toBe(ts(50));
    expect(segs[1]!.outcome).toBe("success");
    expect(segs[1]!.cause).toEqual({ kind: "flow" }); // the FIRST start's cause
  } finally {
    closeEnv(env);
  }
});
