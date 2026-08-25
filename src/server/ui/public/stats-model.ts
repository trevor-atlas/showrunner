/**
 * The landing stats model (issue #40) — pure, no DOM. It folds the GET
 * /api/stats RunStats wire shape (#34) into the UI-level buckets + chart data
 * the KPI cards and the three charts render, so the derivation is testable
 * without a browser (test/ui/stats-model.test.ts). Mirrors the
 * timeline-model.ts / list-model.ts data→geometry split.
 *
 * The chart geometry is DELEGATED to #36's pure chart models
 * (charts/donut-model.ts + charts/bars-model.ts) — this module only produces
 * the ordered domain data (which buckets, which bars) and reuses computeDonut
 * for the donut fractions; the chart components feed the same data into #36's
 * SVG primitives. No SVG math is reimplemented here.
 *
 * Semantics pinned by #34's RunStats:
 *  - `status_counts` is keyed by RAW runs.status; queued is a pool state, NOT a
 *    DB status, so it rides in `queued_count` and is folded OUT of `running`;
 *  - `success_rate` is success ÷ (success + failed) only — interrupted is NOT
 *    in the denominator (shown as its own count) — and null on zero terminal
 *    runs;
 *  - spend totals are reported vs estimated, kept separate;
 *  - `spend_by_day` may include zero-spend buckets — they are preserved, not
 *    dropped.
 */

import type { RunStats } from "../../../daemon/contract.ts";
import { computeDonut } from "./components/charts/donut-model.ts";
import type { BarInput } from "./components/charts/bars-model.ts";
import { fmtDuration } from "./format.ts";

/** The UI-level status buckets — `queued` is folded out of raw `running`, so
 * these are the buckets the donut + the active KPI count reason about (NOT the
 * raw DB statuses). */
export type StatusBucket = "running" | "paused" | "queued" | "success" | "failed" | "interrupted";

/** Donut + legend order: live states first (running → paused → queued), then
 * terminals (success → failed), then interrupted. */
export const STATUS_BUCKET_ORDER: readonly StatusBucket[] = [
  "running",
  "paused",
  "queued",
  "success",
  "failed",
  "interrupted",
];

export type StatusBuckets = Record<StatusBucket, number>;

/**
 * Fold the raw `status_counts` + `queued_count` into UI buckets. A pool-queued
 * run has a RAW status of `running` until the pool starts it, so `queued` is
 * subtracted out of `running` (clamped at 0 so a transient over-count never
 * yields a negative bucket).
 */
export function statusBuckets(stats: RunStats): StatusBuckets {
  const counts = stats.status_counts;
  const rawRunning = counts.running ?? 0;
  return {
    running: Math.max(0, rawRunning - stats.queued_count),
    paused: counts.paused ?? 0,
    queued: stats.queued_count,
    success: counts.success ?? 0,
    failed: counts.failed ?? 0,
    interrupted: counts.interrupted ?? 0,
  };
}

/** The active KPI sub-count — running (folded) + paused + queued (terminals
 * and interrupted excluded). */
export function activeCount(stats: RunStats): number {
  const buckets = statusBuckets(stats);
  return buckets.running + buckets.paused + buckets.queued;
}

/** One donut segment: the bucket, its human label, count, and the fraction of
 * the whole ring (from #36's computeDonut, so the geometry is not re-derived). */
export interface StatusSegment {
  bucket: StatusBucket;
  label: string;
  count: number;
  fraction: number;
}

/**
 * The donut segments — one per PRESENT bucket (zero-count buckets omitted so
 * the donut has no empty slices), in STATUS_BUCKET_ORDER. Fractions come from
 * #36's computeDonut over the bucket counts.
 */
export function statusSegments(stats: RunStats): StatusSegment[] {
  const buckets = statusBuckets(stats);
  const present = STATUS_BUCKET_ORDER.filter((bucket) => buckets[bucket] > 0);
  const donut = computeDonut(present.map((bucket) => buckets[bucket]));
  return present.map((bucket, i) => ({
    bucket,
    label: bucket,
    count: buckets[bucket],
    fraction: donut.slices[i]?.fraction ?? 0,
  }));
}

/** One day of spend: reported vs estimated (kept separate) plus a derived
 * total for the bar height. Zero-spend days are preserved. */
export interface SpendDay {
  day: string;
  reported_usd: number;
  estimated_usd: number;
  total_usd: number;
}

/** The spend-by-day series with a derived total per day. */
export function spendSeries(stats: RunStats): SpendDay[] {
  return stats.spend_by_day.map((d) => ({
    day: d.day,
    reported_usd: d.reported_usd,
    estimated_usd: d.estimated_usd,
    total_usd: d.reported_usd + d.estimated_usd,
  }));
}

/** Spend-over-time bar inputs — one bar per day, height = TOTAL spend
 * (reported + estimated); the reported/estimated split is surfaced in the
 * chart's per-bar aria-label + the total-spend KPI card. Day label is the
 * MM-DD tail of the UTC date. */
export function spendBarInputs(stats: RunStats): BarInput[] {
  return spendSeries(stats).map((d) => ({ label: d.day.slice(5), value: d.total_usd }));
}

/** Blueprint-popularity bar inputs — one bar per blueprint (already sorted
 * desc by run count server-side), label = blueprint, value = run count. */
export function blueprintBarInputs(stats: RunStats): BarInput[] {
  return stats.blueprints.map((b) => ({ label: b.blueprint, value: b.runs }));
}

/** Success-rate display: a whole-percent string, or an em-dash placeholder
 * when null (zero terminal runs). */
export function fmtSuccessRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Average-duration display: mm:ss (or h:mm:ss) via #36's fmtDuration, or an
 * em-dash when null (no terminal run has a measurable duration). */
export function fmtAvgDuration(ms: number | null): string {
  return ms === null ? "—" : fmtDuration(ms);
}
