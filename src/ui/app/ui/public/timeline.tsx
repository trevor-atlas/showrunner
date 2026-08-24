import { css, on, type Handle } from "remix/ui";

import { ROW_H, outcomeLabel, type RevisitArrow, type SegmentBox, type TimelineLayout, type TimelineRow } from "./timeline-model.ts";

/**
 * The run-timeline chart (spec R4) — one row per phase in blueprint order,
 * the X axis spanning the run's started_at → ended_at (or now for a live
 * run), each visit rendered as a rounded bubble at its time interval on its
 * phase's row. Replaces the old single-bar gantt in the same chart area.
 *
 * Bubble anatomy: fill + border carry the visit's outcome (mapped to the SPA
 * status tokens: in_progress blue, success green, failed red, interrupted
 * amber, skipped grey); a ↻n badge marks visits with corrections; bubbles
 * have a minimum px width so zero-length visits stay visible and clickable;
 * hover shows a title tooltip (phase, visit n of N, outcome, start/end in
 * local time, duration, corrections, attempts). Pending phases render as a
 * muted row label with no bubble; skipped phases render muted with a
 * "skipped" tag on the label.
 *
 * R4 revisit arrows: on_fail segments draw a thin curved connector from the
 * END of the causing segment (from_phase / from_visit) to the START of this
 * segment — an SVG overlay over the rows, pointer-events none so clicks stay
 * on rows and bubbles (arrows are not clickable), highlighted on hover.
 *
 * R5 selection: clicking a bubble or a row label selects that phase (all its
 * bubbles highlight); clicking empty chart space deselects; bubbles are
 * keyboard-focusable and Enter selects.
 *
 * R6 paused treatment: when the run is paused, the ACTIVE bubble (the phase's
 * current in_progress segment) gets a striped/hatched overlay — purely
 * visual (a repeating-linear-gradient span, pointer-events none); the
 * bubble's outcome color logic is untouched.
 *
 * The chart is stateless — it renders `model` (recomputed by the owner on
 * every poll, so the now-cursor and open-segment edges advance live) and
 * reports selection through `onSelect`; the selection state itself lives in
 * the poll owner's setup scope (run-live-region), so it survives refreshes.
 */

export interface TimelineProps {
  /** the computed model — recompute via computeTimelineLayout on every render */
  model: TimelineLayout;
  runId: string;
  /** the selected phase name, or null (R5) */
  selected: string | null;
  /** selection changed: the phase name, or null when deselected (R5) */
  onSelect: (name: string | null) => void;
}

export function Timeline(handle: Handle<TimelineProps>) {
  return () => {
    const { model, runId, selected, onSelect } = handle.props;
    const selectPhase = (name: string): void => onSelect(name);

    return (
      <div
        data-testid="timeline"
        data-run={runId}
        data-segment-count={model.segmentCount}
        mix={[
          chartStyle,
          on("click", (event) => {
            // clicks on a bubble or a row label select (handled by their own
            // handlers); anything else in the chart area deselects (R5)
            const target = event.target as Element | null;
            if (target !== null && typeof target.closest === "function" && target.closest("[data-select-phase]") !== null) {
              return;
            }
            onSelect(null);
          }),
        ]}
      >
        {/* x axis: ticks, adapted to the run duration */}
        <div mix={axisRowStyle}>
          <div mix={axisSpacerStyle} aria-hidden />
          <div data-timeline-track mix={trackStyle}>
            {model.ticks.map((tick) => (
              <span
                key={tick.ms}
                data-tick
                data-tick-frac={tick.frac}
                mix={tickStyle}
                style={{ left: `${tick.frac * 100}%` }}
              >
                {tick.label}
              </span>
            ))}
          </div>
        </div>

        {/* the rows + the arrow overlay + the now cursor share one coordinate
        space: the label column is fixed width, the tracks column scales */}
        <div mix={bodyStyle}>
          <div mix={labelColumnStyle}>
            {model.rows.map((row) => (
              <RowLabel key={row.phase.name} row={row} selected={selected === row.phase.name} onSelect={selectPhase} />
            ))}
          </div>
          <div mix={tracksColumnStyle} data-timeline-tracks>
            {model.rows.map((row) => (
              <div key={row.phase.name} data-phase-row data-phase={row.phase.name} data-phase-status={row.phase.status} mix={rowTrackStyle}>
                {row.boxes.map((box) => (
                  <Bubble
                    key={`${row.phase.name}-v${box.segment.visit}`}
                    row={row}
                    box={box}
                    selected={selected === row.phase.name}
                    // R6: only the ACTIVE bubble (the phase's current
                    // in_progress segment) stripes when the run is paused
                    paused={model.paused && box.current && box.segment.outcome === "in_progress"}
                    onSelect={selectPhase}
                  />
                ))}
              </div>
            ))}
            {model.showCursor ? (
              <div data-now-cursor mix={nowCursorStyle} style={{ left: `${model.nowF * 100}%` }} />
            ) : null}
            {model.arrows.length > 0 ? <ArrowOverlay arrows={model.arrows} rowCount={model.rows.length} /> : null}
          </div>
        </div>
      </div>
    );
  };
}

