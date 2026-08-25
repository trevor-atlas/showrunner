/**
 * Donut-chart geometry (issue #36) — pure, no DOM. Turns a list of raw values
 * into per-slice fractions/offsets/angles so the SVG component only has to map
 * a fraction onto a stroked ring (stroke-dasharray) and never does its own
 * math. Mirrors the timeline-model.ts / timeline.tsx split: the layout is
 * testable without a DOM (charts/donut-model.test.ts).
 *
 * Angles are degrees, measured clockwise from 12 o'clock (-90° in standard
 * SVG orientation), so a caller can also draw arc paths or place labels via
 * `polarPoint`. Negative values are clamped to 0 — a donut has no negative
 * area.
 */

/** One slice of the donut, expressed as fractions of the whole ring plus the
 * absolute angles it spans. */
export interface DonutSlice {
  /** the slice's raw (clamped) value */
  value: number;
  /** value / total, in [0,1] (0 when the total is 0) */
  fraction: number;
  /** cumulative fraction of all slices BEFORE this one, in [0,1] */
  offsetFraction: number;
  /** start angle in degrees, clockwise from 12 o'clock */
  startAngle: number;
  /** end angle in degrees, clockwise from 12 o'clock */
  endAngle: number;
}

export interface DonutModel {
  slices: DonutSlice[];
  /** the sum of the clamped values */
  total: number;
}

/** 12 o'clock in standard SVG angle orientation (0° points along +x). */
const TOP_DEG = -90;

/** Clamp a value to a non-negative number, mapping NaN/Infinity to 0. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold raw values into donut slices. Slice order matches input order; the
 * first slice starts at 12 o'clock and each following slice continues
 * clockwise. When every value is 0 the total is 0 and each fraction is 0 (the
 * component then renders an empty track).
 */
export function computeDonut(values: readonly number[]): DonutModel {
  const clamped = values.map(nonNegative);
  const total = clamped.reduce((sum, v) => sum + v, 0);
  const slices: DonutSlice[] = [];
  let acc = 0;
  for (const value of clamped) {
    const fraction = total > 0 ? value / total : 0;
    const offsetFraction = acc;
    slices.push({
      value,
      fraction,
      offsetFraction,
      startAngle: TOP_DEG + offsetFraction * 360,
      endAngle: TOP_DEG + (offsetFraction + fraction) * 360,
    });
    acc += fraction;
  }
  return { slices, total };
}

/** A point on a circle at `angleDeg` (degrees, clockwise from +x axis in SVG
 * coordinates where y grows downward). Pure — used for arc paths and labels. */
export function polarPoint(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + radius * Math.cos(rad), y: cy + radius * Math.sin(rad) };
}
