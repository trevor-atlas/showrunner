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

/** Reserved for later windowing (#87 zoom/brush). */
export interface TrajectoryLayoutOptions {
  // room for { zoom } later — kept an object so call sites never change
}

/** Place every entry as a point on its lane at its ordinal fraction. The
 * fraction is the entry's index in the seq-ordered reading divided by
 * (total - 1); a lone point (or none) sits at 0. Deterministic and DOM-free. */
export function computeTrajectoryLayout(
  view: TrajectoryView,
  _opts: TrajectoryLayoutOptions = {},
): TrajectoryLayout {
  const ordered = [...view.entries].sort((a, b) => a.seq - b.seq);
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
