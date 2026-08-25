/**
 * Unit tests for the R4/R5 timeline pure logic: the chart layout (bubble
 * fractions, x-axis ticks, now cursor, revisit arrows), the selection rules
 * (auto-select + ?phase= resolution), and the outcome labels. Pure model —
 * no DOM (the repo's convention: interactions are tested through the pure
 * model and through query-param-driven SSR in run-detail.test.ts).
 */
import { describe, expect, it } from "bun:test";

import type { TimelinePhase, TimelineView } from "../../src/server/contract.ts";
import {
  autoSelectPhase,
  computeTimelineLayout,
  lifetime,
  outcomeLabel,
  resolveInitialSelection,
  rowKindFor,
  segmentDurationMs,
  timelineTicks,
} from "../../src/server/ui/public/timeline-model.ts";

const START = new Date("2026-01-02T10:00:00.000Z").getTime();
const iso = (offsetMs: number): string => new Date(START + offsetMs).toISOString();

function phase(
  name: string,
  overrides: Partial<TimelinePhase> = {},
  segments: TimelinePhase["segments"] = [],
): TimelinePhase {
  return {
    phase_id: `ph-${name}`,
    name,
    agent: "builder",
    status: "pending",
    visits: 0,
    budget: 3,
    spend_usd: 0,
    estimated_spend_usd: 0,
    segments,
    ...overrides,
  };
}

function timeline(phases: TimelinePhase[], overrides: Partial<TimelineView> = {}): TimelineView {
  return {
    run_id: "r1",
    blueprint: "demo",
    status: "running",
    needs_review: false,
    started_at: iso(0),
    ended_at: null,
    phases,
    ...overrides,
  };
}

const seg = (overrides: Partial<TimelinePhase["segments"][number]> = {}): TimelinePhase["segments"][number] => ({
  visit: 1,
  started_at: iso(10_000),
  ended_at: iso(60_000),
  outcome: "success",
  corrections: 0,
  envelope_attempts: 0,
  cause: { kind: "flow" },
  ...overrides,
});

