/**
 * Donut chart (issue #36) — a thin SVG over donut-model.ts. All the geometry
 * (fractions/offsets/angles) comes from the pure model; the component only
 * stroke-dasharrays each slice onto a shared ring, so there is no layout math
 * here to get wrong. No chart library. SSR-safe (static SVG), tokens only.
 *
 * Slices are drawn as dashed strokes on concentric `<circle>`s: dash length =
 * fraction × circumference, offset = cumulative fraction × circumference; the
 * whole ring is rotated -90° so the first slice starts at 12 o'clock (matching
 * the model's angle convention). Colors default to the #31 --chart-* tokens,
 * cycled.
 */
import { css, type Handle } from "remix/ui";

import { computeDonut } from "./donut-model.ts";

/** The default slice palette — the #31 chart tokens, cycled. */
const DEFAULT_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export interface DonutProps {
  values: readonly number[];
  /** the SVG's square viewBox side, in user units */
  size?: number;
  /** the ring thickness, in user units */
  thickness?: number;
  /** slice colors (CSS color strings); defaults to the --chart-* tokens */
  colors?: readonly string[];
  /** accessible name for the chart */
  ariaLabel?: string;
}

export function Donut(handle: Handle<DonutProps>) {
  return () => {
    const { values, size = 100, thickness = 18, colors = DEFAULT_COLORS, ariaLabel } = handle.props;
    const { slices } = computeDonut(values);
    const radius = (size - thickness) / 2;
    const cx = size / 2;
    const circumference = 2 * Math.PI * radius;
    return (
      <svg
        data-component="donut"
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={ariaLabel}
        mix={svgStyle}
      >
        <g transform={`rotate(-90 ${cx} ${cx})`}>
          <circle
            data-donut-track
            cx={cx}
            cy={cx}
            r={radius}
            fill="none"
            stroke="var(--muted)"
            strokeWidth={thickness}
          />
          {slices.map((slice, i) =>
            slice.fraction > 0 ? (
              <circle
                key={i}
                data-donut-slice
                data-fraction={slice.fraction}
                cx={cx}
                cy={cx}
                r={radius}
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth={thickness}
                strokeDasharray={`${slice.fraction * circumference} ${circumference}`}
                strokeDashoffset={`${-slice.offsetFraction * circumference}`}
              />
            ) : null,
          )}
        </g>
      </svg>
    );
  };
}

const svgStyle = css({
  display: "block",
  width: "100%",
  height: "auto",
});
