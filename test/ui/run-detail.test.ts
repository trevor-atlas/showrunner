process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * T10a acceptance e2e (issue #15) + R4/R5: the run detail page (§16.7) with
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
 * start, so §12.2 startup reconciliation cannot flip the running/paused
 * rows): a paused run with needs_review and a full §6 event spread
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
 * full §6 event spread; run B: 1 in-flight phase + a few events; run C: the
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

  // §6 #1–12 spread, oldest → newest (rowid = cursor)
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
  // died on (§12 reconcile) — R3 rule 2 reports the open segment as
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

/** Count the bubbles on a phase's row (data-segment attrs on the row). */
function bubblesFor(html: string, phase: string): number {
  return (html.match(new RegExp(`data-segment data-phase="${phase}"`, "g")) ?? []).length;
}

describe("run detail (T10a + R4/R5) — server-side daemon data + the cursor proxy", () => {
  it("renders header, control bar, needs-review banner, the R4 timeline (per-visit bubbles, corr badges, now cursor) and the typed live feed for a paused run", async () => {
    const dir = tmpDir("detail");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      // seed AFTER daemon start — §12.2 reconciliation must not touch the rows
      seedDetailData(dir);
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });

      const { status, html } = await fetchDetail(RUN_A);
      expect(status).toBe(200);

      // ── header: back-link, blueprint, short id, status pill ─────────────
      expect(html).toContain("plan_build");
      expect(html).toContain(RUN_A.slice(0, 6));
      expect(html).toContain('data-status="paused"');
      expect(html).toContain("‹ runs");
      expect(html).toContain(routes.home.href());

      // ── control bar: status/cwd/started/spend/needs-review — display only
      expect(html).toContain('data-control-bar');
      expect(html).toContain("cwd /tmp/scratch");
      expect(html).toContain("started ");
      expect(html).toContain("spend $0.42"); // 0.12 + 0.30
      expect(html).toContain('data-meta="needs-review"');
      expect(html).toContain("needs review");

      // ── needs_review banner (§16.10) ────────────────────────────────────
      expect(html).toContain("resumed after an interruption");
      expect(html).toContain("review before trusting");
      expect(html).toContain('data-state="needs-review"');

      // ── R4 timeline: one row per phase in BLUEPRINT order ───────────────
      const tl = timelineRegion(html);
      expect(tl).toContain('data-testid="timeline"');
      const pos = (needle: string): number => tl.indexOf(needle);
      expect(pos('data-phase="plan"')).toBeGreaterThan(-1);
      expect(pos('data-phase="plan"')).toBeLessThan(pos('data-phase="build"'));
      expect(pos('data-phase="build"')).toBeLessThan(pos('data-phase="ship"'));
      expect(tl).toContain('data-phase-status="success"');
      expect(tl).toContain('data-phase-status="in_progress"');
      expect(tl).toContain('data-phase-status="pending"');
      // pending phase: muted row label with the pending tag, no bubbles
      expect(tl).toContain('data-phase-pending');
      // rows label phase + agent
      expect(tl).toMatch(/planner/);
      expect(tl).toMatch(/builder/);
      expect(tl).toMatch(/shipper/);

      // ── per-visit bubbles: plan 1, build 2 (visits 1+2), ship 0 ─────────
      expect(tl).toContain('data-segment-count="3"');
      expect(bubblesFor(tl, "plan")).toBe(1);
      expect(bubblesFor(tl, "build")).toBe(2);
      expect(bubblesFor(tl, "ship")).toBe(0);
      // outcomes mapped to the segment outcomes (build's two visits are both
      // open — the fold keeps the redriven visit open while paused)
      expect(tl).toMatch(/data-outcome="success"/);
      expect((tl.match(/data-outcome="in_progress"/g) ?? []).length).toBe(2);
      // the fold kept build's visit 2 in its own bubble
      expect(tl).toMatch(/data-segment data-phase="build" data-visit="2"/);
      // R4 bubble anatomy: corrections badge ↻1 on each corrected visit
      expect((tl.match(/data-corr-badge/g) ?? []).length).toBe(2);
      expect(tl).toContain("↻1");
      // bubbles carry the R4 tooltip + the R5 keyboard aria label
      expect(tl).toContain('aria-label="build, visit 2 of 2, in progress,');
      expect(tl).toContain('title="build · visit 2 of 2 · in progress');

      // now cursor — a paused run still renders it (acceptance: running/paused)
      expect(html).toContain('data-now-cursor');

      // the R5 panel is server-rendered with the AUTO-SELECTED phase: build is
      // the in_progress phase (R5), so its record renders at SSR
      const panel = tl;
      expect(panel).toContain('data-testid="timeline-panel"');
      expect(panel).toContain('data-selected="build"');
      expect(panel).toContain('data-phase-chip-status="in_progress"');
      expect(panel).toContain("agent builder");
      expect(panel).toContain("2 visits");
      // budget usage for the current visit: v2's corrections (1) / budget (3)
      expect(panel).toContain("corrections 1 / budget 3");
      expect(panel).toContain("spend $0.30");
      // visit history newest-first: visit 2 before visit 1
      expect(pos('data-visit-block data-visit="2"')).toBeGreaterThan(-1);
      expect(pos('data-visit-block data-visit="2"')).toBeLessThan(pos('data-visit-block data-visit="1"'));
      expect((panel.match(/data-visit-block/g) ?? []).length).toBe(2);
      // visit 2 is a flow re-run (R5: "Re-ran in normal order..."), visit 1 is
      // a human restart (R5: the action + the actor) — exactly two cause lines
      expect(panel).toContain('data-cause="flow-rerun"');
      expect(panel).toContain("Re-ran in normal order after an upstream jump.");
      expect(panel).toContain('data-cause="human"');
      expect(panel).toContain("Started by a human action — restart by operator.");
      expect((panel.match(/data-cause=/g) ?? []).length).toBe(2);
      // envelopes: build's one rejected attempt (violations + the correction
      // that followed) — the lazy section renders the attempt list
      expect(panel).toContain('data-attempt-valid="0"');
      expect(panel).toContain('data-envelope-violations');
      expect(panel).toContain("tests failed: expected 3, got 2 — fix t1");
      // gates: build's failed testsPass gate from the gate_results table
      expect(panel).toContain('data-gate-row data-gate="testsPass" data-gate-pass="0"');
      expect(panel).toContain('data-gate-violations');
      expect(panel).toContain("expected 3 tests, got 2");
      // sessions: build's two agent sessions (visits 1 + 2)
      expect((panel.match(/data-session-row/g) ?? []).length).toBe(2);
      expect(panel).toContain('data-session-visit="2"');
      expect(panel).toContain("s-build2");

      // the panel header links to the phase drill-in route (the old gantt's
      // per-row drill-in links now live here)
      expect(html).toContain(routes.runs.phases.show.href({ runId: RUN_A, phase: "build" }));

      // ── the old single-bar gantt is GONE from the page ──────────────────
      expect(html).not.toContain('data-testid="gantt"');
      expect(html).not.toContain("data-phase-fill");
      expect(html).not.toContain("data-corr-mark");
      expect(html).not.toContain("data-phase-paused");

      // ── live feed: typed rows for every event family in the seed ────────
      expect(html).toContain("live feed");
      for (const type of [
        "run_submitted",
        "run_status",
        "phase_start",
        "phase_end",
        "agent_start",
        "agent_end",
        "tool_call",
        "envelope",
        "gate_result",
        "correction",
        "human_action",
        "spend",
      ]) {
        expect(html).toContain(`data-event-type="${type}"`);
      }
      // tool calls read aloud + expandable; ok/fail glyphs
      expect(html).toContain("bash: ls -la src");
      expect(html).toContain("bash: npm test -- --run");
      expect(html).toContain('data-tool-ok="true"');
      expect(html).toContain('data-tool-ok="false"');
      expect(html).toContain("args + result");
      // gate result fail + violation count; correction message; human action
      expect(html).toContain('data-gate="testsPass"');
      expect(html).toContain('data-gate-pass="false"');
      expect(html).toContain("violations: 1");
      expect(html).toContain("tests failed: expected 3, got 2 — fix t1");
      expect(html).toContain('data-human-action="steer"');
      expect(html).toContain("by operator");
      // spend delta row
      expect(html).toContain("in 500 · out 120");
      // newest-last: rowid order in the DOM
      expect(html.indexOf('data-event-id="1"')).toBeLessThan(html.indexOf('data-event-id="18"'));

      // ── read-only: no forms, nothing that can mutate run state ──────────
      expect(html).not.toContain("<form");
      expect(html).not.toContain('method="post"');

      // the daemon agrees the seeded run exists with the expected event count
      const detail = await client.getRun(RUN_A);
      expect(detail.run.status).toBe("paused");
      expect(detail.event_count).toBe(18);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R5 selection is query-param-driven: ?phase= deep links server-render the selected phase's record; unknown names fall back to auto-select", async () => {
    const dir = tmpDir("detail-selection");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      // no ?phase= → auto-select: build is the in_progress phase (R5)
      const auto = await fetchDetail(RUN_A);
      const autoTl = timelineRegion(auto.html);
      expect(autoTl).toContain('data-selected="build"');

      // ?phase=plan deep link → the panel server-renders plan's record,
      // including its envelopes + gates (the initial selection's data is
      // fetched in renderRunDetail, R5)
      const plan = await fetchDetailUrl(routes.runs.show.href({ runId: RUN_A }) + "?phase=plan");
      expect(plan.status).toBe(200);
      const planTl = timelineRegion(plan.html);
      expect(planTl).toContain('data-selected="plan"');
      expect(planTl).toContain('data-phase-chip-status="success"');
      expect(planTl).toContain("agent planner");
      expect(planTl).toContain("1 visit");
      // visit history: plan's single flow visit renders no cause line
      expect((planTl.match(/data-visit-block/g) ?? []).length).toBe(1);
      expect(planTl).not.toContain("data-cause=");
      // envelopes: the rejected attempt (violations + the correction that
      // followed) then the valid one with its summary/artifacts/handoff
      const envSection = planTl.slice(planTl.indexOf("data-panel-envelopes"), planTl.indexOf("data-panel-gates"));
      expect(envSection).toContain('data-attempt-valid="0"');
      expect(envSection).toContain('data-envelope-violations');
      expect(envSection).toContain("envelope did not parse");
      expect(envSection).toContain("resubmit a valid envelope");
      expect(envSection).toContain('data-attempt-valid="1"');
      expect(envSection).toContain("scoped the plan");
      expect(envSection).toContain("plan.md");
      expect(envSection).toContain("build per the plan");
      // gates: plan's passing testsPass gate
      expect(planTl).toContain('data-gate-row data-gate="testsPass" data-gate-pass="1"');

      // ?phase=ghost (unknown) must NOT crash — falls back to auto-select
      const ghost = await fetchDetailUrl(routes.runs.show.href({ runId: RUN_A }) + "?phase=ghost");
      expect(ghost.status).toBe(200);
      expect(timelineRegion(ghost.html)).toContain('data-selected="build"');

      // ?phase=ship (a pending phase with no segments) renders its (empty)
      // record without crashing — the muted empty states
      const ship = await fetchDetailUrl(routes.runs.show.href({ runId: RUN_A }) + "?phase=ship");
      expect(ship.status).toBe(200);
      const shipTl = timelineRegion(ship.html);
      expect(shipTl).toContain('data-selected="ship"');
      expect(shipTl).toContain('data-phase-chip-status="pending"');
      expect(shipTl).toContain("0 visits");
      expect(shipTl).toContain("no visits yet");
      expect(shipTl).toContain('data-envelopes-empty');
      expect(shipTl).toContain('data-gates-empty');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("R4 revisit arrow + R5 on_fail banner: a failed review sends execution back to implement, with a server-navigable cause link", async () => {
    const dir = tmpDir("detail-redrive");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const { status, html } = await fetchDetail(RUN_C);
      expect(status).toBe(200);
      const tl = timelineRegion(html);

      // auto-select: implement is the in_progress phase
      expect(tl).toContain('data-selected="implement"');

      // the R4 arrow: review (visit 1) → implement (visit 2)
      expect(tl).toContain("data-revisit-arrows");
      expect(tl).toContain('data-revisit-arrow');
      expect(tl).toContain('data-from-phase="review"');
      expect(tl).toContain('data-from-visit="1"');
      expect(tl).toContain('data-to-phase="implement"');
      expect(tl).toContain('data-to-visit="2"');
      expect(tl).toContain("failed and sent execution back to implement.");

      // the R5 visit-history banner for implement v2, with the causing phase
      // as a real ?phase= anchor (server-navigable selection)
      expect(tl).toContain('data-cause="on_fail"');
      expect(tl).toContain("Visit 2 started because ");
      expect(tl).toContain("failed its gates and exhausted its budget.");
      expect(tl).toContain('href="?phase=review"');
      expect(tl).toContain('data-cause-phase="review"');
      // implement v1's flow cause is the normal case — renders nothing
      expect((tl.match(/data-cause=/g) ?? []).length).toBe(1);

      // deep-linking to the causing phase server-renders ITS record
      const review = await fetchDetailUrl(routes.runs.show.href({ runId: RUN_C }) + "?phase=review");
      expect(review.status).toBe(200);
      const reviewTl = timelineRegion(review.html);
      expect(reviewTl).toContain('data-selected="review"');
      expect(reviewTl).toContain('data-phase-chip-status="failed"');
      expect(reviewTl).toContain('data-visit-block data-visit="1"');
      expect(reviewTl).toContain('data-visit-outcome="failed"');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders the running status pill + now cursor for a running run (pre-R2 cause → the panel's 'reason not recorded' line)", async () => {
    const dir = tmpDir("detail-running");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      seedDetailData(dir);

      const { status, html } = await fetchDetail(RUN_B);
      expect(status).toBe(200);
      expect(html).toContain('data-status="running"');
      expect(html).toContain("build_test");
      expect(html).toContain('data-now-cursor');
      const tl = timelineRegion(html);
      expect(tl).toContain('data-phase="build"');
      expect(tl).toContain('data-selected="build"'); // auto-select: in_progress
      // run B's phase_start carries no cause (pre-R2) → the R5 null-cause line
      expect(tl).toContain('data-cause="prer2"');
      expect(tl).toContain("Reason not recorded (run predates revisit causes).");
      // no needs-review banner for a clean running run
      expect(html).not.toContain("resumed after an interruption");
      expect(html).not.toContain('data-meta="needs-review"');
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      // §13 pause viewer's reason (seeded here via the run_status → paused
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
