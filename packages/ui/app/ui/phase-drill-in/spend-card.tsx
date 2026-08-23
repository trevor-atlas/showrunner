import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import { fmtMoney, fmtTokens } from "../format.ts";
import { Card, mono } from "./card.tsx";

/**
 * SPEND card (§16.8) — per-phase token usage (in/out/cache r+w) and USD, from
 * the §6 #12 spend events. USD splits reported vs estimated (§11.1): the
 * daemon's spend endpoint reports per-phase `spend_usd` and
 * `estimated_spend_usd` (the roster-derived half, flagged `estimated: true` in
 * the events) — the card marks the estimate so reported dollars are never
 * conflated with roster arithmetic.
 */

export interface SpendCardProps {
  /** tokens summed from the phase's spend events */
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** reported USD for the phase (spend endpoint spend_usd) */
  spendUsd: number;
  /** estimated USD for the phase (spend endpoint estimated_spend_usd) */
  estimatedUsd: number;
  /** true when the spend sweep hit its safety cap — the token totals are partial */
  truncated?: boolean;
}

export function SpendCard(handle: Handle<SpendCardProps>) {
  return () => {
    const { tokensIn, tokensOut, cacheRead, cacheWrite, spendUsd, estimatedUsd, truncated = false } = handle.props;
    return (
      <Card
        title="SPEND"
        summary={`tokens in ${fmtTokens(tokensIn)} · out ${fmtTokens(tokensOut)} · cache r/w ${fmtTokens(cacheRead)}/${fmtTokens(cacheWrite)}`}
      >
        <div mix={rowStyle}>
          <span mix={mono}>usd {fmtMoney(spendUsd)}</span>
          {estimatedUsd > 0 ? <span mix={estStyle}>incl. est. {fmtMoney(estimatedUsd)} (roster estimate)</span> : null}
          {truncated ? (
            <span mix={truncatedStyle} data-spend-truncated>
              ⚠ older spend omitted (past the sweep cap) — token totals are partial
            </span>
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
  fontSize: "11px",
  color: "#92400e",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const truncatedStyle = css({
  fontSize: "11px",
  color: "#b91c1c",
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});
