/**
 * The run-timeline chart + selection model (spec R4/R5) — pure, no UI. It
 * consumes the daemon's TimelineView (GET /runs/:id/timeline — per-visit
 * segments already folded server-side, phases already in blueprint order) and
 * derives everything the chart renders:
 *
 *  - per-phase rows, each segment as a bubble box on the run's time axis
 *    (fractions of the timeline so the component only maps 0..1 → %);
 *  - the x-axis ticks (interval adapts to the run duration);
 *  - the NOW cursor (running/paused runs only);
 *  - the R4 revisit arrows: every segment whose cause is `on_fail` gets a
 *    connector from the END of the causing segment (from_phase/from_visit)
 *    to the START of this segment;
 *  - the R5 selection rules: auto-select (the phase currently in_progress,
 *    else the last phase with any segment, else none) and the ?phase= deep
 *    link resolution (unknown names fall back to auto-select — never crash).
 *
 * The chart and the panel render the model's geometry verbatim, so the
 * layout math is testable without a DOM (test/ui/timeline-model.test.ts).
 */

import type { TimelinePhase, TimelineSegment, TimelineView } from "../../../../daemon/contract.ts";
import { fmtDuration, fmtTime } from "./format.ts";

/** The fixed pixel height of one phase row (the chart + the arrow overlay
 * share this so the SVG y-coordinates line up with the rows). */
export const ROW_H = 68;

/** How many ticks the x-axis aims for — the interval picker adapts to the
 * run duration so short runs get seconds ticks and long runs get hours. */
const MAX_TICKS = 6;

/** Candidate tick intervals, coarse to fine (seconds → days). */
const TICK_INTERVALS_MS = [
  1_000,
  2_000,
  5_000,
  10_000,
  15_000,
  30_000,
  60_000,
  2 * 60_000,
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
  24 * 60 * 60_000,
  2 * 24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];

export interface TimelineTick {
  /** position as a fraction [0,1] of the run timeline */
  frac: number;
  /** epoch ms of the tick */
  ms: number;
  /** local clock label (fmtTime) */
  label: string;
}

/** One rendered bubble: a segment positioned on its phase's row. */
export interface SegmentBox {
  segment: TimelineSegment;
  /** "visit 1 of 2" */
  visitLabel: string;
  /** true for the phase's CURRENT visit — its last segment (R6: the paused
   * striped treatment targets exactly this bubble) */
  current: boolean;
  /** start as a fraction [0,1] of the run timeline */
  startF: number;
  /** end as a fraction [0,1] — open segments end at the timeline edge */
  endF: number;
  /** rendered width as a fraction (the component enforces a min px width) */
  widthF: number;
  /** elapsed duration in ms (open segments measure to the timeline edge) */
  durationMs: number;
  /** hover tooltip: phase, visit n of N, outcome, start/end, duration,
   * corrections, attempts (R4 bubble anatomy) */
  tooltip: string;
  /** keyboard/AT label: "implement, visit 2 of 2, failed, 14:02 to 14:20" */
  ariaLabel: string;
}

export type RowKind = "pending" | "skipped" | "normal";

export interface TimelineRow {
  phase: TimelinePhase;
  /** empty for pending/skipped phases */
  boxes: SegmentBox[];
  rowKind: RowKind;
  /** the phase's lifetime: first segment start → last segment end */
  lifetimeStartMs: number | null;
  lifetimeEndMs: number | null;
}

/** R4 revisit arrow: an on_fail segment's connector to its cause. */
export interface RevisitArrow {
  fromPhase: string;
  fromVisit: number;
  toPhase: string;
  toVisit: number;
  /** row index of the causing segment (from_phase) */
  fromRow: number;
  /** row index of the target segment */
  toRow: number;
  /** x fraction of the causing segment's END */
  fromF: number;
  /** x fraction of the target segment's START */
  toF: number;
  /** tooltip: "review (visit 1) failed and sent execution back to implement." */
  label: string;
}

export interface TimelineLayout {
  runStartMs: number;
  /** the timeline right edge: ended_at for a terminal run, else now */
  runEndMs: number;
  nowMs: number;
  /** the NOW cursor fraction (running/paused runs only) */
  nowF: number;
  showCursor: boolean;
  /** R6: true when the run is paused — the chart stripes the active bubble */
  paused: boolean;
  ticks: TimelineTick[];
  rows: TimelineRow[];
  arrows: RevisitArrow[];
  /** total bubbles across all rows (a test seam) */
  segmentCount: number;
}

