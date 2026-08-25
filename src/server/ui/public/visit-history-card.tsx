import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { TimelinePhase, TimelineSegment } from "../../../daemon/contract.ts";
import { fmtDuration, fmtStartedAt } from "./format.ts";
import { outcomeLabel, segmentDurationMs } from "./timeline-model.ts";
import { Card } from "./phase-card-shell.tsx";

/**
 * VISIT HISTORY card (issue #37) — the phase's visits newest first, each with
 * its interval/duration/outcome, correction + attempt counts, and the per-visit
 * cause narrative (on_fail banners link back to the causing phase via a
 * server-navigable `?phase=` deep link). Pure presentation, ported from the
 * timeline panel's VisitHistory/VisitBlock over the daemon TimelinePhase shape.
 */
export interface VisitHistoryCardProps {
  phase: TimelinePhase;
}

export function VisitHistoryCard(handle: Handle<VisitHistoryCardProps>) {
  return () => {
    const { phase } = handle.props;
    const visits = [...phase.segments].reverse(); // newest first
    return (
      <Card title="VISIT HISTORY" summary={visits.length === 0 ? "no visits" : `${visits.length} visit${visits.length === 1 ? "" : "s"}`}>
        {visits.length === 0 ? (
          <p data-visits-empty mix={emptyStyle}>no visits recorded for this phase</p>
        ) : (
          <ul mix={visitListStyle}>
            {visits.map((segment) => (
              <VisitBlock key={segment.visit} segment={segment} />
            ))}
          </ul>
        )}
      </Card>
    );
  };
}

function VisitBlock(handle: Handle<{ segment: TimelineSegment }>) {
  return () => {
    const { segment } = handle.props;
    const durationMs = segmentDurationMs(segment);
    const cause = segment.cause;
    return (
      <li data-visit-block data-visit={segment.visit} data-visit-outcome={segment.outcome} mix={visitBlockStyle}>
        <div mix={visitRowStyle}>
          <span data-visit-interval mix={monoStyle}>
            {fmtStartedAt(segment.started_at)} → {segment.ended_at !== null ? fmtStartedAt(segment.ended_at) : "now"}
          </span>
          <span data-visit-duration mix={monoStyle}>{fmtDuration(durationMs)}</span>
          <span data-visit-outcome-label mix={OUTCOME_TEXT_TONES[segment.outcome]}>{outcomeLabel(segment.outcome)}</span>
          {segment.corrections > 0 ? (
            <span data-visit-corrections mix={correctionsBadgeStyle}>
              ↻{segment.corrections} correction{segment.corrections === 1 ? "" : "s"}
            </span>
          ) : null}
          <span data-visit-attempts mix={monoStyle}>
            {segment.envelope_attempts} envelope attempt{segment.envelope_attempts === 1 ? "" : "s"}
          </span>
        </div>
        {cause === null ? (
          <p data-cause="prer2" mix={causeStyle}>Reason not recorded (run predates revisit causes).</p>
        ) : cause.kind === "on_fail" ? (
          <p data-cause="on_fail" mix={causeBannerStyle}>
            Visit {segment.visit} started because{" "}
            <a href={selectHref(cause.from_phase)} data-cause-phase={cause.from_phase} mix={causeLinkStyle}>
              {cause.from_phase}
            </a>{" "}
            (visit {cause.from_visit}) failed its gates and exhausted its budget.
          </p>
        ) : cause.kind === "human" ? (
          <p data-cause="human" mix={causeStyle}>
            Started by a human action — {cause.action}
            {cause.by !== undefined && cause.by !== null ? ` by ${cause.by}` : ""}.
          </p>
        ) : segment.visit > 1 ? (
          <p data-cause="flow-rerun" mix={causeStyle}>Re-ran in normal order after an upstream jump.</p>
        ) : null}
      </li>
    );
  };
}

/** A ?phase= deep link — server-navigable selection. */
function selectHref(phase: string): string {
  return `?phase=${encodeURIComponent(phase)}`;
}

const visitListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
});

const visitBlockStyle = css({
  display: "grid",
  gap: "0.25rem",
  padding: "0.45rem 0.6rem",
  borderLeft: "3px solid var(--border)",
  background: "var(--muted)",
});

const visitRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
  fontSize: "var(--font-size-sm)",
});

const monoStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const OUTCOME_TEXT_TONES: Record<string, ReturnType<typeof css>> = {
  in_progress: css({ color: "var(--status-running)", fontWeight: 600 }),
  success: css({ color: "var(--status-success)", fontWeight: 600 }),
  failed: css({ color: "var(--status-failed)", fontWeight: 600 }),
  interrupted: css({ color: "var(--status-interrupted)", fontWeight: 600 }),
  skipped: css({ color: "var(--status-muted)", fontWeight: 600 }),
};

const correctionsBadgeStyle = css({
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  color: "var(--status-interrupted)",
  background: "var(--amber-surface)",
  border: "1px solid var(--amber-border-soft)",
  borderRadius: "999px",
  padding: "0 6px",
  lineHeight: "16px",
  whiteSpace: "nowrap",
});

const causeStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const causeBannerStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--status-paused)",
  background: "var(--amber-soft)",
  border: "1px solid var(--amber-border)",
  borderRadius: "6px",
  padding: "0.3rem 0.5rem",
});

const causeLinkStyle = css({
  color: "var(--status-paused)",
  fontWeight: 700,
  textDecoration: "underline",
  "&:hover": {
    color: "var(--status-interrupted)",
  },
});

const emptyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});