describe("computeTimelineLayout (R4 chart geometry)", () => {
  it("positions a completed segment across its real window on the run timeline", () => {
    const model = computeTimelineLayout(
      timeline([phase("plan", { status: "success", segments: [seg({ started_at: iso(10_000), ended_at: iso(60_000) })] })]),
      START + 120_000,
    );
    expect(model.runStartMs).toBe(START);
    expect(model.runEndMs).toBe(START + 120_000); // live run → now
    const row = model.rows[0]!;
    expect(row.boxes).toHaveLength(1);
    // 10s..60s over a 120s window → [0.083, 0.5]
    expect(row.boxes[0]!.startF).toBeCloseTo(10_000 / 120_000, 5);
    expect(row.boxes[0]!.endF).toBeCloseTo(60_000 / 120_000, 5);
    expect(row.boxes[0]!.durationMs).toBe(50_000);
    expect(row.boxes[0]!.visitLabel).toBe("visit 1 of 1");
    expect(model.segmentCount).toBe(1);
  });

  it("ends open segments at the timeline edge (now for a live run, ended_at for a terminal one)", () => {
    const live = computeTimelineLayout(
      timeline([phase("build", { status: "in_progress", segments: [seg({ ended_at: null, outcome: "in_progress" })] })]),
      START + 90_000,
    );
    expect(live.rows[0]!.boxes[0]!.endF).toBeCloseTo(1, 5);
    expect(live.rows[0]!.boxes[0]!.durationMs).toBe(80_000);

    const terminal = computeTimelineLayout(
      timeline([phase("build", { status: "in_progress", segments: [seg({ ended_at: null, outcome: "interrupted" })] })], {
        status: "success",
        ended_at: iso(60_000),
      }),
      START + 300_000, // minutes after the end
    );
    expect(terminal.runEndMs).toBe(START + 60_000);
    expect(terminal.rows[0]!.boxes[0]!.endF).toBeCloseTo(1, 5); // frozen at the end moment
  });

  it("shows the now cursor only for running/paused runs, never a terminal one", () => {
    const running = computeTimelineLayout(timeline([]), START + 60_000);
    expect(running.showCursor).toBe(true);
    expect(running.nowF).toBeCloseTo(1, 5);
    const paused = computeTimelineLayout(timeline([], { status: "paused" }), START + 60_000);
    expect(paused.showCursor).toBe(true);
    const done = computeTimelineLayout(
      timeline([], { status: "success", ended_at: iso(60_000) }),
      START + 300_000,
    );
    expect(done.showCursor).toBe(false);
    expect(done.runEndMs).toBe(START + 60_000);
  });

  it("a pending phase renders as a muted row with no bubbles; a skipped one as a skipped row", () => {
    const model = computeTimelineLayout(
      timeline([
        phase("plan", { status: "success", segments: [seg()] }),
        phase("later", { status: "pending" }),
        phase("unused", { status: "skipped" }),
      ]),
      START + 60_000,
    );
    expect(model.rows.map((r) => r.rowKind)).toEqual(["normal", "pending", "skipped"]);
    expect(model.rows[1]!.boxes).toHaveLength(0);
    expect(model.rows[2]!.boxes).toHaveLength(0);
    expect(model.segmentCount).toBe(1);
    expect(rowKindFor(model.rows[0]!.phase)).toBe("normal");
    expect(rowKindFor(model.rows[1]!.phase)).toBe("pending");
    expect(rowKindFor(model.rows[2]!.phase)).toBe("skipped");
  });

  it("derives R4 revisit arrows for on_fail segments: cause end → target start, with the narrative label", () => {
    const reviewFail = seg({
      visit: 1,
      started_at: iso(60_000),
      ended_at: iso(90_000),
      outcome: "failed",
      cause: { kind: "flow" },
    });
    const implV2 = seg({
      visit: 2,
      started_at: iso(100_000),
      ended_at: null,
      outcome: "in_progress",
      cause: { kind: "on_fail", from_phase: "review", from_visit: 1 },
    });
    const model = computeTimelineLayout(
      timeline([
        phase("implement", { status: "in_progress", segments: [seg(), implV2] }),
        phase("review", { status: "failed", segments: [reviewFail] }),
      ]),
      START + 200_000,
    );
    expect(model.arrows).toHaveLength(1);
    const arrow = model.arrows[0]!;
    expect(arrow.fromPhase).toBe("review");
    expect(arrow.fromVisit).toBe(1);
    expect(arrow.toPhase).toBe("implement");
    expect(arrow.toVisit).toBe(2);
    // fromRow = the review row (index 1), toRow = the implement row (index 0)
    expect(arrow.fromRow).toBe(1);
    expect(arrow.toRow).toBe(0);
    // the causing segment ends at 90s; the target starts at 100s
    expect(arrow.fromF).toBeCloseTo(90_000 / 200_000, 5);
    expect(arrow.toF).toBeCloseTo(100_000 / 200_000, 5);
    expect(arrow.label).toBe("review (visit 1) failed and sent execution back to implement.");
  });

  it("skips arrows whose causing phase/visit is not in the timeline (defensive)", () => {
    const model = computeTimelineLayout(
      timeline([
        phase("implement", {
          status: "in_progress",
          segments: [seg({ visit: 2, cause: { kind: "on_fail", from_phase: "ghost", from_visit: 9 } })],
        }),
      ]),
      START + 60_000,
    );
    expect(model.arrows).toHaveLength(0);
  });

  it("produces bounded x-axis ticks for a 10-minute run", () => {
    const ticks = timelineTicks(START, START + 10 * 60_000);
    // the interval picker: 10 min / 6 ticks = a 2-minute interval → ~5 interior
    // ticks + the two edges
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks.length).toBeLessThanOrEqual(10);
    expect(ticks[0]!.frac).toBe(0);
    expect(ticks[ticks.length - 1]!.frac).toBe(1);
    // ascending, labels are local clock times
    expect(ticks[0]!.label).not.toBe("");
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.ms).toBeGreaterThan(ticks[i - 1]!.ms);
    }
  });

  it("adapts the tick interval to the run duration (seconds ticks for short runs, minutes for long)", () => {
    const short = timelineTicks(START, START + 30_000); // 30s → 5s ticks
    const long = timelineTicks(START, START + 6 * 3600_000); // 6h → 1h ticks
    expect(short.filter((t) => t.ms > START && t.ms < START + 30_000)).toHaveLength(5);
    expect(long.filter((t) => t.ms > START && t.ms < START + 6 * 3600_000)).toHaveLength(5);
  });

  it("builds the tooltip + aria label from the segment (R4 bubble anatomy)", () => {
    const model = computeTimelineLayout(
      timeline([
        phase("implement", {
          status: "in_progress",
          segments: [seg({ visit: 2, outcome: "failed", corrections: 1, envelope_attempts: 3 })],
        }),
      ]),
      START + 120_000,
    );
    const box = model.rows[0]!.boxes[0]!;
    expect(box.tooltip).toContain("implement");
    expect(box.tooltip).toContain("visit 2 of 2");
    expect(box.tooltip).toContain("failed");
    expect(box.tooltip).toContain("corrections 1");
    expect(box.tooltip).toContain("attempts 3");
    expect(box.ariaLabel).toContain("implement, visit 2 of 2, failed,");
  });
});

