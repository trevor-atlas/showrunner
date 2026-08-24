/**
 * Unit tests for the chart geometry models (issue #36): donut slice
 * fractions/angles, horizontal-bar normalization, and line projection. Pure
 * math — NO DOM, following the test/ui/timeline-model.test.ts convention.
 */
import { describe, expect, it } from "bun:test";

import {
  computeDonut,
  polarPoint,
} from "../../src/ui/app/ui/public/components/charts/donut-model.ts";
import { computeBars } from "../../src/ui/app/ui/public/components/charts/bars-model.ts";
import { computeLine } from "../../src/ui/app/ui/public/components/charts/line-model.ts";

describe("computeDonut", () => {
  it("splits values into cumulative fractions starting at 12 o'clock", () => {
    const model = computeDonut([1, 1, 2]);
    expect(model.total).toBe(4);
    expect(model.slices).toHaveLength(3);
    expect(model.slices[0]!.fraction).toBeCloseTo(0.25, 5);
    expect(model.slices[0]!.offsetFraction).toBeCloseTo(0, 5);
    expect(model.slices[0]!.startAngle).toBeCloseTo(-90, 5);
    expect(model.slices[0]!.endAngle).toBeCloseTo(0, 5); // -90 + 0.25*360
    expect(model.slices[1]!.offsetFraction).toBeCloseTo(0.25, 5);
    expect(model.slices[2]!.fraction).toBeCloseTo(0.5, 5);
    expect(model.slices[2]!.endAngle).toBeCloseTo(270, 5); // full circle back to top
  });

  it("clamps negatives and non-finite values to zero", () => {
    const model = computeDonut([-5, 3, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(model.total).toBe(3);
    expect(model.slices[0]!.value).toBe(0);
    expect(model.slices[1]!.value).toBe(3);
    expect(model.slices[1]!.fraction).toBeCloseTo(1, 5);
  });

  it("yields zero fractions when the total is zero", () => {
    const model = computeDonut([0, 0]);
    expect(model.total).toBe(0);
    expect(model.slices.every((s) => s.fraction === 0)).toBe(true);
  });

  it("polarPoint places the top of a unit circle above the center", () => {
    const p = polarPoint(50, 50, 40, -90);
    expect(p.x).toBeCloseTo(50, 5);
    expect(p.y).toBeCloseTo(10, 5);
  });
});

describe("computeBars", () => {
  it("normalizes against the largest value by default", () => {
    const model = computeBars([
      { label: "a", value: 5 },
      { label: "b", value: 10 },
      { label: "c", value: 0 },
    ]);
    expect(model.max).toBe(10);
    expect(model.bars[0]!.fraction).toBeCloseTo(0.5, 5);
    expect(model.bars[1]!.fraction).toBeCloseTo(1, 5);
    expect(model.bars[2]!.fraction).toBe(0);
  });

  it("honors an explicit shared max and clamps negatives", () => {
    const model = computeBars([{ label: "a", value: -4 }, { label: "b", value: 5 }], { max: 20 });
    expect(model.max).toBe(20);
    expect(model.bars[0]!.value).toBe(0);
    expect(model.bars[0]!.fraction).toBe(0);
    expect(model.bars[1]!.fraction).toBeCloseTo(0.25, 5);
  });

  it("produces zero fractions when every value is zero", () => {
    const model = computeBars([{ label: "a", value: 0 }]);
    expect(model.max).toBe(0);
    expect(model.bars[0]!.fraction).toBe(0);
  });
});

describe("computeLine", () => {
  it("projects a series across the padded width and inverts the y axis", () => {
    const model = computeLine([0, 10], { width: 100, height: 40, padding: 0 });
    expect(model.min).toBe(0);
    expect(model.max).toBe(10);
    expect(model.points).toHaveLength(2);
    // first sample (min) sits at the bottom, second (max) at the top
    expect(model.points[0]!).toEqual({ x: 0, y: 40 });
    expect(model.points[1]!).toEqual({ x: 100, y: 0 });
    expect(model.path).toBe("M 0 40 L 100 0");
    expect(model.polyline).toBe("0,40 100,0");
  });

  it("rides the vertical middle for a flat series", () => {
    const model = computeLine([7, 7, 7], { width: 100, height: 40, padding: 0 });
    expect(model.points.every((p) => p.y === 20)).toBe(true);
    expect(model.points.map((p) => p.x)).toEqual([0, 50, 100]);
  });

  it("places a single sample at the left edge, mid height", () => {
    const model = computeLine([42], { width: 100, height: 40, padding: 2 });
    expect(model.points).toEqual([{ x: 2, y: 20 }]);
  });

  it("returns empty geometry for an empty series", () => {
    const model = computeLine([]);
    expect(model.points).toEqual([]);
    expect(model.path).toBe("");
    expect(model.polyline).toBe("");
  });

  it("treats non-finite samples as zero", () => {
    const model = computeLine([Number.NaN, 10], { width: 100, height: 40, padding: 0 });
    expect(model.min).toBe(0);
    expect(model.max).toBe(10);
    expect(model.points[0]!.y).toBe(40);
  });
});
