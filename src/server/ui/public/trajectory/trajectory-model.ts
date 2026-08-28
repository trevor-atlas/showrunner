/**
 * The Trajectory swimlane layout model (#85) — pure, no DOM. It consumes the
 * server's TrajectoryView (the #83 contract) and places each entry as a POINT
 * on its lane (input / model / tools), positioned by ORDINAL sequence: an
 * entry's `fraction` is its index in the phase's overall seq-ordered reading
 * (the "Turns/Calls" axis), normalized to [0,1]. There is no wall-clock axis
 * yet — the horizontal position is the reading order, shared across all three
 * lanes so the shape of a phase reads across them.
 *
 * The three lanes always render (an empty lane still appears with a 0 count),
 * so the return shape carries exactly three TrajectoryLaneLayout in a fixed
 * order. The swimlane component maps 0..1 → % and colors each point by lane;
 * the math is testable without a DOM (test/server/trajectory-model.test.ts).
 *
 * `opts` is an object so a later zoom/brush ticket (#87) can add a window
 * option (e.g. `{ zoom }`) without changing the call sites.
 */

import type { TrajectoryEntry, TrajectoryLane, TrajectoryView } from "../../../contract.ts";

/** The three lanes, in the fixed order the swimlanes render (input → model →
 * tools). Exactly these, always, so an empty lane still shows its header. */
export const TRAJECTORY_LANES: readonly TrajectoryLane[] = ["input", "model", "tools"];

/** One placed point on a lane. */
export interface TrajectoryPoint {
  /** the entry's stable id — the same `seq` the feed rows key on */
  seq: number;
  lane: TrajectoryLane;
  /** ordinal position in the phase's overall reading order, in [0,1] */
  fraction: number;
}

/** One lane's placed points plus its count (the header reading). */
export interface TrajectoryLaneLayout {
  lane: TrajectoryLane;
  points: TrajectoryPoint[];
  count: number;
}

/** The computed swimlane geometry: exactly three lanes and the point total. */
export interface TrajectoryLayout {
  /** always three lanes, in TRAJECTORY_LANES order */
  lanes: TrajectoryLaneLayout[];
  /** total points across all lanes (= placed entries) */
  total: number;
}

/** #87 zoom/brush: an ordinal range over the global seq reading-order, both
 * bounds in [0,1]. An entry is in-window iff its ordinal fraction — its index
 * in the FULL seq-ordered reading, normalized to [0,1] — falls within
 * [start,end]. Bounds may arrive in either order; callers need not pre-sort. */
export interface TrajectoryZoomWindow {
  start: number;
  end: number;
}

/** #87 windowing option. Without `zoom` the layout is identical to pre-#87. */
export interface TrajectoryLayoutOptions {
  zoom?: TrajectoryZoomWindow | null;
}

/** The in-window entries for a zoom window, in seq reading-order. The SINGLE
 * filter shared by the layout (swimlane points) and the panel (feed rows), so
 * both restrict to exactly the same set. A null window → the full seq-ordered
 * set (identical to pre-#87). Inclusion is by an entry's ordinal fraction over
 * the FULL set, so the window reads on the same axis the points are placed on. */
export function entriesInZoom(
  entries: readonly TrajectoryEntry[],
  zoom: TrajectoryZoomWindow | null,
): TrajectoryEntry[] {
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  if (zoom === null) return ordered;
  const start = Math.min(zoom.start, zoom.end);
  const end = Math.max(zoom.start, zoom.end);
  const denom = ordered.length > 1 ? ordered.length - 1 : 1;
  return ordered.filter((_entry, index) => {
    const fraction = index / denom;
    return fraction >= start && fraction <= end;
  });
}

/** Place every in-window entry as a point on its lane at its ordinal fraction.
 * The fraction is the entry's index in the (windowed) seq-ordered reading
 * divided by (count - 1); a lone point (or none) sits at 0. With a zoom window,
 * only in-window entries become points and the per-lane counts + fractions
 * reflect the windowed set. Deterministic and DOM-free. */
export function computeTrajectoryLayout(
  view: TrajectoryView,
  opts: TrajectoryLayoutOptions = {},
): TrajectoryLayout {
  const ordered = entriesInZoom(view.entries, opts.zoom ?? null);
  const denom = ordered.length > 1 ? ordered.length - 1 : 1;

  const byLane = new Map<TrajectoryLane, TrajectoryPoint[]>(
    TRAJECTORY_LANES.map((lane) => [lane, []]),
  );
  ordered.forEach((entry: TrajectoryEntry, index) => {
    byLane.get(entry.lane)!.push({
      seq: entry.seq,
      lane: entry.lane,
      fraction: index / denom,
    });
  });

  const lanes = TRAJECTORY_LANES.map((lane) => {
    const points = byLane.get(lane)!;
    return { lane, points, count: points.length };
  });

  return { lanes, total: ordered.length };
}