describe("R5 selection", () => {
  it("auto-selects the in_progress phase when one exists", () => {
    const view = timeline([
      phase("plan", { status: "success", segments: [seg()] }),
      phase("build", { status: "in_progress", segments: [seg({ ended_at: null, outcome: "in_progress" })] }),
      phase("ship", { status: "pending" }),
    ]);
    expect(autoSelectPhase(view)).toBe("build");
  });

  it("otherwise auto-selects the LAST phase with any segment", () => {
    const view = timeline([
      phase("plan", { status: "success", segments: [seg()] }),
      phase("build", { status: "failed", segments: [seg({ outcome: "failed" })] }),
      phase("ship", { status: "pending" }),
    ]);
    expect(autoSelectPhase(view)).toBe("build");
  });

  it("returns null when no phase is selectable (all pending)", () => {
    expect(autoSelectPhase(timeline([phase("a"), phase("b")]))).toBeNull();
  });

  it("resolveInitialSelection honors a valid ?phase= name", () => {
    const view = timeline([
      phase("plan", { status: "success", segments: [seg()] }),
      phase("build", { status: "in_progress", segments: [seg()] }),
    ]);
    expect(resolveInitialSelection(view, "plan")).toBe("plan");
    expect(resolveInitialSelection(view, "build")).toBe("build");
  });

  it("resolveInitialSelection falls back to auto-select for unknown names and no param — never crashes", () => {
    const view = timeline([
      phase("plan", { status: "success", segments: [seg()] }),
      phase("build", { status: "in_progress", segments: [seg()] }),
    ]);
    expect(resolveInitialSelection(view, "ghost")).toBe("build");
    expect(resolveInitialSelection(view, null)).toBe("build");
    expect(resolveInitialSelection(view, undefined)).toBe("build");
  });
});

