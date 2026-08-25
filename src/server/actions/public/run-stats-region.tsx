import { clientEntry, css, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { RunStats } from "../../contract.ts";
import { routes } from "../../routes.ts";
import { BlueprintBars } from "../../ui/public/blueprint-bars.tsx";
import { Card } from "../../ui/public/components/card.tsx";
import { KpiCards } from "../../ui/public/kpi-cards.tsx";
import { SpendBars } from "../../ui/public/spend-bars.tsx";
import { StatusDonut } from "../../ui/public/status-donut.tsx";
import { startLiveSnapshot, type LiveApplyOutcome } from "./live-snapshot.ts";

/**
 * The landing stats region, LIVE (issue #40). Server-rendered once from the
 * in-process getStats() snapshot (SSR renders the KPI cards + the three charts
 * exactly like the list SSRs its table), then the browser SUBSCRIBES to the
 * GLOBAL ledger change stream (`GET /live.sse`) while the page is open: every
 * "runs ledger changed" wake-up refetches the `/stats.json` snapshot proxy,
 * replaces the stats snapshot, and re-renders.
 *
 * This is the SAME live seam landing-live-list (#39) uses — two INDEPENDENT
 * coalesced subscribers to the one global ledger (one for the list, one for
 * stats). The substrate supports many subscribers and this is localhost/cheap,
 * so a shared-singleton subscription would be over-engineering; the region owns
 * its own subscription and tears it down on abort.
 *
 * The SSE→refetch transport is the shared startLiveSnapshot adapter (#57): the
 * region hands it the global change-stream href + an `apply` that refetches the
 * snapshot proxy and swaps the stats snapshot; the adapter owns WHEN
 * (coalescing + the in-flight guard so a wake-up mid-refetch schedules EXACTLY
 * ONE trailing rerun — the last ledger change is never lost). This is a
 * single-snapshot region: `apply` always returns "applied" (a transient
 * failure keeps the last snapshot; the stream never stops).
 *
 * The browser NEVER talks to the daemon: it only refetches the rendered
 * snapshot proxy (the iron convention). getStats() is server-only and lives in
 * the controller action, never in this clientEntry graph.
 */

/** The client-entry boundary widens the daemon wire type (RunStats) with the
 * SerializableProps index signature — the values are plain JSON (exactly what
 * the /stats.json proxy returns), so the widening is structural only. */
export type SerializableRunStats = RunStats & SerializableObject;

export interface RunStatsRegionProps extends SerializableProps {
  /** the initial stats snapshot (all-time); replaced wholesale by every
   * /stats.json refetch */
  stats: SerializableRunStats;
  /** the /stats.json snapshot proxy href (routes.homeStats.href()) */
  statsHref: string;
}

export const RunStatsRegion = clientEntry(
  import.meta.url,
  function RunStatsRegion(handle: Handle<RunStatsRegionProps>) {
    // ── setup scope — runs once (also server-side during SSR) ──────────────
    let stats: RunStats = handle.props.stats;

    /** The adapter's refetch: pull the /stats.json snapshot and swap the stats.
     * Single-snapshot region — a transient failure (non-ok or a fetch/parse
     * throw) keeps the last snapshot and returns "applied" so the stream keeps
     * listening (the next ledger change refetches); there is no terminal/gone
     * branch for the global stats. */
    const apply = async (): Promise<LiveApplyOutcome> => {
      try {
        const response = await fetch(handle.props.statsHref);
        if (response.ok) {
          stats = (await response.json()) as SerializableRunStats;
          await handle.update();
        }
      } catch {
        // transient fetch/parse failure — keep the last snapshot; the next
        // ledger wake-up refetches
      }
      return "applied";
    };

    // The live transport is browser-only (setup also runs during SSR); arm the
    // adapter once and tear it down on abort. The adapter owns the SSE
    // subscription, the coalescing, and the in-flight guard.
    if (typeof window !== "undefined") {
      const live = startLiveSnapshot({ href: routes.live.href(), apply });
      handle.signal.addEventListener("abort", () => live.stop());
    }

    return () => (
      <div data-region="run-stats" data-testid="run-stats-region" mix={regionStyle}>
        <KpiCards stats={stats} />
        <div mix={chartsStyle}>
          <Card title="status breakdown">
            <StatusDonut stats={stats} />
          </Card>
          <Card title="spend over time">
            <SpendBars stats={stats} />
          </Card>
          <Card title="blueprint popularity">
            <BlueprintBars stats={stats} />
          </Card>
        </div>
      </div>
    );
  },
);

const regionStyle = css({
  display: "grid",
  gap: "1rem",
});

const chartsStyle = css({
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(15rem, 1fr))",
  gap: "1rem",
  alignItems: "start",
});