/** The elapsed duration of one segment in ms: closed segments measure
 * start→end; open segments (ended_at null) measure to `endFallbackMs` — the
 * ONE Date.parse site the chart and the panel share. The chart pins open
 * segments to the timeline edge (runEndMs) while the panel uses "now"
 * (Date.now()) — a deliberate, documented seam: both semantics flow through
 * the same helper instead of re-deriving.
 */
export function segmentDurationMs(segment: TimelineSegment, endFallbackMs = Date.now()): number {
  const endMs = segment.ended_at !== null ? Date.parse(segment.ended_at) : endFallbackMs;
  return Math.max(0, endMs - Date.parse(segment.started_at));
}

/** Build the chart model for one render (server load or every poll). */
export function computeTimelineLayout(timeline: TimelineView, now = Date.now()): TimelineLayout {
  const runStartMs = Date.parse(timeline.started_at);
  const terminal = timeline.ended_at !== null && timeline.ended_at !== undefined;
  const runEndMs = terminal ? Date.parse(timeline.ended_at!) : now;
  const span = Math.max(1, runEndMs - runStartMs);
  const frac = (ms: number): number => clamp01((ms - runStartMs) / span);

  const rows: TimelineRow[] = timeline.phases.map((phase) => {
    // the visit total the labels read: the phase row's count, at least the
    // segments' max visit (the resume fold collapses two same-visit
    // starts into one segment, so segments.length can under-report)
    const visitCount = Math.max(phase.visits, ...phase.segments.map((s) => s.visit));
    const boxes: SegmentBox[] = phase.segments.map((segment, index) => {
      const startMs = Date.parse(segment.started_at);
      // open segments (ended_at null) run to the timeline edge — now for a
      // live run, the ended_at moment for a terminal one
      const endMs = segment.ended_at !== null ? Date.parse(segment.ended_at) : runEndMs;
      const startF = frac(startMs);
      const endF = frac(endMs);
      // chart edge semantics preserved: the duration uses the same endMs as
      // the geometry (segmentDurationMs with runEndMs as the open-segment edge)
      const durationMs = segmentDurationMs(segment, runEndMs);
      const visitLabel = `visit ${segment.visit} of ${visitCount}`;
      const range = `${fmtTime(segment.started_at)} to ${segment.ended_at !== null ? fmtTime(segment.ended_at) : "now"}`;
      return {
        segment,
        visitLabel,
        // the phase's current visit is its LAST segment (visits ascend) — R6
        // stripes exactly this bubble when the run is paused
        current: index === phase.segments.length - 1,
        startF,
        endF,
        widthF: Math.max(0, endF - startF),
        durationMs,
        tooltip: `${phase.name} · ${visitLabel} · ${outcomeLabel(segment.outcome)} · ${range} · ${fmtDuration(durationMs)} · corrections ${segment.corrections} · attempts ${segment.envelope_attempts}`,
        ariaLabel: `${phase.name}, ${visitLabel}, ${outcomeLabel(segment.outcome)}, ${range}`,
      };
    });
    return {
      phase,
      boxes,
      rowKind: rowKindFor(phase),
      lifetimeStartMs: lifetime(phase).startMs,
      lifetimeEndMs: lifetime(phase).endMs,
    };
  });

  // R4 revisit arrows: for every on_fail segment, connect the END of the
  // causing segment (from_phase / from_visit) to the START of this segment.
  const arrows: RevisitArrow[] = [];
  for (let toRow = 0; toRow < rows.length; toRow++) {
    const row = rows[toRow]!;
    for (const box of row.boxes) {
      const cause = box.segment.cause;
      if (cause === null || cause.kind !== "on_fail") continue;
      const fromRow = rows.findIndex((r) => r.phase.name === cause.from_phase);
      if (fromRow === -1) continue; // the causing phase is not in this timeline
      const causing = rows[fromRow]!.boxes.find((b) => b.segment.visit === cause.from_visit);
      if (causing === undefined) continue; // the causing visit is not in this timeline
      arrows.push({
        fromPhase: cause.from_phase,
        fromVisit: cause.from_visit,
        toPhase: row.phase.name,
        toVisit: box.segment.visit,
        fromRow,
        toRow,
        fromF: causing.endF,
        toF: box.startF,
        label: `${cause.from_phase} (visit ${cause.from_visit}) failed and sent execution back to ${row.phase.name}.`,
      });
    }
  }

  const nowF = frac(now);
  const showCursor = timeline.status === "running" || timeline.status === "paused";

  return {
    runStartMs,
    runEndMs,
    nowMs: now,
    nowF,
    showCursor,
    // R6: the paused treatment — the chart stripes the active (current)
    // in_progress bubble when the run is paused
    paused: timeline.status === "paused",
    ticks: timelineTicks(runStartMs, runEndMs),
    rows,
    arrows,
    segmentCount: rows.reduce((n, r) => n + r.boxes.length, 0),
  };
}