describe("R6 live behavior", () => {
  it("exposes the paused flag for the striped treatment (paused runs only)", () => {
    expect(computeTimelineLayout(timeline([], { status: "paused" }), START + 60_000).paused).toBe(true);
    // running
    expect(computeTimelineLayout(timeline([]), START + 60_000).paused).toBe(false);
    // terminal
    const done = computeTimelineLayout(
      timeline([], { status: "success", ended_at: iso(60_000) }),
      START + 300_000,
    );
    expect(done.paused).toBe(false);
    // interrupted
    expect(computeTimelineLayout(timeline([], { status: "interrupted" }), START + 60_000).paused).toBe(false);
  });

  it("marks the phase's CURRENT visit — the active bubble the paused treatment targets", () => {
    const view = timeline([
      phase("build", {
        status: "in_progress",
        segments: [
          seg({ visit: 1, started_at: iso(10_000), ended_at: iso(40_000) }),
          seg({ visit: 2, started_at: iso(50_000), ended_at: null, outcome: "in_progress" }),
        ],
      }),
    ]);
    const model = computeTimelineLayout(view, START + 60_000);
    const boxes = model.rows[0]!.boxes;
    expect(boxes.map((b) => b.current)).toEqual([false, true]);
    // the paused stripe condition the chart applies: paused + current +
    // in_progress — exactly the second bubble here
    const striped = boxes.filter((b) => model.paused && b.current && b.segment.outcome === "in_progress");
    expect(model.paused).toBe(false); // running → nothing stripes
    expect(striped).toHaveLength(0);
    const pausedModel = computeTimelineLayout({ ...view, status: "paused" }, START + 60_000);
    const stripedPaused = pausedModel.rows[0]!.boxes.filter(
      (b) => pausedModel.paused && b.current && b.segment.outcome === "in_progress",
    );
    expect(stripedPaused.map((b) => b.segment.visit)).toEqual([2]);
  });

  it("grows the open bubble between re-renders: the live edge advances as `now` moves each poll", () => {
    const view = timeline([
      phase("build", {
        status: "in_progress",
        segments: [seg({ started_at: iso(10_000), ended_at: null, outcome: "in_progress" })],
      }),
    ]);
    const at60 = computeTimelineLayout(view, START + 60_000);
    const at120 = computeTimelineLayout(view, START + 120_000);
    const box60 = at60.rows[0]!.boxes[0]!;
    const box120 = at120.rows[0]!.boxes[0]!;
    // the open segment's end is pinned to the LIVE edge (now), so a later
    // render stretches the bubble: its start fraction recedes and its width
    // + elapsed duration grow (the component re-renders with a fresh
    // Date.now() on every poll — the growth is not frozen in setup scope)
    expect(box60.endF).toBeCloseTo(1, 5);
    expect(box120.endF).toBeCloseTo(1, 5);
    expect(box60.widthF).toBeCloseTo(1 - 10_000 / 60_000, 5);
    expect(box120.widthF).toBeCloseTo(1 - 10_000 / 120_000, 5);
    expect(box120.widthF).toBeGreaterThan(box60.widthF);
    expect(box120.durationMs).toBeGreaterThan(box60.durationMs);
  });

  it("renders an interrupted run's open segment as interrupted (amber) with no now cursor and no paused stripe", () => {
    const view = timeline(
      [phase("build", { status: "in_progress", segments: [seg({ started_at: iso(10_000), ended_at: null, outcome: "interrupted" })] })],
      { status: "interrupted" },
    );
    const model = computeTimelineLayout(view, START + 120_000);
    expect(model.paused).toBe(false);
    expect(model.showCursor).toBe(false); // interrupted is not running/paused
    const box = model.rows[0]!.boxes[0]!;
    expect(box.segment.outcome).toBe("interrupted");
    expect(outcomeLabel(box.segment.outcome)).toBe("interrupted"); // amber text
    // the open segment extends to the (live) timeline edge — the run awaits a
    // human resume, so its right edge is now, not a frozen end moment
    expect(box.endF).toBeCloseTo(1, 5);
    expect(box.durationMs).toBe(110_000);
  });
});

describe("phase helpers", () => {
  it("computes the phase lifetime from its segments (first start → last end)", () => {
    const p = phase("build", {
      segments: [
        seg({ started_at: iso(10_000), ended_at: iso(60_000) }),
        seg({ visit: 2, started_at: iso(70_000), ended_at: null, outcome: "in_progress" }),
      ],
    });
    const life = lifetime(p);
    expect(life.startMs).toBe(START + 10_000);
    expect(life.endMs).toBe(START + 60_000); // open segments do not extend it
    expect(lifetime(phase("pending"))).toEqual({ startMs: null, endMs: null });
  });

  it("labels outcomes human-readably", () => {
    expect(outcomeLabel("in_progress")).toBe("in progress");
    expect(outcomeLabel("success")).toBe("success");
    expect(outcomeLabel("failed")).toBe("failed");
    expect(outcomeLabel("skipped")).toBe("skipped");
    expect(outcomeLabel("interrupted")).toBe("interrupted");
  });
});

describe("segmentDurationMs (the one Date.parse site the chart + panel share)", () => {
  it("measures a closed segment start→end", () => {
    expect(segmentDurationMs(seg({ started_at: iso(10_000), ended_at: iso(60_000) }))).toBe(50_000);
  });

  it("measures an open segment to the fallback edge (the panel's 'now' semantics — Date.now() when omitted)", () => {
    const open = seg({ started_at: iso(10_000), ended_at: null, outcome: "in_progress" });
    expect(segmentDurationMs(open, START + 60_000)).toBe(50_000);
    // the default parameter IS Date.now(): an open segment can never be
    // negative even against a clock that just moved
    expect(segmentDurationMs(open)).toBeGreaterThanOrEqual(0);
  });

  it("clamps to 0 when the fallback edge precedes the start (now < start)", () => {
    const open = seg({ started_at: iso(10_000), ended_at: null, outcome: "in_progress" });
    expect(segmentDurationMs(open, START)).toBe(0);
    // a closed segment whose end precedes its start also clamps (defensive)
    expect(segmentDurationMs(seg({ started_at: iso(60_000), ended_at: iso(10_000) }))).toBe(0);
  });
});
