/**
 * Horizontal bar chart (issue #36) — a thin HTML/CSS view over bars-model.ts.
 * The model normalizes each value to a [0,1] fraction against a shared max; the
 * component draws one row per item as a label + a track with a fill whose width
 * is `fraction × 100%`. Rendered in plain HTML (not a stretched SVG) so labels
 * keep their real font size and bars never distort at any card width. No chart
 * library. SSR-safe (static element tree), tokens only.
 */
import { css, type Handle } from "remix/ui";

import { type BarInput, computeBars } from "./bars-model.ts";

export interface BarsProps {
  items: readonly BarInput[];
  /** hold several charts to one scale by pinning the max */
  max?: number;
  /** per-row height, in user units (kept for API compatibility; the CSS row
   * sizes itself to its content today) */
  rowHeight?: number;
  /** the label column width — a legacy 0–100 user-unit value from the SVG era,
   * mapped to a rem gutter (`labelWidth / 4`rem) so long labels get room */
  labelWidth?: number;
  ariaLabel?: string;
}

export function Bars(handle: Handle<BarsProps>) {
  return () => {
    const { items, max, labelWidth = 34, ariaLabel } = handle.props;
    const model = computeBars(items, max !== undefined ? { max } : {});
    const labelCol = `${(labelWidth / 4).toFixed(2)}rem`;

    return (
      <div data-component="bars" role="img" aria-label={ariaLabel} mix={wrapStyle}>
        {model.bars.map((bar) => (
          <div
            key={bar.label}
            data-bar
            data-fraction={bar.fraction}
            mix={rowStyle}
            style={{ gridTemplateColumns: `${labelCol} 1fr` }}
          >
            <span data-bar-label mix={labelStyle} title={bar.label}>
              {bar.label}
            </span>
            <span data-bar-track mix={trackStyle}>
              <span
                data-bar-fill
                mix={fillStyle}
                style={{ width: `${(bar.fraction * 100).toFixed(2)}%` }}
              />
            </span>
          </div>
        ))}
      </div>
    );
  };
}

const wrapStyle = css({
  display: "grid",
  gap: "0.4rem",
  width: "100%",
});

const rowStyle = css({
  display: "grid",
  alignItems: "center",
  gap: "0.6rem",
});

const labelStyle = css({
  fontSize: "var(--font-size-sm)",
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
});

const trackStyle = css({
  display: "block",
  height: "0.85rem",
  borderRadius: "4px",
  background: "var(--muted)",
  overflow: "hidden",
});

const fillStyle = css({
  display: "block",
  height: "100%",
  borderRadius: "4px",
  background: "var(--chart-1)",
});
