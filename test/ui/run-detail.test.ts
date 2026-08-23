process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * T10a acceptance e2e (issue #15): the run detail page (§16.7) rendered from
 * REAL daemon data — server-side first, driven through the app router with
 * `router.fetch(...)` (the same hermetic pattern as T09/T11). The live loop's
 * ~1s poll is exercised at the proxy seam: feed the daemon more events, poll
 * events.json with the advancing cursor, assert they appear — the same
 * sliding-window query the hydrated clientEntry runs (POLL_MS = 1000).
 *
 * The rich scenario is SEEDED directly into the daemon's DB (after daemon
 * start, so §12.2 startup reconciliation cannot flip the running/paused
 * rows): a paused run with needs_review and a full §6 event spread
 * (corrections, gates, tool calls, human action, spend, lifecycle), plus a
 * running run for the live now-cursor/status pill.
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
import { insertEvent, insertPhase, insertRun, openDb } from "../../src/daemon/db.ts";
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
  const response = await router.fetch(
    new Request("http://localhost" + routes.runs.show.href({ runId })),
  );
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

// ── the seeded scenario ──────────────────────────────────────────────────────

const RUN_A = "aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // paused + needs_review
const RUN_B = "bbbb2222-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // running
const T0 = Date.now() - 10 * 60_000; // run A started 10 min ago
const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

/** Seed run A: 3 phases (plan ✓, build in-flight paused, ship pending) + the
 * full §6 event spread; run B: 1 in-flight phase + a few events. */
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
  ev("phase_start", { phase: "plan", agent: "planner", visit: 1, budget: 3 }, 5_000, { phaseId: "ph-plan" });
  ev("agent_start", { agent: "planner", pi_session_id: "s-plan", pid: 1001, model: "deepseek-v4-pro" }, 6_000, { phaseId: "ph-plan" });
  ev("tool_call", { tool: "bash", tool_call_id: "t1", args: "ls -la src", result_snippet: "src/\nindex.ts\n", ok: true, duration_ms: 400, agent: "planner" }, 10_000, { phaseId: "ph-plan" });
  ev("envelope", { phase: "plan", visit: 1, attempt: 1, valid: true }, 30_000, { phaseId: "ph-plan" });
  ev("gate_result", { gate: "testsPass", pass: true, violations: [] }, 31_000, { phaseId: "ph-plan" });
  ev("phase_end", { phase: "plan", status: "success", visits: 1, corrections: 0, spend_usd: 0.12 }, 5 * 60_000, { phaseId: "ph-plan" });
  ev("phase_start", { phase: "build", agent: "builder", visit: 1, budget: 3 }, 5 * 60_000 + 5_000, { phaseId: "ph-build" });
  ev("agent_start", { agent: "builder", pi_session_id: "s-build", pid: 1002, model: "fake-pi" }, 5 * 60_000 + 6_000, { phaseId: "ph-build" });
  ev("tool_call", { tool: "bash", tool_call_id: "t2", args: "npm test -- --run", result_snippet: "# fail 2\n", ok: false, duration_ms: 4_200, agent: "builder" }, 5 * 60_000 + 10_000, { phaseId: "ph-build" });
  ev("gate_result", { gate: "testsPass", pass: false, violations: ["expected 3 tests, got 2"] }, 5 * 60_000 + 11_000, { phaseId: "ph-build" });
  ev("correction", { phase: "build", visit: 1, reason: "gate testsPass failed", message: "tests failed: expected 3, got 2 — fix t1" }, 5 * 60_000 + 12_000, { phaseId: "ph-build" });
  ev("agent_end", { agent: "builder", pi_session_id: "s-build", exit: 0, ok: true }, 5 * 60_000 + 20_000, { phaseId: "ph-build" });
  ev("spend", { phase: "build", tokens_in: 500, tokens_out: 120, cache_read: 0, cache_write: 0, usd: 0.0021, estimated: false }, 5 * 60_000 + 21_000, { phaseId: "ph-build" });
  // visit 2: a second phase_start + a second correction — the event stream is
  // what the gantt derives corrections/visits from, so it must match the row
  ev("phase_start", { phase: "build", agent: "builder", visit: 2, budget: 3 }, 5 * 60_000 + 40_000, { phaseId: "ph-build" });
  ev("correction", { phase: "build", visit: 2, reason: "gate testsPass failed", message: "tests failed: expected 3, got 2 — fix t2" }, 5 * 60_000 + 50_000, { phaseId: "ph-build" });
  ev("run_status", { from: "running", to: "paused", reason: "correction budget exhausted (2/3)" }, 7 * 60_000);
  ev("human_action", { action: "steer", by: "operator", detail: "fix the failing test, then re-run the suite" }, 7 * 60_000 + 1_000);

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

  db.close();
}

