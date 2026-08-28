import { css, type Handle } from "remix/ui";

import type { TrajectoryLane, TrajectoryView } from "../../../contract.ts";
import {
  computeTrajectoryLayout,
  type TrajectoryLaneLayout,
  type TrajectoryPoint,
} from "./trajectory-model.ts";

/**
 * The Trajectory tab's SWIMLANES (#85) — three color-coded lanes (Input /
 * Model / Tools) stacked ABOVE the flat feed. Each parsed entry is a point on
 * its lane, positioned by ORDINAL sequence (the shared reading axis from the
 * pure model — no wall-clock yet). Reading the three lanes together shows the
 * shape of a phase at a glance: a burst of tool calls, a long model turn, etc.
 *
 * The geometry is the pure `computeTrajectoryLayout` (DOM-free, unit-tested);
 * this component only maps 0..1 → % and colors each point by lane. Lanes carry
 * stable attributes (`data-testid="trajectory-lane"`, `data-lane`,
 * `data-count`; points `data-testid="trajectory-point"`, `data-seq`) so tests
 * key off them — the same house style as the feed rows. Points share the feed's
 * lane colors (input sky, model violet, tools running-blue). An empty lane
 * still renders its header + an empty track.
 */
export interface TrajectorySwimlaneProps {
  view: TrajectoryView;
}

/** Per-lane header label + point color (the feed uses the same tokens for its
 * USER / ASSISTANT / TOOL badges, so the two views read consistently). */
const LANE_META: Record<TrajectoryLane, { label: string; color: string }> = {
  input: { label: "Input", color: "var(--accent-sky)" },
  model: { label: "Model", color: "var(--accent-violet)" },
  tools: { label: "Tools", color: "var(--status-running)" },
};

export function TrajectorySwimlane(handle: Handle<TrajectorySwimlaneProps>) {
  return () => {
    const layout = computeTrajectoryLayout(handle.props.view);
    return (
      <div data-testid="trajectory-swimlane" data-total={layout.total} mix={swimlaneStyle}>
        {layout.lanes.map((lane) => (
          <Lane key={lane.lane} lane={lane} />
        ))}
      </div>
    );
  };
}

function Lane(handle: Handle<{ lane: TrajectoryLaneLayout }>) {
  return () => {
    const { lane } = handle.props;
    const meta = LANE_META[lane.lane];
    return (
      <div data-testid="trajectory-lane" data-lane={lane.lane} data-count={lane.count} mix={laneStyle}>
        <span mix={laneHeaderStyle} style={{ color: meta.color }}>
          <span mix={laneNameStyle}>{meta.label}</span>
          <span data-lane-count mix={laneCountStyle}>{lane.count}</span>
        </span>
        <div data-lane-track mix={trackStyle}>
          {lane.points.map((point) => (
            <Point key={point.seq} point={point} color={meta.color} />
          ))}
        </div>
      </div>
    );
  };
}

function Point(handle: Handle<{ point: TrajectoryPoint; color: string }>) {
  return () => {
    const { point, color } = handle.props;
    return (
      <span
        data-testid="trajectory-point"
        data-seq={point.seq}
        data-lane={point.lane}
        mix={pointStyle}
        style={{ left: `${point.fraction * 100}%`, background: color, borderColor: color }}
      />
    );
  };
}

const swimlaneStyle = css({
  display: "grid",
  gap: "0.25rem",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  padding: "0.5rem 0.75rem",
});

const laneStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
});

const laneHeaderStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.35rem",
  width: "5rem",
  flexShrink: 0,
  fontWeight: 700,
  fontSize: "var(--font-size-sm)",
});

const laneNameStyle = css({
  whiteSpace: "nowrap",
});

const laneCountStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-xs)",
  color: "var(--muted-foreground)",
});

const trackStyle = css({
  position: "relative",
  flex: 1,
  minWidth: 0,
  height: "16px",
  borderRadius: "999px",
  background: "var(--secondary)",
});

const pointStyle = css({
  position: "absolute",
  top: "50%",
  width: "9px",
  height: "9px",
  marginLeft: "-4.5px",
  borderRadius: "50%",
  border: "1px solid",
  transform: "translateY(-50%)",
});