/** The x-axis ticks: an interval adapted to the run duration, bounded by the
 * run's start and end edges so the axis reads cleanly at both ends. */
export function timelineTicks(runStartMs: number, runEndMs: number): TimelineTick[] {
  const span = Math.max(1, runEndMs - runStartMs);
  const interval = pickTickInterval(span);
  const ticks: TimelineTick[] = [];
  const push = (ms: number): void => {
    const frac = clamp01((ms - runStartMs) / span);
    if (!ticks.some((t) => t.ms === ms)) {
      ticks.push({ frac, ms, label: fmtOffset(ms - runStartMs) });
    }
  };
  push(runStartMs); // the left edge
  for (let t = Math.ceil(runStartMs / interval) * interval; t <= runEndMs; t += interval) {
    push(t);
  }
  push(runEndMs); // the right edge
  return ticks;
}

/** The axis label for an epoch ms: its offset from the run start, rendered
 * relative ("0s", "30s", "2m", "1h 5m") — the timeline reads as elapsed time
 * from the run's beginning rather than absolute clock times. */
export function fmtOffset(offsetMs: number): string {
  const totalSeconds = Math.max(0, Math.round(offsetMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Pick the coarsest interval that yields ≤ MAX_TICKS interior ticks. */
function pickTickInterval(spanMs: number): number {
  for (const interval of TICK_INTERVALS_MS) {
    if (spanMs / interval <= MAX_TICKS) return interval;
  }
  return TICK_INTERVALS_MS[TICK_INTERVALS_MS.length - 1]!;
}

/** The row's visual kind: a phase with no segments is pending (muted label,
 * no bubble) or skipped (muted label + "skipped" tag), per R4. */
export function rowKindFor(phase: TimelinePhase): RowKind {
  if (phase.segments.length > 0) return "normal";
  return phase.status === "skipped" ? "skipped" : "pending";
}

/** The phase's lifetime: first segment start → last segment end (R5 header). */
export function lifetime(phase: TimelinePhase): { startMs: number | null; endMs: number | null } {
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const s of phase.segments) {
    const st = Date.parse(s.started_at);
    if (startMs === null || st < startMs) startMs = st;
    if (s.ended_at !== null) {
      const en = Date.parse(s.ended_at);
      if (endMs === null || en > endMs) endMs = en;
    }
  }
  return { startMs, endMs };
}

/** R5 auto-select: the phase currently in_progress, else the LAST phase with
 * any segment, else nothing. */
export function autoSelectPhase(timeline: TimelineView): string | null {
  const inProgress = timeline.phases.find((p) => p.status === "in_progress");
  if (inProgress !== undefined) return inProgress.name;
  for (let i = timeline.phases.length - 1; i >= 0; i--) {
    if (timeline.phases[i]!.segments.length > 0) return timeline.phases[i]!.name;
  }
  return null;
}

/** R5 selection resolution: a valid ?phase= name wins; anything else (absent
 * or unknown — never crash) falls back to auto-select. */
export function resolveInitialSelection(timeline: TimelineView, requested: string | null | undefined): string | null {
  if (requested !== null && requested !== undefined) {
    const known = timeline.phases.some((p) => p.name === requested);
    if (known) return requested;
  }
  return autoSelectPhase(timeline);
}

/** The human-readable outcome label (R4 tooltip + R5 visit blocks). */
export function outcomeLabel(outcome: TimelineSegment["outcome"]): string {
  switch (outcome) {
    case "in_progress":
      return "in progress";
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "skipped":
      return "skipped";
    case "interrupted":
      return "interrupted";
  }
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
