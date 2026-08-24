process.env.SHOWRUNNER_FAKE = "1"; // hermetic: scripted FakePi sessions, never real pi (T05)
/**
 * R7 acceptance (UI level) — the demo-loop fixture END TO END through the
 * merged web server + SPA router (the run-detail SSR harness from
 * test/ui/run-detail.test.ts): the COMPLETED demo-loop run is submitted
 * through the running daemon (submitRun({ blueprint }) → the fixture + its
 * fake-pi scripts resolve at submit, the pool drives it to success), then the
 * run detail page is fetched with `router.fetch` and the rendered timeline
 * chart + panel are asserted:
 *
 *   #4 chart: 4 rows / 6 bubbles / exactly one revisit arrow (review v1 end →
 *             implement v2 start) / the correction badge on review v1.
 *   #5 interaction: ?phase=implement renders the panel with two visit blocks,
 *             the visit-2 on_fail banner names review (visit 1) and links to
 *             ?phase=review, which renders review's record (failed v1).
 *   #3 (UI half): a PRE-R2 run (phase_start payload without cause) renders
 *             "Reason not recorded (run predates revisit causes)."
 *   #6 live: a second run of the SAME blueprint whose package envelope asserts
 *             blocked parks PAUSED with package's segment OPEN — the page
 *             renders the paused treatment, the open bubble extends toward
 *             now across two timeline.json refreshes, and the ?phase= deep
 *             link selection survives.
 *
 * Selection is ?phase=-driven with real anchors, so "clicking implement" is
 * the server-side deep link: router.fetch the page with ?phase=implement and
 * assert the panel content + the banner's ?phase=review link.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dbPathFor, type EventType } from "../../src/core/index.ts";
import type { TimelineView } from "../../src/daemon/client.ts";
import { DaemonClient } from "../../src/daemon/client.ts";
import { startDaemon, type DaemonHandle } from "../../src/daemon/daemon.ts";
import { getRun, insertEvent, insertPhase, insertRun, openDb } from "../../src/daemon/db.ts";
import {
  getControl,
  loadBlueprintModule,
  resolveScriptedSessions,
  runBlueprint,
} from "../../src/daemon/index.ts";
import type { ScriptedTurn } from "../../src/daemon/index.ts";
import { router } from "../../src/ui/app/router.ts";
import { routes } from "../../src/ui/app/routes.ts";
import { computeTimelineLayout } from "../../src/ui/app/ui/public/timeline-model.ts";

const DEMO_LOOP_FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "daemon", "fixtures", "demo-loop");
const DEMO_LOOP_BP = join(DEMO_LOOP_FIXTURE_DIR, "demo-loop.ts");
const DEMO_LOOP_FAKE_PI = join(DEMO_LOOP_FIXTURE_DIR, "fake-pi");

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `showrunner-ui-demo-loop-${label}-`));
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

/** SSR fetch of the R6 timeline.json refetch proxy (the live region polls it). */
async function fetchTimeline(runId: string): Promise<{ status: number; view: TimelineView }> {
  const response = await router.fetch(new Request("http://localhost" + routes.runs.timeline.href({ runId })));
  return { status: response.status, view: (await response.json()) as TimelineView };
}

/** The rendered timeline+panel region (everything before the live feed). */
function timelineRegion(html: string): string {
  return html.slice(html.indexOf('data-testid="timeline"'), html.indexOf("live feed"));
}

/** Count the bubbles on a phase's row (data-segment attrs on the row). */
function bubblesFor(html: string, phase: string): number {
  return (html.match(new RegExp(`data-segment data-phase="${phase}"`, "g")) ?? []).length;
}

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 30_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A minimal settled turn — the blocked-package variant used for the paused run. */
function blockedTurn(): ScriptedTurn {
  return {
    events: [
      { type: "agent_start", messageCount: 0, model: "fake-pi" },
      { type: "turn_start" },
      { type: "message_start", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_end", message: { id: "m1", role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "message_start", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "blocked" }] } },
      { type: "message_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "blocked" }] } },
      { type: "turn_end", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "blocked" }] } },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ],
    envelope: {
      summary: "blocked on release credentials",
      artifacts: [],
      notes_for_next_agent: "need a human",
      quality: 9,
      blocked: true,
      blocked_reason: "no release token configured",
    },
  };
}

