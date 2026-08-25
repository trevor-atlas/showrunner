/**
 * Unit tests for the landing stats model (issue #40) — pure, no DOM,
 * following the test/ui/timeline-model.test.ts / charts-model.test.ts
 * convention. The model folds the GET /api/stats RunStats wire shape into the
 * UI-level buckets + chart data the KPI cards and the three charts render, so
 * the derivation is testable without a browser.
 *
 * Semantics pinned by #34's RunStats: `status_counts` is keyed by RAW
 * runs.status (queued is a pool state, folded OUT of `running` via
 * `queued_count`); `success_rate` is success ÷ (success + failed) only
 * (interrupted EXCLUDED from the denominator, shown as its own count) and null
 * on zero terminal runs; spend totals are reported vs estimated, separate.
 */
import { describe, expect, it } from "bun:test";

import type { RunStats } from "../../src/daemon/contract.ts";
import {
  activeCount,
  blueprintBarInputs,
  fmtAvgDuration,
  fmtSuccessRate,
  spendBarInputs,
  spendSeries,
  statusBuckets,
  statusSegments,
} from "../../src/server/ui/public/stats-model.ts";

/** A deterministic RunStats with overridable fields. */
function makeStats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    runs_count: 0,
    status_counts: {},
    queued_count: 0,
    success_rate: null,
    reported_usd: 0,
    estimated_usd: 0,
    avg_duration_ms: null,
    spend_by_day: [],
    blueprints: [],
    ...overrides,
  };
}

describe("statusBuckets", () => {
  it("folds queued OUT of raw running", () => {
    // raw running = 5, of which 2 are pool-queued → UI running is 3, queued 2
    const stats = makeStats({
      status_counts: { running: 5, paused: 1, success: 4, failed: 2, interrupted: 1 },
      queued_count: 2,
    });
    const b = statusBuckets(stats);
    expect(b.running).toBe(3);
    expect(b.queued).toBe(2);
    expect(b.paused).toBe(1);
    expect(b.success).toBe(4);
    expect(b.failed).toBe(2);
    expect(b.interrupted).toBe(1);
  });

  it("never yields a negative running bucket when queued_count meets running", () => {
    const stats = makeStats({ status_counts: { running: 2 }, queued_count: 2 });
    expect(statusBuckets(stats).running).toBe(0);
    expect(statusBuckets(stats).queued).toBe(2);
  });

  it("defaults missing status keys to zero", () => {
    const b = statusBuckets(makeStats({ status_counts: { success: 3 } }));
    expect(b.running).toBe(0);
    expect(b.paused).toBe(0);
    expect(b.queued).toBe(0);
    expect(b.failed).toBe(0);
    expect(b.interrupted).toBe(0);
    expect(b.success).toBe(3);
  });
});

describe("activeCount", () => {
  it("sums the folded running + paused + queued buckets only", () => {
    const stats = makeStats({
      status_counts: { running: 4, paused: 2, success: 9, failed: 3, interrupted: 5 },
      queued_count: 1, // 3 running, 1 queued
    });
    // 3 running + 2 paused + 1 queued = 6 (terminals + interrupted excluded)
    expect(activeCount(stats)).toBe(6);
  });
});

describe("statusSegments (donut geometry)", () => {
  it("emits one segment per present bucket with fractions summing to 1", () => {
    const stats = makeStats({
      status_counts: { running: 2, success: 6, failed: 2 },
      queued_count: 0,
    });
    const segments = statusSegments(stats);
    const buckets = segments.map((s) => s.bucket);
    expect(buckets).toEqual(["running", "success", "failed"]);
    const total = segments.reduce((sum, s) => sum + s.fraction, 0);
    expect(total).toBeCloseTo(1, 5);
    const running = segments.find((s) => s.bucket === "running")!;
    expect(running.count).toBe(2);
    expect(running.fraction).toBeCloseTo(0.2, 5);
  });

  it("omits zero-count buckets entirely (no empty slices)", () => {
    const stats = makeStats({ status_counts: { success: 3 } });
    const segments = statusSegments(stats);
    expect(segments).toHaveLength(1);
    expect(segments[0]!.bucket).toBe("success");
    expect(segments[0]!.fraction).toBeCloseTo(1, 5);
  });

  it("keeps queued and running as distinct segments after folding", () => {
    const stats = makeStats({ status_counts: { running: 3 }, queued_count: 1 });
    const buckets = statusSegments(stats).map((s) => s.bucket);
    expect(buckets).toEqual(["running", "queued"]);
  });
});

describe("fmtSuccessRate (null-rate + denominator display helper)", () => {
  it("renders a percentage for a real rate", () => {
    expect(fmtSuccessRate(0.75)).toBe("75%");
    expect(fmtSuccessRate(1)).toBe("100%");
    expect(fmtSuccessRate(0)).toBe("0%");
  });

  it("renders an em-dash placeholder for a null rate (zero terminal runs)", () => {
    expect(fmtSuccessRate(null)).toBe("—");
  });

  it("interrupted runs are excluded from the rate denominator", () => {
    // 3 success, 1 failed → 75%; the 10 interrupted runs must NOT dilute it
    const stats = makeStats({
      status_counts: { success: 3, failed: 1, interrupted: 10 },
      success_rate: 3 / 4,
    });
    expect(fmtSuccessRate(stats.success_rate)).toBe("75%");
    expect(statusBuckets(stats).interrupted).toBe(10);
  });
});

describe("fmtAvgDuration", () => {
  it("formats a duration in ms", () => {
    expect(fmtAvgDuration(90_000)).toBe("01:30");
  });

  it("renders an em-dash for a null average (no terminal duration)", () => {
    expect(fmtAvgDuration(null)).toBe("—");
  });
});

describe("spendSeries + spendBarInputs", () => {
  it("carries reported and estimated per day plus a derived total", () => {
    const stats = makeStats({
      spend_by_day: [
        { day: "2024-01-01", reported_usd: 1.5, estimated_usd: 0.5 },
        { day: "2024-01-02", reported_usd: 0, estimated_usd: 0 },
      ],
    });
    const series = spendSeries(stats);
    expect(series[0]).toEqual({
      day: "2024-01-01",
      reported_usd: 1.5,
      estimated_usd: 0.5,
      total_usd: 2,
    });
    // a zero-spend day is preserved gracefully (not dropped)
    expect(series[1]!.total_usd).toBe(0);
  });

  it("maps to bar inputs on total spend with a short day label", () => {
    const stats = makeStats({
      spend_by_day: [{ day: "2024-03-09", reported_usd: 2, estimated_usd: 1 }],
    });
    const bars = spendBarInputs(stats);
    expect(bars).toEqual([{ label: "03-09", value: 3 }]);
  });
});

describe("blueprintBarInputs", () => {
  it("maps blueprint usage to labelled bar inputs preserving order", () => {
    const stats = makeStats({
      blueprints: [
        { blueprint: "plan_build", runs: 7 },
        { blueprint: "scout", runs: 2 },
      ],
    });
    expect(blueprintBarInputs(stats)).toEqual([
      { label: "plan_build", value: 7 },
      { label: "scout", value: 2 },
    ]);
  });
});
