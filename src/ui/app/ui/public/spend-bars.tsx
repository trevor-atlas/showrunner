/**
 * Spend-over-time bars (issue #40) — a thin composition over #36's Bars SVG
 * primitive (components/charts/bars.tsx). One bar per run-start day (all-time,
 * no window toggle); the bar height is the TOTAL spend that day and the
 * reported-vs-estimated split rides in the per-bar aria-label (the total-spend
 * KPI card carries the headline split). The data→geometry (day labels, total
 * value, normalization) lives in stats-model.ts + #36's computeBars.
 *
 * A zero-spend day is preserved and renders a zero-width fill gracefully
 * (#34's non-blocking note) rather than being dropped. No `data-status` attrs.
 */
import { css, type Handle } from "remix/ui";

import type { RunStats } from "../../../../daemon/contract.ts";
import { Bars } from "./components/charts/bars.tsx";
import { fmtMoney } from "./format.ts";
import { spendBarInputs, spendSeries } from "./stats-model.ts";

export interface SpendBarsProps {
  stats: RunStats;
}

export function SpendBars(handle: Handle<SpendBarsProps>) {
  return () => {
    const series = spendSeries(handle.props.stats);
    const items = spendBarInputs(handle.props.stats);

    if (items.length === 0) {
      return (
        <div data-testid="spend-bars" data-chart="spend-bars" mix={emptyStyle}>
          no spend yet
        </div>
      );
    }

    const detail = series
      .map((d) => `${d.day}: ${fmtMoney(d.reported_usd)} reported, ${fmtMoney(d.estimated_usd)} estimated`)
      .join("; ");

    return (
      <div data-testid="spend-bars" data-chart="spend-bars" mix={wrapStyle}>
        <Bars items={items} ariaLabel={`spend by day — ${detail}`} />
      </div>
    );
  };
}

const wrapStyle = css({
  width: "100%",
});

const emptyStyle = css({
  fontSize: "var(--font-size-sm)",
  color: "var(--muted-foreground)",
  padding: "0.5rem 0",
});