describe("demo-loop e2e (R7 #4/#5/#3/#6) — the completed fixture through the daemon + SPA", () => {
  it("R7 #4/#5: the completed demo-loop run renders 4 rows / 6 bubbles / one revisit arrow / the correction badge; ?phase=implement and ?phase=review deep links render the panels", async () => {
    const dir = tmpDir("completed");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });

      // topology (a): submit the FIXTURE BLUEPRINT MODULE through the running
      // daemon — the fixture + its fake-pi scripts resolve at submit and the
      // pool drives the run to completion
      const client = new DaemonClient({ baseUrl: daemon.baseUrl });
      const sub = await client.submitRun({ blueprint: DEMO_LOOP_BP });
      expect(sub.blueprint).toBe("demo-loop");

      // poll the daemon's DB (the same WAL the run loop writes) until success
      const db = openDb(dbPathFor(dir));
      await waitFor(() => getRun(db, sub.run_id)?.status === "success", 30_000, "demo-loop run success");
      const runId = sub.run_id;

      const { status, html } = await fetchDetail(runId);
      expect(status).toBe(200);
      const tl = timelineRegion(html);

      // ── #4 chart: 4 phase rows in BLUEPRINT order, 6 bubbles ───────────
      expect(tl).toContain('data-testid="timeline"');
      expect(tl).toContain('data-segment-count="6"');
      expect((tl.match(/data-phase-row data-phase=/g) ?? []).length).toBe(4);
      const pos = (needle: string): number => tl.indexOf(needle);
      expect(pos('data-phase="plan"')).toBeLessThan(pos('data-phase="implement"'));
      expect(pos('data-phase="implement"')).toBeLessThan(pos('data-phase="review"'));
      expect(pos('data-phase="review"')).toBeLessThan(pos('data-phase="package"'));
      // per-visit bubbles: 1/2/2/1
      expect(bubblesFor(tl, "plan")).toBe(1);
      expect(bubblesFor(tl, "implement")).toBe(2);
      expect(bubblesFor(tl, "review")).toBe(2);
      expect(bubblesFor(tl, "package")).toBe(1);
      // review v1's bubble carries the correction badge — exactly one
      expect(tl).toMatch(/data-segment data-phase="review" data-visit="1"/);
      expect((tl.match(/data-corr-badge/g) ?? []).length).toBe(1);
      expect(tl).toContain("↻1");

      // ── #4 revisit arrow: exactly ONE, review v1 end → implement v2 start
      expect((tl.match(/data-revisit-arrow\b/g) ?? []).length).toBe(1);
      expect(tl).toContain('data-from-phase="review"');
      expect(tl).toContain('data-from-visit="1"');
      expect(tl).toContain('data-to-phase="implement"');
      expect(tl).toContain('data-to-visit="2"');
      expect(tl).toContain("failed and sent execution back to implement.");

      // the R6 timeline.json proxy (what the live region refetches) carries
      // the same view: 4 phases, 1/2/2/1 segments, the on_fail cause
      const proxy = await fetchTimeline(runId);
      expect(proxy.status).toBe(200);
      expect(proxy.view.phases.map((p) => p.name)).toEqual(["plan", "implement", "review", "package"]);
      expect(proxy.view.phases.map((p) => p.segments.length)).toEqual([1, 2, 2, 1]);
      expect(proxy.view.phases.find((p) => p.name === "implement")!.segments[1]!.cause).toEqual({
        kind: "on_fail",
        from_phase: "review",
        from_visit: 1,
      });

      // auto-select (no ?phase=): no phase is in_progress → the LAST phase
      // with any segment (package)
      expect(tl).toContain('data-selected="package"');

      // ── #5 interaction: ?phase=implement = clicking implement (server-side
      // deep link) → the panel renders implement's record with two visits
      const impl = await fetchDetailUrl(routes.runs.show.href({ runId }) + "?phase=implement");
      expect(impl.status).toBe(200);
      const implTl = timelineRegion(impl.html);
      expect(implTl).toContain('data-selected="implement"');
      expect((implTl.match(/data-visit-block/g) ?? []).length).toBe(2);
      // the visit-2 banner names review visit 1 and its link selects review
      expect(implTl).toContain('data-cause="on_fail"');
      expect(implTl).toContain("Visit 2 started because");
      expect(implTl).toContain('data-cause-phase="review"');
      expect(implTl).toContain('href="?phase=review"');
      expect(implTl).toMatch(/review<\/a> \(visit 1\) failed its gates and exhausted its budget\./);
      // implement v1 (flow, visit 1) renders no cause line — exactly one banner
      expect((implTl.match(/data-cause=/g) ?? []).length).toBe(1);

      // the banner's ?phase=review link works: deep-linking to review renders
      // ITS record — v1's failed visit and v2's success
      const rev = await fetchDetailUrl(routes.runs.show.href({ runId }) + "?phase=review");
      expect(rev.status).toBe(200);
      const revTl = timelineRegion(rev.html);
      expect(revTl).toContain('data-selected="review"');
      expect((revTl.match(/data-visit-block/g) ?? []).length).toBe(2);
      expect(revTl).toContain('data-visit-block data-visit="1"');
      expect(revTl).toContain('data-visit-outcome="failed"');
      expect(revTl).toContain('data-visit-outcome="success"');
      expect(revTl).toContain('data-visit-corrections');
      expect(revTl).toContain("↻1 correction");
      // review v1's block reports its two rejected attempts' correction
      expect(revTl).toContain("quality 5 is below the required 8");

      db.close();
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });

  it("R7 #3 (UI half): a run recorded BEFORE R2 (phase_start without cause) renders end to end with 'Reason not recorded' in the panel", async () => {
    const dir = tmpDir("prer2");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });
      const db = openDb(dbPathFor(dir));
      // seed a pre-R2 run into the daemon's DB AFTER start (no reconcile
      // to flip the rows): phase_start payload carries NO cause
      const runId = "eeee5555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const t = new Date().toISOString();
      insertRun(db, {
        id: runId,
        blueprint: "demo-loop",
        status: "success",
        cwd: "/tmp/scratch-pre-r2",
        needs_review: 0,
        started_at: t,
        ended_at: new Date(Date.now() + 1_000).toISOString(),
      });
      insertPhase(db, {
        id: "ph-plan-pre",
        run_id: runId,
        name: "plan",
        agent: "builder",
        status: "success",
        visits: 1,
        corrections: 0,
        budget: 3,
        spend_usd: 0,
        started_at: t,
        ended_at: t,
      });
      const ev = (type: EventType, data: unknown): void => {
        insertEvent(db, { run_id: runId, phase_id: "ph-plan-pre", agent_session_id: null, type, ts: t, data });
      };
      ev("run_submitted", { blueprint: "demo-loop", cwd: "/tmp/scratch-pre-r2" });
      ev("phase_start", { phase: "plan", agent: "builder", visit: 1, budget: 3 }); // pre-R2: no cause key
      ev("phase_end", { phase: "plan", status: "success", visits: 1, corrections: 0, spend_usd: 0 });
      db.close();

      const { status, html } = await fetchDetail(runId);
      expect(status).toBe(200);
      expect(html).toContain('data-status="success"');
      const tl = timelineRegion(html);
      // the fold reports cause null (never reconstructed) → the panel's
      // null-cause line, exactly like run-detail.test.ts's RUN_B
      expect(tl).toContain('data-cause="prer2"');
      expect(tl).toContain("Reason not recorded (run predates revisit causes).");
      // the chart still renders the visit normally
      expect(bubblesFor(tl, "plan")).toBe(1);
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });

  it("R7 #6 (UI half): the fixture paused mid-run (blocked package) renders the paused treatment, the open bubble extends toward now across two refreshes, and the selection survives", async () => {
    const dir = tmpDir("paused");
    const restore = setDataDir(dir);
    let daemon: DaemonHandle | null = null;
    try {
      daemon = await startDaemon({ dataDir: dir, port: 0 });

      // a SECOND run of the SAME blueprint module with a scripted package
      // envelope that asserts blocked (EnvelopeBase.blocked) — driven into
      // the daemon's dataDir, the loop parks at the blocked pause with
      // package's segment OPEN (phase_start, no phase_end)
      const db = openDb(dbPathFor(dir));
      const cwd = mkdtempSync(join(tmpdir(), "showrunner-demo-loop-cwd-"));
      const blueprint = await loadBlueprintModule(DEMO_LOOP_BP);
      const scripts = resolveScriptedSessions(blueprint, DEMO_LOOP_FAKE_PI);
      scripts.package = { turns: [blockedTurn()] };
      const paused = runBlueprint(db, dir, { blueprint, cwd, scripts });
      expect((await paused.done).status).toBe("paused");
      const runId = paused.run_id;

      // ── the paused page: package is the in_progress phase → auto-selected;
      // its ACTIVE bubble carries the striped paused treatment ──────────
      const page = await fetchDetail(runId);
      expect(page.status).toBe(200);
      const tl = timelineRegion(page.html);
      expect(tl).toContain('data-selected="package"');
      expect(tl).toMatch(/data-segment data-phase="package" data-visit="1" data-outcome="in_progress" data-segment-paused="true"/);
      expect((tl.match(/data-paused-stripe/g) ?? []).length).toBe(1);
      expect(page.html).toContain("data-now-cursor");
      // the pause reason surfaces in the panel header (the pause viewer)
      expect(tl).toContain("data-panel-pause-reason");
      expect(tl).toContain("blocked in phase");
      expect(tl).toContain("no release token configured");

      // ── the open bubble extends toward now across two refreshes ────────
      const t1 = await fetchTimeline(runId);
      expect(t1.status).toBe(200);
      const t2 = await fetchTimeline(runId);
      expect(t2.status).toBe(200);
      const pkgOf = (v: TimelineView) => v.phases.find((p) => p.name === "package")!;
      // both refreshes report the SAME open segment: started_at pinned, no end
      expect(pkgOf(t1.view).segments).toHaveLength(1);
      expect(pkgOf(t2.view).segments).toHaveLength(1);
      const s1 = pkgOf(t1.view).segments[0]!;
      const s2 = pkgOf(t2.view).segments[0]!;
      expect(s1.ended_at).toBeNull();
      expect(s2.ended_at).toBeNull();
      expect(s2.started_at).toBe(s1.started_at);
      expect(s1.outcome).toBe("in_progress");
      // the model pins open segments to now (the run's live right edge) — a
      // refresh 60s later renders the bubble WIDER (the round-4 model seam:
      // timeline-model.test.ts "grows the open bubble between re-renders")
      const now1 = Date.now();
      const m1 = computeTimelineLayout(t1.view, now1);
      const m2 = computeTimelineLayout(t2.view, now1 + 60_000);
      const b1 = m1.rows.find((r) => r.phase.name === "package")!.boxes[0]!;
      const b2 = m2.rows.find((r) => r.phase.name === "package")!.boxes[0]!;
      expect(b1.segment.ended_at).toBeNull();
      expect(b2.widthF).toBeGreaterThan(b1.widthF);

      // ── the selection survives: the ?phase= deep link is stable across
      // refreshes (and the timeline refetch never resets it — the live region
      // keeps selection in setup scope, R6)
      const s1Page = await fetchDetailUrl(routes.runs.show.href({ runId }) + "?phase=package");
      expect(s1Page.status).toBe(200);
      expect(timelineRegion(s1Page.html)).toContain('data-selected="package"');
      const s2Page = await fetchDetailUrl(routes.runs.show.href({ runId }) + "?phase=package");
      expect(s2Page.status).toBe(200);
      expect(timelineRegion(s2Page.html)).toContain('data-selected="package"');

      // cleanup: fail the parked run so its control unregisters
      getControl(runId)!.fail("test");
      expect((await paused.terminal).status).toBe("failed");
      rmSync(cwd, { recursive: true, force: true });
      db.close();
    } finally {
      await daemon?.close();
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 60_000 });
});
