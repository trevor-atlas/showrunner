import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import { routes } from "../../routes.ts";
import { fmtDuration, fmtMoney } from "./format.ts";
import type { GanttModel, PhaseBar } from "./gantt-model.ts";

/**
 * The run-detail Gantt (spec §16.7): one row per phase in blueprint order —
 * PHASE · AGENT · STATUS (the bar) · DURATION · CORR · VIS · SPEND.
 *
 * The bar fill = the phase's span on the run timeline: completed phases are
 * fully filled in their status color; the in-flight phase fills to now (or to
 * the pause moment while paused — amber edge); pending phases are empty and
 * dimmed. A vertical NOW cursor sits at the run-relative time while the run
 * is running/paused. `✖n` correction marks render on the bar. Clicking a
 * phase navigates to its drill-in route.
 *
 * Rendered server-side on load and re-rendered on every poll (the live
 * region recomputes `model` from the same events the feed shows — §16.5).
 */
export interface GanttProps {
  /** the computed model — recompute via computeGantt on every render */
  model: GanttModel;
  runId: string;
}

export function Gantt(handle: Handle<GanttProps>) {
  return () => {
    const { model, runId } = handle.props;
    return (
      <table data-testid="gantt" mix={tableStyle}>
        <thead>
          <tr>
            <th>PHASE</th>
            <th>AGENT</th>
            <th>STATUS</th>
            <th>DURATION</th>
            <th>CORR</th>
            <th>VIS</th>
            <th>SPEND</th>
          </tr>
        </thead>
        <tbody>
          {model.phases.map((bar) => (
            <GanttRow key={bar.name} bar={bar} runId={runId} showCursor={model.showCursor} nowF={model.nowF} />
          ))}
        </tbody>
      </table>
    );
  };
}

function GanttRow(handle: Handle<{ bar: PhaseBar; runId: string; showCursor: boolean; nowF: number }>) {
  return () => {
    const { bar, runId, showCursor, nowF } = handle.props;
    return (
      <tr data-phase={bar.name} data-phase-status={bar.barStatus} mix={rowStyle}>
        <td>
          <a href={routes.runs.phases.show.href({ runId, phase: bar.name })} mix={phaseLinkStyle}>
            {bar.name}
          </a>
        </td>
        <td mix={monoStyle}>{bar.agent}</td>
        <td>
          <div mix={[trackStyle, bar.barStatus === "pending" ? pendingTrackStyle : null]}>
            {bar.filled ? (
              <div
                data-phase-fill
                data-fill-left={String(bar.startF)}
                data-fill-width={String(Math.max(0, bar.endF - bar.startF))}
                mix={[
                  fillStyle,
                  FILL_COLORS[bar.barStatus],
                  bar.paused ? pausedEdgeStyle : null,
                ]}
                style={{ left: `${bar.startF * 100}%`, width: `${Math.max(0, bar.endF - bar.startF) * 100}%` }}
              >
                {bar.paused ? (
                  <span data-phase-paused mix={pausedMarkStyle}>
                    ⏸
                  </span>
                ) : null}
                {bar.corrections > 0 ? (
                  <span data-corr-mark mix={corrMarkStyle}>
                    ✖{bar.corrections}
                  </span>
                ) : null}
              </div>
            ) : null}
            {showCursor ? <div data-now-cursor mix={nowCursorStyle} style={{ left: `${nowF * 100}%` }} /> : null}
          </div>
        </td>
        <td mix={monoStyle}>{bar.durationMs !== null ? fmtDuration(bar.durationMs) : "pending"}</td>
        <td mix={monoStyle}>{bar.corrections}</td>
        <td mix={monoStyle}>{bar.visits}</td>
        <td mix={monoStyle}>{fmtMoney(bar.spendUsd)}</td>
      </tr>
    );
  };
}

const tableStyle = css({
  width: "100%",
  borderCollapse: "collapse",
  font: "inherit",
  "& th, & td": {
    textAlign: "left",
    padding: "0.45rem 0.75rem",
    borderBottom: "1px solid #e5e7eb",
    fontSize: "13px",
    verticalAlign: "middle",
  },
  "& th": {
    fontSize: "11px",
    textTransform: "lowercase",
    letterSpacing: "0.06em",
    color: "#6b7280",
    fontWeight: 700,
  },
  "& tbody tr:hover": {
    background: "#f9fafb",
  },
});

const rowStyle = css({});

const phaseLinkStyle = css({
  color: "#111827",
  textDecoration: "none",
  fontWeight: 600,
  "&:hover": {
    textDecoration: "underline",
    color: "#3573f6",
  },
});

const monoStyle = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
  color: "#374151",
});

const trackStyle = css({
  position: "relative",
  height: "18px",
  minWidth: "9rem",
  borderRadius: "4px",
  background: "#f3f4f6",
  overflow: "visible",
});

const pendingTrackStyle = css({
  opacity: 0.55,
});

const fillStyle = css({
  position: "absolute",
  top: 0,
  bottom: 0,
  borderRadius: "4px",
  minWidth: "2px",
});

const FILL_COLORS: Record<string, ReturnType<typeof css>> = {
  success: css({ background: "#15803d" }),
  failed: css({ background: "#b91c1c" }),
  skipped: css({ background: "#9ca3af" }),
  in_progress: css({ background: "#3573f6" }),
  pending: css({ background: "#e5e7eb" }),
};

/** paused in-flight phase: amber fill edge (§16.7). */
const pausedEdgeStyle = css({
  boxShadow: "inset 0 0 0 2px #b45309",
});

const corrMarkStyle = css({
  position: "absolute",
  right: "-0.2rem",
  top: "-0.55rem",
  fontSize: "10px",
  fontWeight: 700,
  color: "#b45309",
  background: "#fff7ed",
  border: "1px solid #fcd34d",
  borderRadius: "999px",
  padding: "0 4px",
  lineHeight: "14px",
  whiteSpace: "nowrap",
});

const pausedMarkStyle = css({
  position: "absolute",
  left: "-0.35rem",
  top: "-0.55rem",
  fontSize: "10px",
  lineHeight: "14px",
  color: "#b45309",
  background: "#fffbeb",
  border: "1px solid #fcd34d",
  borderRadius: "999px",
  padding: "0 4px",
});

const nowCursorStyle = css({
  position: "absolute",
  top: "-3px",
  bottom: "-3px",
  width: "0",
  borderLeft: "2px solid #111827",
  pointerEvents: "none",
});
