/**
 * Line/sparkline geometry (issue #36) — pure, no DOM. Maps a series of raw
 * values onto viewBox points and precomputes the SVG `path`/`polyline`
 * strings, so the component just drops the strings into an `<svg>`. Mirrors
 * the timeline-model.ts / timeline.tsx split (charts/line-model.test.ts covers
 * the projection with no DOM).
 *
 * The x axis spreads the samples evenly across the padded width; the y axis
 * maps the value range [min,max] onto the padded height, INVERTED so the
 * maximum sits at the top (small SVG y). A flat series (min === max) rides the
 * vertical middle; a single sample sits at the left edge; an empty series
 * yields no points and empty path strings.
 */

export interface LinePoint {
  x: number;
  y: number;
}

export interface LineModel {
  points: LinePoint[];
  /** an SVG path `d` ("M x y L x y …"), empty when there are no points */
  path: string;
  /** an SVG polyline `points` ("x,y x,y …"), empty when there are no points */
  polyline: string;
  /** the smallest sample value (0 when empty) */
  min: number;
  /** the largest sample value (0 when empty) */
  max: number;
  width: number;
  height: number;
}

export interface LineOptions {
  width?: number;
  height?: number;
  /** inner padding kept clear on every side, in viewBox units */
  padding?: number;
}

const DEFAULT_WIDTH = 100;
const DEFAULT_HEIGHT = 40;
const DEFAULT_PADDING = 2;

/** Round to 3 decimals so the emitted path strings stay compact and stable. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Project a numeric series into viewBox points and the matching SVG path
 * strings. Non-finite samples are treated as 0 so a bad datum never produces
 * NaN geometry.
 */
export function computeLine(values: readonly number[], opts: LineOptions = {}): LineModel {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const padding = opts.padding ?? DEFAULT_PADDING;

  const clean = values.map((v) => (Number.isFinite(v) ? v : 0));
  if (clean.length === 0) {
    return { points: [], path: "", polyline: "", min: 0, max: 0, width, height };
  }

  const min = clean.reduce((lo, v) => (v < lo ? v : lo), clean[0] ?? 0);
  const max = clean.reduce((hi, v) => (v > hi ? v : hi), clean[0] ?? 0);
  const span = max - min;

  const innerW = Math.max(0, width - padding * 2);
  const innerH = Math.max(0, height - padding * 2);
  const midY = padding + innerH / 2;

  const points: LinePoint[] = clean.map((value, i) => {
    const x = clean.length === 1 ? padding : padding + (innerW * i) / (clean.length - 1);
    // invert: max → top (padding), min → bottom (height - padding)
    const y = span === 0 ? midY : padding + innerH * (1 - (value - min) / span);
    return { x: round(x), y: round(y) };
  });

  const path = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");

  return { points, path, polyline, min, max, width, height };
}
