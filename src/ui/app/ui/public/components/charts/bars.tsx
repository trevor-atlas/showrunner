/**
 * Horizontal bar chart (issue #36) — a thin SVG over bars-model.ts. The model
 * normalizes each value to a [0,1] fraction against a shared max; the component
 * just draws a track rect and a fill rect (width = fraction × trackWidth) per
 * row and a `<text>` label. No chart library. SSR-safe (static SVG), tokens
 * only.
 */
import { css, type Handle } from "remix/ui";

import { type BarInput, computeBars } from "./bars-model.ts";

export interface BarsProps {
  items: readonly BarInput[];
  /** hold several charts to one scale by pinning the max */
  max?: number;
  /** per-row height in user units */
  rowHeight?: number;
  /** left gutter reserved for labels, in user units */
  labelWidth?: number;
  ariaLabel?: string;
}

const VIEW_WIDTH = 100;

export function Bars(handle: Handle<BarsProps>) {
  return () => {
    const { items, max, rowHeight = 22, labelWidth = 34, ariaLabel } = handle.props;
    const model = computeBars(items, max !== undefined ? { max } : {});
    const barGap = 6;
    const barH = rowHeight - barGap;
    const trackWidth = VIEW_WIDTH - labelWidth;
    const height = Math.max(rowHeight, model.bars.length * rowHeight);
    return (
      <svg
        data-component="bars"
        viewBox={`0 0 ${VIEW_WIDTH} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
        mix={svgStyle}
      >
        {model.bars.map((bar, i) => {
          const y = i * rowHeight;
          return (
            <g key={bar.label} data-bar data-fraction={bar.fraction}>
              <text
                x={0}
                y={y + rowHeight / 2}
                dominantBaseline="middle"
                mix={labelTextStyle}
              >
                {bar.label}
              </text>
              <rect
                data-bar-track
                x={labelWidth}
                y={y + (rowHeight - barH) / 2}
                width={trackWidth}
                height={barH}
                rx={2}
                mix={trackStyle}
              />
              <rect
                data-bar-fill
                x={labelWidth}
                y={y + (rowHeight - barH) / 2}
                width={trackWidth * bar.fraction}
                height={barH}
                rx={2}
                mix={fillStyle}
              />
            </g>
          );
        })}
      </svg>
    );
  };
}

const svgStyle = css({
  display: "block",
  width: "100%",
  height: "auto",
});

const labelTextStyle = css({
  fill: "var(--muted-foreground)",
  fontSize: "9px",
  fontFamily: "var(--font-sans)",
});

const trackStyle = css({
  fill: "var(--muted)",
});

const fillStyle = css({
  fill: "var(--chart-1)",
});
