/**
 * The landing KPI cards (issue #40) — the four headline stats above the run
 * list, each a #36 Kpi block. The values/derivations come from stats-model.ts
 * (activeCount, fmtSuccessRate, fmtAvgDuration) + #36's fmtMoney; this
 * component only lays them out. No `data-status` attrs (the Kpi block keys off
 * data-kpi-*).
 *
 * The four cards, per the spec:
 *   1. runs count + active sub-count (running/paused/queued, queued folded)
 *   2. success rate (success ÷ success+failed) + interrupted shown separately
 *   3. spend — reported headline, estimated shown separately
 *   4. average run duration over TERMINAL runs (null → em-dash)
 */
import { css, type Handle } from "remix/ui";

import type { RunStats } from "../../contract.ts";
import { Kpi } from "./components/kpi.tsx";
import { fmtMoney } from "./format.ts";
import { activeCount, fmtAvgDuration, fmtSuccessRate, statusBuckets } from "./stats-model.ts";

export interface KpiCardsProps {
  stats: RunStats;
}

export function KpiCards(handle: Handle<KpiCardsProps>) {
  return () => {
    const { stats } = handle.props;
    const buckets = statusBuckets(stats);
    const active = activeCount(stats);

    return (
      <div data-testid="kpi-cards" mix={gridStyle}>
        <Kpi label="runs" value={stats.runs_count} sub={`${active} active`} />
        <Kpi
          label="success rate"
          value={fmtSuccessRate(stats.success_rate)}
          sub={`${buckets.interrupted} interrupted`}
        />
        <Kpi
          label="spend"
          value={fmtMoney(stats.reported_usd)}
          sub={`${fmtMoney(stats.estimated_usd)} estimated`}
        />
        <Kpi label="avg duration" value={fmtAvgDuration(stats.avg_duration_ms)} sub="terminal runs" />
      </div>
    );
  };
}

const gridStyle = css({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
  gap: "0.75rem",
});
