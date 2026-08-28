import { css, type Handle } from "remix/ui";

import type { TrajectoryView } from "../../../contract.ts";
import { TrajectoryFeed } from "./trajectory-feed.tsx";
import { TrajectorySwimlane } from "./trajectory-swimlane.tsx";

/**
 * The Trajectory tab composer (#84). For THIS ticket it owns the flat LOG
 * FEED and its loading / error / no-selection states; later tickets (#85
 * swimlanes, #86 drill-in, #87 zoom) extend it by widening these props, so the
 * seam stays: `{ view, loading, error }`. The per-phase lazy-fetch + cache +
 * SSR seed all live in the RunLiveRegion owner (the same pattern the phase
 * cards use) — the panel is a pure view of the resolved state.
 */
export interface TrajectoryPanelProps {
  /** the selected phase's parsed trajectory, or null (no phase selected, or
   * the fetch has not resolved) */
  view: TrajectoryView | null;
  /** the phase's trajectory fetch is in flight */
  loading: boolean;
  /** the fetch failed — the message to surface, or null */
  error: string | null;
}

export function TrajectoryPanel(handle: Handle<TrajectoryPanelProps>) {
  return () => {
    const { view, loading, error } = handle.props;
    return (
      <section data-testid="trajectory-panel" mix={panelStyle}>
        {error !== null ? (
          <p data-testid="trajectory-error" mix={stateStyle}>
            {error}
          </p>
        ) : loading ? (
          <p data-testid="trajectory-loading" mix={stateStyle}>
            loading trajectory…
          </p>
        ) : view === null ? (
          <p data-testid="trajectory-none" mix={stateStyle}>
            select a phase to see its trajectory
          </p>
        ) : (
          <>
            <TrajectorySwimlane view={view} />
            <TrajectoryFeed view={view} />
          </>
        )}
      </section>
    );
  };
}

const panelStyle = css({
  display: "grid",
  gap: "0.5rem",
});

const stateStyle = css({
  margin: 0,
  padding: "2rem 0.5rem",
  textAlign: "center",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});