/** The row's label cell: phase name (click-to-select) + agent, muted when the
 * phase has no segments, with the pending / "skipped" tag per R4. */
function RowLabel(handle: Handle<{ row: TimelineRow; selected: boolean; onSelect: (name: string) => void }>) {
  return () => {
    const { row, selected, onSelect } = handle.props;
    const { phase } = row;
    const noSegments = row.boxes.length === 0;
    return (
      <div
        data-phase-row-label
        data-select-phase={phase.name}
        mix={[
          labelCellStyle,
          selected ? labelCellSelectedStyle : null,
          noSegments ? labelCellMutedStyle : null,
          on("click", () => onSelect(phase.name)),
        ]}
      >
        <button
          type="button"
          data-phase-label
          data-select-phase={phase.name}
          mix={[phaseNameButtonStyle, selected ? phaseNameSelectedStyle : null, on("click", () => onSelect(phase.name))]}
        >
          {phase.name}
        </button>
        <span data-phase-agent mix={agentStyle}>
          {phase.agent}
          {row.rowKind === "skipped" ? <span data-phase-skipped mix={skippedTagStyle}>skipped</span> : null}
          {row.rowKind === "pending" ? <span data-phase-pending mix={pendingTagStyle}>pending</span> : null}
        </span>
      </div>
    );
  };
}

/** One visit bubble: positioned on its phase's row at the segment's interval. */
function Bubble(handle: Handle<{ row: TimelineRow; box: SegmentBox; selected: boolean; paused: boolean; onSelect: (name: string) => void }>) {
  return () => {
    const { row, box, selected, paused, onSelect } = handle.props;
    const { segment } = box;
    return (
      <div
        data-segment
        data-phase={row.phase.name}
        data-visit={segment.visit}
        data-outcome={segment.outcome}
        data-segment-paused={paused ? "true" : "false"}
        data-select-phase={row.phase.name}
        tabIndex={0}
        role="button"
        title={box.tooltip}
        aria-label={box.ariaLabel}
        mix={[
          bubbleStyle,
          BUBBLE_COLORS[segment.outcome],
          selected ? selectedBubbleStyle : null,
          on("click", () => onSelect(row.phase.name)),
          on("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(row.phase.name);
            }
          }),
        ]}
        style={{ left: `${box.startF * 100}%`, width: `${box.widthF * 100}%` }}
      >
        {/* R6: the paused stripe is a purely visual overlay — it must not
        change the bubble's outcome color logic, so it is a layered gradient
        span (pointer-events none) rather than a background replacement */}
        {paused ? <span data-paused-stripe mix={pausedStripeStyle} aria-hidden="true" /> : null}
        {segment.corrections > 0 ? (
          <span
            data-corr-badge
            mix={corrBadgeStyle}
            title={segment.corrections === 1 ? "1 correction issued in this visit." : `${segment.corrections} corrections issued in this visit.`}
          >
            ↻{segment.corrections}
          </span>
        ) : null}
      </div>
    );
  };
}

/** The R4 revisit-arrow overlay — one SVG over the rows; pointer-events none
 * except on the paths (clicks belong to rows and bubbles; arrows are not
 * clickable). viewBox y matches the fixed ROW_H so curves line up exactly. */
