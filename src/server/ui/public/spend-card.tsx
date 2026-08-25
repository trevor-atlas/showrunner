import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import { fmtMoney, fmtTokens } from "./format.ts";
import { Card, mono } from "./phase-card-shell.tsx";

/**
 * SPEND card (issue #37) — per-phase token usage (in/out/cache r+w) and USD,
 * with the reported vs estimated (roster-derived) USD split marked so reported
 * dollars are never conflated with roster arithmetic. Pure presentation over
 * #35's spend.json proxy.
 *
 * There is NO truncated flag: issue #29 moved spend into the api core's exact
 * SQL SUM (no event sweep, no cap), so the token totals are always complete.
 * The old "spend truncated" affordance is intentionally gone.
 */
export interface SpendCardProps {
  /** tokens summed from the phase's spend, off the core's SQL SUM */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** reported USD for the phase (spend.json spendUsd) */
  spendUsd: number;
  /** estimated (roster-derived) USD for the phase (spend.json estimatedUsd) */
  estimatedUsd: number;
}

export function SpendCard(handle: Handle<SpendCardProps>) {
  return () => {
    const { tokensIn, tokensOut, cacheRead, cacheWrite, spendUsd, estimatedUsd } = handle.props;
    return (
      <Card
        title="SPEND"
        summary={`tokens in ${fmtTokens(tokensIn)} · out ${fmtTokens(tokensOut)} · cache r/w ${fmtTokens(cacheRead)}/${fmtTokens(cacheWrite)}`}
      >
        <div mix={rowStyle}>
          <span data-spend-usd mix={mono}>usd {fmtMoney(spendUsd)}</span>
          {estimatedUsd > 0 ? (
            <span data-spend-est mix={estStyle}>incl. est. {fmtMoney(estimatedUsd)} (roster estimate)</span>
          ) : null}
        </div>
      </Card>
    );
  };
}

const rowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const estStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--status-paused)",
  fontFamily: "var(--font-mono)",
});
