process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * T10a acceptance e2e (issue #15) + R4/R5: the run detail page with
 * the R3/R4/R5 timeline rendered from REAL daemon data — server-side first,
 * driven through the app router with `router.fetch(...)` (the same hermetic
 * pattern as T09/T11; there is no DOM click harness, so selection is tested
 * through the pure model (test/ui/timeline-model.test.ts) and through the
 * query-param-driven SSR deep link `?phase=` below). The live loop's ~1s poll
 * is exercised at the proxy seam: feed the daemon more events, poll events.json
 * with the advancing cursor, assert they appear — the same sliding-window
 * query the hydrated clientEntry runs (POLL_MS = 1000).
 *
 * The rich scenario is SEEDED directly into the daemon's DB (after daemon
 * start, so startup reconciliation cannot flip the running/paused
 * rows): a paused run with needs_review and a full event spread
 * (corrections, gates, tool calls, human action, spend, lifecycle), plus a
 * running run for the live now-cursor/status pill, plus a redrive run whose
 * review failed and sent execution back (R4 revisit arrow + R5 on_fail
 * banner).
 *
 * Hermetic: scratch data dirs, in-process daemon, closed in finally, no
 * residue.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbPathFor, type EventType } from "../../src/core/index.ts";
import { DaemonClient } from "../../src/daemon/client.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/daemon.ts";
import {
  insertAgentSession,
  insertEnvelope,
  insertEvent,
  insertGateResult,
  insertPhase,
  insertRun,
  openDb,
} from "../../src/daemon/db.ts";
import { router } from "../../src/ui/app/router.ts";
import { routes } from "../../src/ui/app/routes.ts";

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-${label}-`));
}

function setDataDir(dir: string): () => void {
  const saved = process.env.SHOWRUNNER_DATA_DIR;
  process.env.SHOWRUNNER_DATA_DIR = dir;
  return () => {
    if (saved === undefined) delete process.env.SHOWRUNNER_DATA_DIR;
    else process.env.SHOWRUNNER_DATA_DIR = saved;
  };
}

async function fetchDetail(runId: string): Promise<{ status: number; html: string }> {
  return fetchDetailUrl(routes.runs.show.href({ runId }));
}

/** SSR fetch of the run detail page with an arbitrary path (e.g. ?phase=). */
async function fetchDetailUrl(path: string): Promise<{ status: number; html: string }> {
  const response = await router.fetch(new Request("http://localhost" + path));
  return { status: response.status, html: await response.text() };
}

async function fetchEvents(runId: string, cursor: number): Promise<{ status: number; json: unknown }> {
  const response = await router.fetch(
    new Request("http://localhost" + routes.runs.events.href({ runId }) + `?cursor=${cursor}`),
  );
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // keep raw text below
  }
  return { status: response.status, json };
}

/** SSR fetch of the R5 envelopes.json / gates.json proxies. */
async function fetchPhaseProxy(
  runId: string,
  phase: string,
  kind: "envelopes" | "gates",
): Promise<{ status: number; json: unknown }> {
  const href =
    kind === "envelopes"
      ? routes.runs.phases.envelopes.href({ runId, phase })
      : routes.runs.phases.gates.href({ runId, phase });
  const response = await router.fetch(new Request("http://localhost" + href));
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // keep raw text below
  }
  return { status: response.status, json };
}

/** SSR fetch of the R6 timeline.json refetch proxy (the hydrated region
 * polls this alongside events.json on every tick). */
async function fetchTimeline(runId: string): Promise<{ status: number; json: unknown }> {
  const response = await router.fetch(new Request("http://localhost" + routes.runs.timeline.href({ runId })));
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // keep raw text below
  }
  return { status: response.status, json };
}

// ── the seeded scenario ──────────────────────────────────────────────────────

const RUN_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // paused + needs_review
const RUN_B = "bbbb2222-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // running
const RUN_C = "cccc3333-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // paused redrive (review failed → implement v2)
const RUN_D = "dddd4444-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // interrupted (R6: open segment → amber)
const T0 = Date.now() - 10 * 60_000; // run A started 10 min ago
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** Seed run A: 3 phases (plan ✓, build in-flight paused, ship pending) + the
 * full event spread; run B: 1 in-flight phase + a few events; run C: the
 * redrive (implement v2 caused by review v1 failing). The phase_start events
 * carry the R2 cause payloads the timeline fold copies verbatim. */
function seedDetailData(dir: string): void {
  const db = openDb(dbPathFor(dir));

  insertRun(db, {
    id: RUN_A,
    blueprint: "plan_build",
    status: "paused",
    cwd: "/tmp/scratch",
    needs_review: 1,
    started_at: iso(0),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-plan",
    run_id: RUN_A,
    name: "plan",
    agent: "planner",
    status: "success",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0.12,
    started_at: iso(5_000),
    ended_at: iso(5 * 60_000),
  });
  insertPhase(db, {
    id: "ph-build",
    run_id: RUN_A,
    name: "build",
    agent: "builder",
    status: "in_progress",
    visits: 2,
    corrections: 2,
    budget: 3,
    spend_usd: 0.3,
    started_at: iso(5 * 60_000 + 5_000),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-ship",
    run_id: RUN_A,
    name: "ship",
    agent: "shipper",
    status: "pending",
    visits: 0,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: null,
    ended_at: null,
  });

  // spread, oldest → newest (rowid = cursor)
  const ev = (
    type: EventType,
    data: unknown,
    offsetMs: number,
    opts: { phaseId?: string | null } = {},
  ): void => {
    insertEvent(db, {
      run_id: RUN_A,
      phase_id: opts.phaseId ?? null,
      agent_session_id: null,
      type,
      ts: iso(offsetMs),
      data,
    });
  };
  ev("run_submitted", { blueprint: "plan_build", cwd: "/tmp/scratch" }, 0);
  ev("phase_start", { phase: "plan", agent: "planner", visit: 1, budget: 3, cause: { kind: "flow" } }, 5_000, { phaseId: "ph-plan" });
  ev("agent_start", { agent: "planner", pi_session_id: "s-plan", pid: 1001, model: "deepseek-v4-pro" }, 6_000, { phaseId: "ph-plan" });
  ev("tool_call", { tool: "bash", tool_call_id: "t1", args: "ls -la src", result_snippet: "src/\nindex.ts\n", ok: true, duration_ms: 400, agent: "planner" }, 10_000, { phaseId: "ph-plan" });
  ev("envelope", { phase: "plan", visit: 1, attempt: 1, valid: true }, 30_000, { phaseId: "ph-plan" });
  ev("gate_result", { gate: "testsPass", pass: true, violations: [] }, 31_000, { phaseId: "ph-plan" });
  ev("phase_end", { phase: "plan", status: "success", visits: 1, corrections: 0, spend_usd: 0.12 }, 5 * 60_000, { phaseId: "ph-plan" });
  ev("phase_start", { phase: "build", agent: "builder", visit: 1, budget: 3, cause: { kind: "human", action: "restart", by: "operator" } }, 5 * 60_000 + 5_000, { phaseId: "ph-build" });
  ev("agent_start", { agent: "builder", pi_session_id: "s-build", pid: 1002, model: "fake-pi" }, 5 * 60_000 + 6_000, { phaseId: "ph-build" });
  ev("tool_call", { tool: "bash", tool_call_id: "t2", args: "npm test -- --run", result_snippet: "# fail 2\n", ok: false, duration_ms: 4_200, agent: "builder" }, 5 * 60_000 + 10_000, { phaseId: "ph-build" });
  ev("gate_result", { gate: "testsPass", pass: false, violations: ["expected 3 tests, got 2"] }, 5 * 60_000 + 11_000, { phaseId: "ph-build" });
  ev("correction", { phase: "build", visit: 1, reason: "gate testsPass failed", message: "tests failed: expected 3, got 2 — fix t1" }, 5 * 60_000 + 12_000, { phaseId: "ph-build" });
  ev("agent_end", { agent: "builder", pi_session_id: "s-build", exit: 0, ok: true }, 5 * 60_000 + 20_000, { phaseId: "ph-build" });
  ev("spend", { phase: "build", tokens_in: 500, tokens_out: 120, cache_read: 0, cache_write: 0, usd: 0.0021, estimated: false }, 5 * 60_000 + 21_000, { phaseId: "ph-build" });
  // visit 2: a second phase_start + a second correction — the event stream is
  // what the timeline derives corrections/visits from, so it must match the row
  ev("phase_start", { phase: "build", agent: "builder", visit: 2, budget: 3, cause: { kind: "flow" } }, 5 * 60_000 + 40_000, { phaseId: "ph-build" });
  ev("correction", { phase: "build", visit: 2, reason: "gate testsPass failed", message: "tests failed: expected 3, got 2 — fix t2" }, 5 * 60_000 + 50_000, { phaseId: "ph-build" });
  ev("run_status", { from: "running", to: "paused", reason: "correction budget exhausted (2/3)" }, 7 * 60_000);
  ev("human_action", { action: "steer", by: "operator", detail: "fix the failing test, then re-run the suite" }, 7 * 60_000 + 1_000);

  // envelope + gate rows for the R5 panel (the detail endpoint's envelopes /
  // gates endpoints read these tables, not the event stream): plan got one
  // rejected attempt (with the correction that followed) then a valid one;
  // build has one failed gate result
  insertEnvelope(db, {
    id: "env-plan-0",
    run_id: RUN_A,
    phase_id: "ph-plan",
    visit: 1,
    attempt: 0,
    json: "not json",
    source: "plan/envelope.json",
    validated_at: iso(29_000),
    valid: 0,
    violations: JSON.stringify(["envelope did not parse"]),
    correction: "envelope did not parse — resubmit a valid envelope",
  });
  insertEnvelope(db, {
    id: "env-plan-1",
    run_id: RUN_A,
    phase_id: "ph-plan",
    visit: 1,
    attempt: 1,
    json: JSON.stringify({
      summary: "scoped the plan",
      artifacts: ["plan.md"],
      notes_for_next_agent: "build per the plan",
    }),
    source: "plan/envelope.json",
    validated_at: iso(30_000),
    valid: 1,
    violations: "[]",
    correction: null,
  });
  insertGateResult(db, {
    id: "gr-plan-1",
    envelope_id: "env-plan-1",
    gate: "testsPass",
    pass: 1,
    violations: "[]",
    ran_at: iso(31_000),
  });
  // build: one rejected envelope (the gate failed) + its failed gate result
  insertEnvelope(db, {
    id: "env-build-0",
    run_id: RUN_A,
    phase_id: "ph-build",
    visit: 1,
    attempt: 0,
    json: "not json",
    source: "build/envelope.json",
    validated_at: iso(5 * 60_000 + 10_000),
    valid: 0,
    violations: JSON.stringify(["expected 3 tests, got 2"]),
    correction: "tests failed: expected 3, got 2 — fix t1",
  });
  insertGateResult(db, {
    id: "gr-build-1",
    envelope_id: "env-build-0",
    gate: "testsPass",
    pass: 0,
    violations: JSON.stringify(["expected 3 tests, got 2"]),
    ran_at: iso(5 * 60_000 + 11_000),
  });

  // agent sessions for the R5 panel (the sessions table, not the events)
  insertAgentSession(db, {
    id: "sess-plan",
    run_id: RUN_A,
    phase_id: "ph-plan",
    pi_session_id: "s-plan",
    visit: 1,
    pid: 1001,
    started_at: iso(6_000),
    ended_at: iso(5 * 60_000),
  });
  insertAgentSession(db, {
    id: "sess-build-1",
    run_id: RUN_A,
    phase_id: "ph-build",
    pi_session_id: "s-build",
    visit: 1,
    pid: 1002,
    started_at: iso(5 * 60_000 + 6_000),
    ended_at: iso(5 * 60_000 + 20_000),
  });
  insertAgentSession(db, {
    id: "sess-build-2",
    run_id: RUN_A,
    phase_id: "ph-build",
    pi_session_id: "s-build2",
    visit: 2,
    pid: 1003,
    started_at: iso(5 * 60_000 + 41_000),
    ended_at: null,
  });

  // run B — running, no needs_review
  const t0b = T0 - 5 * 60_000;
  const isob = (offsetMs: number): string => new Date(t0b + offsetMs).toISOString();
  insertRun(db, {
    id: RUN_B,
    blueprint: "build_test",
    status: "running",
    cwd: "/tmp/scratch-b",
    needs_review: 0,
    started_at: isob(0),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-b",
    run_id: RUN_B,
    name: "build",
    agent: "builder",
    status: "in_progress",
    visits: 1,
    corrections: 1,
    budget: 3,
    spend_usd: 0.05,
    started_at: isob(5_000),
    ended_at: null,
  });
  insertEvent(db, {
    run_id: RUN_B,
    phase_id: "ph-b",
    agent_session_id: null,
    type: "run_submitted",
    ts: isob(0),
    data: { blueprint: "build_test", cwd: "/tmp/scratch-b" },
  });
  insertEvent(db, {
    run_id: RUN_B,
    phase_id: "ph-b",
    agent_session_id: null,
    type: "phase_start",
    ts: isob(5_000),
    // no cause — a pre-R2 event: the timeline reports cause null, and the
    // panel renders the "reason not recorded" line
    data: { phase: "build", agent: "builder", visit: 1, budget: 3 },
  });
  insertEvent(db, {
    run_id: RUN_B,
    phase_id: "ph-b",
    agent_session_id: null,
    type: "agent_start",
    ts: isob(6_000),
    data: { agent: "builder", pi_session_id: "s-b", pid: 2001, model: "fake-pi" },
  });

  // run C — the R4/R5 redrive: review v1 failed and sent execution back to
  // implement (v2), which is in flight when the run pauses
  const t0c = T0 - 3 * 60_000;
  const isoc = (offsetMs: number): string => new Date(t0c + offsetMs).toISOString();
  insertRun(db, {
    id: RUN_C,
    blueprint: "build_review",
    status: "paused",
    cwd: "/tmp/scratch-c",
    needs_review: 0,
    started_at: isoc(0),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-impl-c",
    run_id: RUN_C,
    name: "implement",
    agent: "builder",
    status: "in_progress",
    visits: 2,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: isoc(5_000),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-rev-c",
    run_id: RUN_C,
    name: "review",
    agent: "reviewer",
    status: "failed",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0,
    started_at: isoc(60_000),
    ended_at: isoc(90_000),
  });
  const evc = (type: EventType, data: unknown, offsetMs: number, phaseId: string | null): void => {
    insertEvent(db, { run_id: RUN_C, phase_id: phaseId, agent_session_id: null, type, ts: isoc(offsetMs), data });
  };
  evc("run_submitted", { blueprint: "build_review", cwd: "/tmp/scratch-c" }, 0, null);
  evc("phase_start", { phase: "implement", agent: "builder", visit: 1, budget: 3, cause: { kind: "flow" } }, 5_000, "ph-impl-c");
  evc("phase_end", { phase: "implement", status: "success", visits: 1, corrections: 0, spend_usd: 0 }, 50_000, "ph-impl-c");
  evc("phase_start", { phase: "review", agent: "reviewer", visit: 1, budget: 3, cause: { kind: "flow" } }, 60_000, "ph-rev-c");
  evc("phase_end", { phase: "review", status: "failed", visits: 1, corrections: 0, spend_usd: 0 }, 90_000, "ph-rev-c");
  evc("phase_start", { phase: "implement", agent: "builder", visit: 2, budget: 3, cause: { kind: "on_fail", from_phase: "review", from_visit: 1 } }, 100_000, "ph-impl-c");
  evc("run_status", { from: "running", to: "paused", reason: "review failed its gates" }, 200_000, null);

  // run D — interrupted (R6): a dangling phase_start on a run the daemon
  // died on — R3 rule 2 reports the open segment as
  // interrupted, and the run awaits a human resume (the resume header action)
  const t0d = T0 - 2 * 60_000;
  const isod = (offsetMs: number): string => new Date(t0d + offsetMs).toISOString();
  insertRun(db, {
    id: RUN_D,
    blueprint: "plan_build",
    status: "interrupted",
    cwd: "/tmp/scratch-d",
    needs_review: 1,
    started_at: isod(0),
    ended_at: null,
  });
  insertPhase(db, {
    id: "ph-plan-d",
    run_id: RUN_D,
    name: "plan",
    agent: "planner",
    status: "in_progress",
    visits: 1,
    corrections: 0,
    budget: 3,
    spend_usd: 0.02,
    started_at: isod(5_000),
    ended_at: null,
  });
  insertEvent(db, {
    run_id: RUN_D,
    phase_id: "ph-plan-d",
    agent_session_id: null,
    type: "run_submitted",
    ts: isod(0),
    data: { blueprint: "plan_build", cwd: "/tmp/scratch-d" },
  });
  insertEvent(db, {
    run_id: RUN_D,
    phase_id: "ph-plan-d",
    agent_session_id: null,
    type: "phase_start",
    ts: isod(5_000),
    data: { phase: "plan", agent: "planner", visit: 1, budget: 3, cause: { kind: "flow" } },
  });

  db.close();
}

// ── assertion helpers for the rendered timeline ──────────────────────────────

/** The rendered timeline+panel region (everything before the live feed). */
function timelineRegion(html: string): string {
  return html.slice(html.indexOf('data-testid="timeline"'), html.indexOf("live feed"));
}

describe("run detail (T10a + R4/R5) — server-side daemon data + the cursor proxy", () => {
  it("R5 proxies: envelopes.json / gates.json serve a phase's data for the panel's lazy fetch, and 404 for a ghost phase", async () => {
    const dir = tmpDir("detail-proxies");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      // build has one rejected envelope → the attempt history
      const buildEnv = await fetchPhaseProxy(RUN_A, "build", "envelopes");
      expect(buildEnv.status).toBe(200);
      const buildEnvBody = buildEnv.json as { phase: string; envelopes: { visit: number; attempt: number; valid: number }[] };
      expect(buildEnvBody.phase).toBe("build");
      expect(buildEnvBody.envelopes.map((e) => [e.visit, e.attempt, e.valid])).toEqual([[1, 0, 0]]);

      // ship has no envelopes — still a 200 with an empty history
      const shipEnv = await fetchPhaseProxy(RUN_A, "ship", "envelopes");
      expect(shipEnv.status).toBe(200);
      expect((shipEnv.json as { envelopes: unknown[] }).envelopes).toHaveLength(0);

      // plan's envelopes: all attempts, ordered visit → attempt
      const planEnv = await fetchPhaseProxy(RUN_A, "plan", "envelopes");
      expect(planEnv.status).toBe(200);
      const planEnvBody = planEnv.json as { envelopes: { visit: number; attempt: number; valid: number }[] };
      expect(planEnvBody.envelopes.map((e) => [e.visit, e.attempt, e.valid])).toEqual([
        [1, 0, 0],
        [1, 1, 1],
      ]);

      // gates mirror: build's failed testsPass with violations
      const buildGates = await fetchPhaseProxy(RUN_A, "build", "gates");
      expect(buildGates.status).toBe(200);
      const buildGatesBody = buildGates.json as { gates: { gate: string; pass: number }[] };
      expect(buildGatesBody.gates.map((g) => [g.gate, g.pass])).toEqual([["testsPass", 0]]);

      // a ghost phase 404s as JSON (the panel shows the error state)
      const ghost = await fetchPhaseProxy(RUN_A, "ghost", "envelopes");
      expect(ghost.status).toBe(404);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("live loop seam: the events.json cursor proxy streams new events as the run progresses (same query, sliding window, ~1s cadence)", async () => {
    const dir = tmpDir("detail-poll");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      // the clientEntry's first poll: full history from cursor 0
      const first = await fetchEvents(RUN_A, 0);
      expect(first.status).toBe(200);
      const page1 = first.json as { events: { id: number }[]; next_cursor: number };
      expect(page1.events).toHaveLength(18);
      expect(page1.next_cursor).toBe(18);

      // the run progresses: new events land in the daemon's DB (a second
      // writer through WAL — the same transport the daemon itself uses)
      const db = openDb(dbPathFor(dir));
      const t = new Date().toISOString();
      insertEvent(db, { run_id: RUN_A, phase_id: "ph-build", agent_session_id: null, type: "tool_call", ts: t, data: { tool: "bash", tool_call_id: "t3", args: "ls ~/.showrunner/runs/<run>/build/inputs", result_snippet: "envelope.json\nplan.md\n", ok: true, duration_ms: 120, agent: "builder" } });
      insertEvent(db, { run_id: RUN_A, phase_id: "ph-build", agent_session_id: null, type: "spend", ts: t, data: { phase: "build", tokens_in: 200, tokens_out: 40, cache_read: 0, cache_write: 0, usd: 0.0009, estimated: false } });
      db.close();

      // next poll from the returned cursor → ONLY the new events (≤ ~1s later)
      const second = await fetchEvents(RUN_A, page1.next_cursor);
      const page2 = second.json as { events: { id: number; type: string }[]; next_cursor: number };
      expect(page2.events).toHaveLength(2);
      expect(page2.events[0]!.id).toBeGreaterThan(page1.next_cursor);
      expect(page2.events[1]!.id).toBeGreaterThan(page2.events[0]!.id);
      expect(page2.events.map((e) => e.type)).toEqual(["tool_call", "spend"]);
      expect(page2.next_cursor).toBe(page2.events[1]!.id);

      // idempotent at the tail: a third poll with the new cursor returns nothing
      const third = await fetchEvents(RUN_A, page2.next_cursor);
      const page3 = third.json as { events: unknown[]; next_cursor: number };
      expect(page3.events).toHaveLength(0);
      expect(page3.next_cursor).toBe(page2.next_cursor);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("404s with a back-link for a ghost run (page + proxy)", async () => {
    const dir = tmpDir("detail-404");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const ghost = "99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

      const page = await fetchDetail(ghost);
      expect(page.status).toBe(404);
      expect(page.html).toContain("not found");
      expect(page.html).toContain(`run ${ghost} not found`);
      expect(page.html).toContain("back to runs");
      expect(page.html).toContain(routes.home.href());

      const proxy = await fetchEvents(ghost, 0);
      expect(proxy.status).toBe(404);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders real daemon data against an in-process daemon (the old daemon-down shell is impossible)", async () => {
    const dir = tmpDir("detail-in-process");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const res = await fetchDetail(RUN_A);
      expect(res.status).toBe(200);
      expect(res.html).toContain("plan_build");
      expect(res.html).toContain('data-status="paused"');
      expect(res.html).toContain("‹ runs"); // the shell still renders
      expect(res.html).toContain('data-testid="timeline"'); // R4 chart on the page
      expect(res.html).not.toContain("daemon is not running");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R6: the timeline.json proxy serves the fresh R3 view (blueprint order, open segments, R2 causes) and 404s for a ghost run", async () => {
    const dir = tmpDir("detail-timeline-proxy");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const first = await fetchTimeline(RUN_A);
      expect(first.status).toBe(200);
      const v1 = first.json as {
        run_id: string;
        status: string;
        ended_at: string | null;
        phases: { name: string; status: string; segments: { visit: number; outcome: string; cause: unknown }[] }[];
      };
      expect(v1.run_id).toBe(RUN_A);
      expect(v1.status).toBe("paused");
      expect(v1.ended_at).toBeNull();
      // blueprint order, fixed server-side — the chart's row order
      expect(v1.phases.map((p) => p.name)).toEqual(["plan", "build", "ship"]);
      const build = v1.phases.find((p) => p.name === "build")!;
      expect(build.segments).toHaveLength(2);
      expect(build.segments.map((s) => [s.visit, s.outcome])).toEqual([
        [1, "in_progress"],
        [2, "in_progress"],
      ]);
      // the R2 cause payload rides verbatim onto the segment
      expect(build.segments[1]!.cause).toEqual({ kind: "flow" });

      // a ghost run 404s as JSON — the live region stops polling on a 404
      const ghost = await fetchTimeline("99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
      expect(ghost.status).toBe(404);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R6 poll refetch seam: the running page's timeline.json grows a new segment after the daemon's DB gains a revisit phase_start (the hydrated region's per-tick refetch)", async () => {
    const dir = tmpDir("detail-timeline-refetch");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      // the page the hydrated region would be polling: RUN_B (running)
      const page = await fetchDetail(RUN_B);
      expect(page.status).toBe(200);

      const before = await fetchTimeline(RUN_B);
      expect(before.status).toBe(200);
      const v1 = before.json as { status: string; phases: { name: string; segments: unknown[] }[] };
      expect(v1.status).toBe("running");
      expect(v1.phases.map((p) => p.name)).toEqual(["build"]);
      expect(v1.phases[0]!.segments).toHaveLength(1);

      // the run progresses: a REVISIT — a second phase_start for the same
      // phase lands in the daemon's DB (the same WAL write the loop uses)
      const db = openDb(dbPathFor(dir));
      const t = new Date().toISOString();
      insertEvent(db, {
        run_id: RUN_B,
        phase_id: "ph-b",
        agent_session_id: null,
        type: "phase_start",
        ts: t,
        data: { phase: "build", agent: "builder", visit: 2, budget: 3, cause: { kind: "on_fail", from_phase: "review", from_visit: 1 } },
      });
      db.close();

      // the next poll of timeline.json (the region replaces its snapshot) →
      // the response now contains the new segment, row order unchanged
      const after = await fetchTimeline(RUN_B);
      expect(after.status).toBe(200);
      const v2 = after.json as { phases: { name: string; segments: { visit: number; outcome: string; cause: unknown }[] }[] };
      expect(v2.phases.map((p) => p.name)).toEqual(["build"]);
      expect(v2.phases[0]!.segments).toHaveLength(2);
      expect(v2.phases[0]!.segments.map((s) => [s.visit, s.outcome])).toEqual([
        [1, "in_progress"],
        [2, "in_progress"],
      ]);
      expect(v2.phases[0]!.segments[1]!.cause).toEqual({ kind: "on_fail", from_phase: "review", from_visit: 1 });
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R6 paused: the active bubble carries the striped paused treatment and the pause reason surfaces in the panel header (and the pause menu)", async () => {
    const dir = tmpDir("detail-paused-r6");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const { status, html } = await fetchDetail(RUN_A);
      expect(status).toBe(200);
      const tl = timelineRegion(html);

      // the ACTIVE bubble — build visit 2 (the phase's current in_progress
      // segment) — carries the paused treatment; the earlier open visit does not
      expect(tl).toMatch(/data-segment data-phase="build" data-visit="2" data-outcome="in_progress" data-segment-paused="true"/);
      expect(tl).toMatch(/data-segment data-phase="build" data-visit="1" data-outcome="in_progress" data-segment-paused="false"/);
      // the stripe overlay element renders on exactly the active bubble
      expect((tl.match(/data-paused-stripe/g) ?? []).length).toBe(1);

      // the pause reason surfaces in the PANEL HEADER — the R6 choice: the
      // pause viewer's reason (seeded here via the run_status → paused
      // event, which is the pause viewer's fallback source)
      expect(tl).toContain("data-panel-pause-reason");
      const banner = tl.slice(tl.indexOf("data-panel-pause-reason"), tl.indexOf("data-panel-pause-reason") + 120);
      expect(banner).toContain("⏸ paused — correction budget exhausted (2/3)");

      // the pause menu (above the region) still surfaces it too
      expect(html).toContain("data-pause-menu");
      expect(html).toContain("data-pause-reason");
      expect(html).toContain("correction budget exhausted (2/3)");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R6 interrupted: an interrupted run renders its open segment with the interrupted outcome (amber) and keeps the resume path alive", async () => {
    const dir = tmpDir("detail-interrupted-r6");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const { status, html } = await fetchDetail(RUN_D);
      expect(status).toBe(200);
      expect(html).toContain('data-status="interrupted"'); // status pill
      const tl = timelineRegion(html);

      // R3 rule 2: the dangling phase_start's open segment reports interrupted
      expect(tl).toContain('data-outcome="interrupted"');
      expect(tl).toMatch(/data-segment data-phase="plan" data-visit="1" data-outcome="interrupted"/);
      // interrupted is not running/paused: no now cursor, no paused stripe
      expect(tl).not.toContain("data-now-cursor");
      expect(tl).not.toContain('data-segment-paused="true"');

      // the run awaits a human resume — the resume HEADER action renders
      // (the poll keeps running; interrupted is NOT terminal)
      expect(html).toContain('data-form="resume"');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

});
