/**
 * Status-breakdown donut (issue #40) — a thin composition over #36's Donut SVG
 * primitive (components/charts/donut.tsx). The data→geometry lives in
 * stats-model.ts (statusSegments folds queued out of running and reuses #36's
 * computeDonut for the fractions); this component only maps the segments onto
 * the Donut and renders a legend.
 *
 * CRITICAL (issue #40 pin): the markup MUST NOT emit any `data-status="…"`
 * attribute — run-list.test.ts pins that a `?status=failed` page contains no
 * `data-status="running"/"success"` ANYWHERE, and this region renders on `/`
 * above the list. The legend keys off `data-bucket` + aria-labels instead, and
 * does NOT reuse StatusPill (which emits data-status).
 */
import { css, type Handle } from "remix/ui";

import type { RunStats } from "../../../daemon/contract.ts";
import { Donut } from "./components/charts/donut.tsx";
import { statusSegments, type StatusBucket } from "./stats-model.ts";

/** Per-bucket color — the #31 --status-* tokens, so the donut reads
 * semantically (green success, red failed, …) without a data-status attr. */
const BUCKET_COLORS: Record<StatusBucket, string> = {
  running: "var(--status-running)",
  paused: "var(--status-interrupted)",
  queued: "var(--status-queued)",
  success: "var(--status-success)",
  failed: "var(--status-failed)",
  interrupted: "var(--status-muted)",
};

export interface StatusDonutProps {
  stats: RunStats;
}

export function StatusDonut(handle: Handle<StatusDonutProps>) {
  return () => {
    const segments = statusSegments(handle.props.stats);
    const values = segments.map((s) => s.count);
    const colors = segments.map((s) => BUCKET_COLORS[s.bucket]);

    return (
      <div data-testid="status-donut" data-chart="status-donut" mix={wrapStyle}>
        <div mix={ringStyle}>
          <Donut values={values} colors={colors} ariaLabel="run status breakdown" />
        </div>
        <ul data-donut-legend mix={legendStyle}>
          {segments.map((s) => (
            <li
              key={s.bucket}
              data-bucket={s.bucket}
              aria-label={`${s.label}: ${s.count}`}
              mix={legendItemStyle}
            >
              <span aria-hidden="true" mix={swatchStyle} style={{ background: BUCKET_COLORS[s.bucket] }} />
              <span mix={legendLabelStyle}>{s.label}</span>
              <span data-bucket-count mix={legendCountStyle}>
                {s.count}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };
}

const wrapStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
});

const ringStyle = css({
  width: "8rem",
  flex: "0 0 auto",
});

const legendStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.25rem",
  flex: "1 1 8rem",
});

const legendItemStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const swatchStyle = css({
  display: "inline-block",
  width: "0.65rem",
  height: "0.65rem",
  borderRadius: "3px",
  flex: "0 0 auto",
});

const legendLabelStyle = css({
  textTransform: "lowercase",
  color: "var(--muted-foreground)",
});

const legendCountStyle = css({
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
});
