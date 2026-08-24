/**
 * Horizontal-bar geometry (issue #36) — pure, no DOM. Normalizes labelled
 * values against a shared maximum so the SVG/DOM component only maps a
 * fraction to a width. Mirrors the timeline-model.ts / timeline.tsx split
 * (charts/bars-model.test.ts covers the math with no DOM).
 *
 * The max defaults to the largest value in the set, so the tallest bar fills
 * the track; pass an explicit `max` to hold several charts to one scale.
 * Negative values are clamped to 0.
 */

export interface BarInput {
  label: string;
  value: number;
}

export interface Bar {
  label: string;
  /** the clamped value */
  value: number;
  /** value / max, in [0,1] (0 when max is 0) */
  fraction: number;
}

export interface BarsModel {
  bars: Bar[];
  /** the scale maximum the fractions are relative to */
  max: number;
}

/** Clamp a value to a non-negative number, mapping NaN/Infinity to 0. */
function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Fold labelled inputs into normalized bars. When `opts.max` is omitted the
 * scale is the largest clamped value (so the widest bar is full); when every
 * value is 0 (or an explicit max of 0) each fraction is 0.
 */
export function computeBars(items: readonly BarInput[], opts: { max?: number } = {}): BarsModel {
  const values = items.map((item) => nonNegative(item.value));
  const derivedMax = values.reduce((hi, v) => (v > hi ? v : hi), 0);
  const max = opts.max !== undefined ? nonNegative(opts.max) : derivedMax;
  const bars = items.map((item, i) => {
    const value = values[i] ?? 0;
    return { label: item.label, value, fraction: max > 0 ? value / max : 0 };
  });
  return { bars, max };
}
