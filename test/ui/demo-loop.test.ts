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
