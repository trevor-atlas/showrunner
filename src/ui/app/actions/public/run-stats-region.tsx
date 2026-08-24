import { clientEntry, css, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { RunStats } from "../../../../daemon/contract.ts";
import { routes } from "../../routes.ts";
import { BlueprintBars } from "../../ui/public/blueprint-bars.tsx";
import { Card } from "../../ui/public/components/card.tsx";
import { KpiCards } from "../../ui/public/kpi-cards.tsx";
import { SpendBars } from "../../ui/public/spend-bars.tsx";
import { StatusDonut } from "../../ui/public/status-donut.tsx";
import { createCoalescedNotifier, subscribeSse, type SseSubscription } from "./sse.ts";

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
 * The refetch is wrapped in createCoalescedNotifier (#33/#38 lesson): a wake-up
 * that lands mid-refetch schedules EXACTLY ONE trailing rerun rather than being
 * dropped by the in-flight guard — so the last ledger change is never lost.
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
    let refetching = false;
    let subscription: SseSubscription | null = null;

    /** Refetch the /stats.json snapshot and re-render. Guarded so a slow
     * round-trip never stacks (the coalescer schedules the trailing rerun); a
     * transient failure keeps the last snapshot (the next ledger change
     * refetches). */
    const refetch = async (): Promise<void> => {
      if (refetching) return;
      refetching = true;
      try {
        const response = await fetch(handle.props.statsHref);
        if (!response.ok) return;
        stats = (await response.json()) as SerializableRunStats;
        await handle.update();
      } catch {
        // transient fetch/parse failure — keep the last snapshot; the next
        // ledger wake-up refetches
      } finally {
        refetching = false;
      }
    };

    // The live subscription is browser-only (setup also runs during SSR); arm
    // it once and tear it down on abort. Wake-ups drive refetch through the
    // coalescer so a change landing mid-refetch schedules one trailing rerun.
    if (typeof window !== "undefined") {
      const notify = createCoalescedNotifier(refetch);
      subscription = subscribeSse(routes.live.href(), { onchange: notify });
      handle.signal.addEventListener("abort", () => {
        if (subscription !== null) {
          subscription.unsubscribe();
          subscription = null;
        }
      });
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
