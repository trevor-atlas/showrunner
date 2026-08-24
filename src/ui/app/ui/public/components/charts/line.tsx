/**
 * Line/sparkline chart (issue #36) — a thin SVG over line-model.ts. The model
 * projects the series to viewBox points and precomputes the `path`/`polyline`
 * strings; the component only drops the path into an `<svg>` (plus an optional
 * area fill and end dot). No chart library. SSR-safe (static SVG), tokens only.
 */
import { css, type Handle } from "remix/ui";

import { computeLine } from "./line-model.ts";

export interface LineProps {
  values: readonly number[];
  width?: number;
  height?: number;
  padding?: number;
  /** fill the area under the line */
  area?: boolean;
  ariaLabel?: string;
}

export function Line(handle: Handle<LineProps>) {
  return () => {
    const { values, width = 100, height = 40, padding = 2, area = false, ariaLabel } = handle.props;
    const model = computeLine(values, { width, height, padding });
    const last = model.points[model.points.length - 1];
    const areaPath =
      area && model.points.length > 0 && model.points[0]
        ? `${model.path} L ${model.points[model.points.length - 1]!.x} ${height} L ${model.points[0].x} ${height} Z`
        : "";
    return (
      <svg
        data-component="line"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        mix={svgStyle}
      >
        {areaPath !== "" ? <path data-line-area d={areaPath} mix={areaStyle} /> : null}
        {model.path !== "" ? (
          <path
            data-line-path
            d={model.path}
            fill="none"
            vectorEffect="non-scaling-stroke"
            mix={lineStyle}
          />
        ) : null}
        {last != null ? <circle data-line-dot cx={last.x} cy={last.y} r={1.5} mix={dotStyle} /> : null}
      </svg>
    );
  };
}

const svgStyle = css({
  display: "block",
  width: "100%",
  height: "auto",
});

const lineStyle = css({
  stroke: "var(--chart-1)",
  strokeWidth: 1.5,
});

const areaStyle = css({
  fill: "var(--chart-1)",
  opacity: 0.15,
});

const dotStyle = css({
  fill: "var(--chart-1)",
});
