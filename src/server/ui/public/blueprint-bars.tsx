/**
 * Blueprint-popularity bars (issue #40) — a thin composition over #36's Bars
 * SVG primitive (components/charts/bars.tsx). One horizontal bar per blueprint
 * (already sorted desc by run count server-side), width = fraction of the most
 * used blueprint (from #36's computeBars, invoked inside Bars). The
 * data→geometry lives in stats-model.ts (blueprintBarInputs). No `data-status`
 * attrs.
 */
import { css, type Handle } from "remix/ui";

import type { RunStats } from "../../../daemon/contract.ts";
import { Bars } from "./components/charts/bars.tsx";
import { blueprintBarInputs } from "./stats-model.ts";

export interface BlueprintBarsProps {
  stats: RunStats;
}

export function BlueprintBars(handle: Handle<BlueprintBarsProps>) {
  return () => {
    const items = blueprintBarInputs(handle.props.stats);

    if (items.length === 0) {
      return (
        <div data-testid="blueprint-bars" data-chart="blueprint-bars" mix={emptyStyle}>
          no blueprints yet
        </div>
      );
    }

    return (
      <div data-testid="blueprint-bars" data-chart="blueprint-bars" mix={wrapStyle}>
        <Bars items={items} labelWidth={40} ariaLabel="runs per blueprint" />
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
