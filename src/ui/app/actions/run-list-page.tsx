import type { Handle } from "remix/ui";
import { css } from "remix/ui";

import type { RunListItem, RunStats } from "../../../daemon/contract.ts";
import { routes } from "../routes.ts";
import { Document } from "./document.tsx";
import { RunListLive, type SerializableRunListItem } from "./public/run-list-live.tsx";
import { RunStatsRegion, type SerializableRunStats } from "./public/run-stats-region.tsx";

/**
 * The run list page. Server-rendered: `runs` come from GET /runs
 * through the api core in-process; the browser sees the rendered HTML on first
 * paint. The page shell (the document + heading) stays server-side; the live
 * toolbar + table are the `RunListLive` clientEntry, which SSR-renders the
 * initial (filtered) rows and then goes push-live off the `/live.sse` ledger
 * stream (issue #39) — the old manual refresh button is gone.
 *
 * The UI and the daemon share one process (merged web server), so there is no
 * "daemon down" shell state.
 */

export interface RunListPageProps {
  runs: RunListItem[];
  /** the all-time landing stats (issue #40) — fed to the RunStatsRegion
   * clientEntry above the list; filter-independent (?status= never narrows it) */
  stats: RunStats;
  /** current status filter ("all" or a RunStatus) — the SSR deep link */
  filter: string;
  /** filter options — "all" then every RunStatus */
  statuses: string[];
}

export function RunListPage(handle: Handle<RunListPageProps>) {
  return () => {
    const { runs, stats, filter, statuses } = handle.props;
    const title = `Showrunner · runs`;

    return (
      <Document title={title}>
        <main mix={pageStyle}>
          <header mix={headerStyle}>
            <h1 mix={titleStyle}>Showrunner · runs</h1>
          </header>

          <RunStatsRegion
            // the client-entry boundary: RunStats is plain daemon JSON, so the
            // SerializableProps widening is structural only (same `as unknown
            // as` the list region uses)
            stats={stats as unknown as SerializableRunStats}
            statsHref={routes.homeStats.href()}
          />

          <RunListLive
            // the client-entry boundary: the daemon wire values are plain JSON,
            // so the SerializableProps widening is structural only (see the
            // region's SerializableRunListItem type)
            runs={runs as unknown as SerializableRunListItem[]}
            statuses={statuses}
            filter={filter}
            runsHref={routes.homeRuns.href()}
          />
        </main>
      </Document>
    );
  };
}

const pageStyle = css({
  maxWidth: "60rem",
  margin: "0 auto",
  padding: "2rem 1.5rem",
  display: "grid",
  gap: "1.25rem",
});

const headerStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
});

const titleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-title)",
  fontWeight: 800,
  letterSpacing: "-0.02em",
});
