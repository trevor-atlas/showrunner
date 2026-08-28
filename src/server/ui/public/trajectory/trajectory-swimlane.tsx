import { css, on, type Handle } from "remix/ui";

import type { TrajectoryLane, TrajectoryView } from "../../../contract.ts";
import {
  computeTrajectoryLayout,
  type TrajectoryLaneLayout,
  type TrajectoryPoint,
  type TrajectoryZoomWindow,
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
  /** #87: the active zoom/brush window, or null (full trajectory). When set,
   * the lanes restrict to in-window points and a visible brush overlay spans
   * the selected range. */
  zoom?: TrajectoryZoomWindow | null;
  /** #87: the panel wires this so a drag across the track sets the window and a
   * click/clear resets it (null). Absent → a read-only swimlane with no brush
   * affordance (the pre-#87 behavior). */
  onBrush?: (window: TrajectoryZoomWindow | null) => void;
}

/** A drag shorter than this fraction of the track is treated as a click — it
 * clears the window rather than selecting a hairline range. */
const BRUSH_MIN = 0.01;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

const normalizeWindow = (a: number, b: number): TrajectoryZoomWindow => ({
  start: Math.min(a, b),
  end: Math.max(a, b),
});

/** Per-lane header label + point color (the feed uses the same tokens for its
 * USER / ASSISTANT / TOOL badges, so the two views read consistently). */
const LANE_META: Record<TrajectoryLane, { label: string; color: string }> = {
  input: { label: "Input", color: "var(--accent-sky)" },
  model: { label: "Model", color: "var(--accent-violet)" },
  tools: { label: "Tools", color: "var(--status-running)" },
};

export function TrajectorySwimlane(handle: Handle<TrajectorySwimlaneProps>) {
  // The in-progress drag window (null when idle) — client state, so the live
  // overlay tracks the pointer before the brush is committed on pointerup.
  let dragStart: number | null = null;
  let dragWindow: TrajectoryZoomWindow | null = null;

  const fractionAt = (event: PointerEvent): number => {
    const el = event.currentTarget as HTMLElement | null;
    const rect = el?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return 0;
    return clamp01((event.clientX - rect.left) / rect.width);
  };

  const onPointerDown = (event: PointerEvent): void => {
    dragStart = fractionAt(event);
    dragWindow = normalizeWindow(dragStart, dragStart);
    void handle.update();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (dragStart === null) return;
    dragWindow = normalizeWindow(dragStart, fractionAt(event));
    void handle.update();
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (dragStart === null) return;
    const window = normalizeWindow(dragStart, fractionAt(event));
    dragStart = null;
    dragWindow = null;
    handle.props.onBrush?.(window.end - window.start < BRUSH_MIN ? null : window);
    void handle.update();
  };

  return () => {
    const { zoom = null, onBrush } = handle.props;
    const layout = computeTrajectoryLayout(handle.props.view, { zoom });
    const overlay = dragWindow ?? zoom;
    return (
      <div data-testid="trajectory-swimlane" data-total={layout.total} mix={swimlaneStyle}>
        {layout.lanes.map((lane) => (
          <Lane key={lane.lane} lane={lane} />
        ))}
        {onBrush !== undefined ? (
          <div
            data-testid="trajectory-brush-layer"
            mix={[
              brushLayerStyle,
              on("pointerdown", (event) => onPointerDown(event)),
              on("pointermove", (event) => onPointerMove(event)),
              on("pointerup", (event) => onPointerUp(event)),
            ]}
          >
            {overlay !== null ? (
              <div
                data-testid="trajectory-brush"
                mix={brushStyle}
                style={{ left: `${overlay.start * 100}%`, width: `${(overlay.end - overlay.start) * 100}%` }}
              />
            ) : null}
            {zoom !== null ? (
              <button
                type="button"
                data-testid="trajectory-brush-clear"
                mix={[clearStyle, on("click", () => onBrush(null))]}
              >
                clear zoom
              </button>
            ) : null}
          </div>
        ) : null}
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
  position: "relative",
  display: "grid",
  gap: "0.25rem",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  padding: "0.5rem 0.75rem",
});

// Overlays the track column (each lane's track starts past the 5rem header +
// 0.75rem gap; the swimlane pads 0.75rem). A drag here brushes the window.
const brushLayerStyle = css({
  position: "absolute",
  top: "0.5rem",
  bottom: "0.5rem",
  left: "calc(0.75rem + 5rem + 0.75rem)",
  right: "0.75rem",
  cursor: "col-resize",
  touchAction: "none",
});

const brushStyle = css({
  position: "absolute",
  top: 0,
  bottom: 0,
  background: "var(--accent-sky)",
  opacity: 0.18,
  border: "1px solid var(--accent-sky)",
  borderRadius: "4px",
  pointerEvents: "none",
});

const clearStyle = css({
  position: "absolute",
  top: "-1.5rem",
  right: 0,
  padding: "0.1rem 0.4rem",
  border: "1px solid var(--border)",
  borderRadius: "4px",
  background: "var(--card)",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-xs)",
  cursor: "pointer",
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