describe("run detail (T10a) — server-side daemon data + the cursor proxy", () => {
  it("renders header, control bar, needs-review banner, gantt (fills, corr marks, now cursor) and the typed live feed for a paused run", async () => {
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

      // ── gantt: one row per phase in BLUEPRINT order, statuses, fills ────
      const gantt = html.slice(html.indexOf('data-testid="gantt"'), html.indexOf("live feed"));
      const pos = (needle: string): number => gantt.indexOf(needle);
      expect(gantt).toContain('data-phase="plan"');
      expect(gantt).toContain('data-phase="build"');
      expect(gantt).toContain('data-phase="ship"');
      // blueprint order (plan → build → ship) — NOT the daemon's started_at
      // order (which puts the NULL-started ship first)
      expect(pos('data-phase="plan"')).toBeGreaterThan(-1);
      expect(pos('data-phase="plan"')).toBeLessThan(pos('data-phase="build"'));
      expect(pos('data-phase="build"')).toBeLessThan(pos('data-phase="ship"'));
      expect(gantt).toContain('data-phase-status="success"');
      expect(gantt).toContain('data-phase-status="in_progress"');
      expect(gantt).toContain('data-phase-status="pending"');

      // completed plan fully filled, build filled and paused (amber edge),
      // ship has NO fill — exactly two filled bars
      expect((gantt.match(/data-phase-fill/g) ?? []).length).toBe(2);
      expect(gantt).toContain('data-phase-paused');
      // the plan fill spans its real window on the run timeline
      const fillLeft = parseFloat(/(data-fill-left="([\d.]+)")/.exec(gantt)![2]!);
      const fillWidth = parseFloat(/(data-fill-width="([\d.]+)")/.exec(gantt)![2]!);
      expect(fillWidth).toBeGreaterThan(0.3); // ~5min of a ~10min window
      expect(fillLeft).toBeGreaterThan(0);

      // correction marks: ✖2 on the build row; corr/vis/spend columns
      expect(html).toContain("✖2");
      expect(html).toContain('data-corr-mark');
      expect(gantt).toMatch(/planner/);
      expect(gantt).toMatch(/builder/);

      // column headers: full names with hover tooltips (§16.7 polish) — the
      // bar column is TIMELINE, the outcome lives in its own STATE column
      expect(gantt).toContain("CORRECTIONS");
      expect(gantt).toContain("VISITS");
      expect(gantt).toContain("TIMELINE");
      expect(gantt).toContain('title="the phase&#39;s outcome:');
      expect(gantt).toContain('title="re-prompts issued against this phase');
      // STATE column: event-derived outcome per phase + human-readable labels
      expect(gantt).toContain('data-phase-state="success"');
      expect(gantt).toContain('data-phase-state="in_progress"');
      expect(gantt).toContain('data-phase-state="pending"');
      expect(gantt).toContain("in progress");
      expect(gantt).toContain("waiting");

      // now cursor — a paused run still renders it (acceptance: running/paused)
      expect(html).toContain('data-now-cursor');

      // rows link to the phase drill-in route
      expect(html).toContain(routes.runs.phases.show.href({ runId: RUN_A, phase: "build" }));

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

  it("renders the running status pill + now cursor for a running run", async () => {
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
      expect(html).toContain('data-phase="build"');
      // no needs-review banner for a clean running run
      expect(html).not.toContain("resumed after an interruption");
      expect(html).not.toContain('data-meta="needs-review"');
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
      expect(res.html).not.toContain("daemon is not running");
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