function ArrowOverlay(handle: Handle<{ arrows: RevisitArrow[]; rowCount: number }>) {
  return () => {
    const { arrows, rowCount } = handle.props;
    return (
      <svg
        data-revisit-arrows
        mix={arrowOverlayStyle}
        viewBox={`0 0 100 ${rowCount * ROW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {arrows.map((arrow, i) => (
          <g key={`${arrow.fromPhase}-v${arrow.fromVisit}-${arrow.toPhase}-v${arrow.toVisit}`} mix={arrowGroupStyle}>
            <path
              data-revisit-arrow
              data-from-phase={arrow.fromPhase}
              data-from-visit={arrow.fromVisit}
              data-to-phase={arrow.toPhase}
              data-to-visit={arrow.toVisit}
              d={arrowPath(arrow)}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              title={arrow.label}
            />
            <circle data-arrow-head cx={arrow.toF * 100} cy={rowY(arrow.toRow)} r={2.5} fill="currentColor" />
          </g>
        ))}
      </svg>
    );
  };
}

/** A gentle cubic from the cause's end to the target's start. */
function arrowPath(arrow: RevisitArrow): string {
  const x1 = arrow.fromF * 100;
  const y1 = rowY(arrow.fromRow);
  const x2 = arrow.toF * 100;
  const y2 = rowY(arrow.toRow);
  const midY = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
}

function rowY(rowIndex: number): number {
  return rowIndex * ROW_H + ROW_H / 2;
}

/** Outcome → the SPA status tokens (status-pill.tsx): in_progress = running
 * blue, success = green, failed = red, interrupted = warning amber, skipped =
 * muted grey (R4 bubble anatomy). */
const BUBBLE_COLORS: Record<string, ReturnType<typeof css>> = {
  in_progress: css({
    background: "#3573f6",
    borderColor: "#1d4ed8",
  }),
  success: css({
    background: "#15803d",
    borderColor: "#166534",
  }),
  failed: css({
    background: "#b91c1c",
    borderColor: "#991b1b",
  }),
  interrupted: css({
    background: "#b45309",
    borderColor: "#92400e",
  }),
  skipped: css({
    background: "#9ca3af",
    borderColor: "#6b7280",
  }),
};

const chartStyle = css({
  display: "grid",
  gap: "0.15rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  padding: "0.6rem 0.75rem 0.75rem",
  background: "#fdfdfd",
  userSelect: "none",
});

const axisRowStyle = css({
  display: "flex",
});

/** Matches the label column width so the axis aligns with the tracks. */
const axisSpacerStyle = css({
  width: "11rem",
  flexShrink: 0,
});

const trackStyle = css({
  position: "relative",
  flex: 1,
  height: "14px",
});

const tickStyle = css({
  position: "absolute",
  top: 0,
  transform: "translateX(-50%)",
  fontSize: "10px",
  color: "#9ca3af",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  whiteSpace: "nowrap",
});

const bodyStyle = css({
  display: "flex",
});

const labelColumnStyle = css({
  width: "11rem",
  flexShrink: 0,
  display: "grid",
});

const tracksColumnStyle = css({
  position: "relative",
  flex: 1,
  minWidth: 0,
});

const rowTrackStyle = css({
  position: "relative",
  height: `${ROW_H}px`,
});

const labelCellStyle = css({
  height: `${ROW_H}px`,
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  paddingRight: "0.5rem",
  minWidth: 0,
});

const labelCellMutedStyle = css({
  opacity: 0.55,
});

const labelCellSelectedStyle = css({
  background: "rgba(53, 115, 246, 0.08)",
});

const phaseNameButtonStyle = css({
  appearance: "none",
  font: "inherit",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: 0,
  margin: 0,
  cursor: "pointer",
  color: "#111827",
  fontWeight: 600,
  fontSize: "13px",
  lineHeight: 1.2,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  "&:hover": {
    color: "#3573f6",
    textDecoration: "underline",
  },
  "&:focus-visible": {
    outline: "2px solid #3573f6",
    outlineOffset: "1px",
    borderRadius: "3px",
  },
});

const phaseNameSelectedStyle = css({
  color: "#3573f6",
});

const agentStyle = css({
  fontSize: "11px",
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "flex",
  alignItems: "center",
  gap: "0.35rem",
});

const skippedTagStyle = css({
  fontSize: "9px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#6b7280",
  border: "1px solid #d1d5db",
  borderRadius: "999px",
  padding: "0 5px",
  lineHeight: "13px",
});

const pendingTagStyle = css({
  fontSize: "9px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#9ca3af",
  border: "1px dashed #d1d5db",
  borderRadius: "999px",
  padding: "0 5px",
  lineHeight: "13px",
});

const bubbleStyle = css({
  position: "absolute",
  top: "10px",
  height: "16px",
  borderRadius: "999px",
  minWidth: "4px", // R4: zero-length / very short visits stay visible
  border: "1px solid",
  cursor: "pointer",
  "&:hover": {
    boxShadow: "0 0 0 2px rgba(0,0,0,0.12)",
  },
  "&:focus-visible": {
    outline: "2px solid #111827",
    outlineOffset: "1px",
  },
});

const selectedBubbleStyle = css({
  boxShadow: "0 0 0 2px #111827",
});

const corrBadgeStyle = css({
  position: "absolute",
  right: "-0.35rem",
  top: "-0.6rem",
  fontSize: "10px",
  fontWeight: 700,
  color: "#b45309",
  background: "#fff7ed",
  border: "1px solid #fcd34d",
  borderRadius: "999px",
  padding: "0 4px",
  lineHeight: "14px",
  whiteSpace: "nowrap",
  pointerEvents: "none",
});

/** R6 paused treatment: the striped/hatched overlay on the ACTIVE bubble of a
 * paused run. Layered OVER the outcome color (a repeating-linear-gradient
 * fill, inset to the bubble's pill, pointer-events none) — the outcome color
 * logic in BUBBLE_COLORS is untouched. */
const pausedStripeStyle = css({
  position: "absolute",
  inset: 0,
  borderRadius: "999px",
  backgroundImage:
    "repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.4) 0 5px, rgba(255, 255, 255, 0) 5px 10px)",
  pointerEvents: "none",
});

const nowCursorStyle = css({
  position: "absolute",
  top: 0,
  bottom: 0,
  width: "0",
  borderLeft: "2px solid #111827",
  pointerEvents: "none",
});

const arrowOverlayStyle = css({
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  color: "#9ca3af",
});

const arrowGroupStyle = css({
  pointerEvents: "auto",
  cursor: "default",
  "& path:hover": {
    stroke: "#3573f6",
    strokeWidth: 2.5,
  },
});
