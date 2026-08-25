import { css } from "remix/ui";
import type { Handle } from "remix/ui";

/**
 * The shared run-status pill. Status → color/glyph:
 *
 *   running      ▶   blue, animated pulse
 *   paused       ⏸   amber
 *   success      ✓   green
 *   failed       ✗   red
 *   interrupted  ⚠   grey
 *   queued       ⏳   dim, with the spawn-queue position when present
 */

export type RunStatus = "running" | "paused" | "success" | "failed" | "interrupted" | "queued";

export const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "paused",
  "success",
  "failed",
  "interrupted",
  "queued",
];

export function isRunStatus(value: string): value is RunStatus {
  return (RUN_STATUSES as readonly string[]).includes(value);
}

/** The UI-level status of a run row — a pool-queued run is "queued" even
 * though its row status is "running" until the pool starts it (F2). Moved here
 * (from run-list-page) so the browser list graph — the clientEntry + the pure
 * list model — can fold a run to its pill status without a server-only import. */
export function runStatus(run: { status: string; queue_position?: number | null }): RunStatus {
  if (run.queue_position !== null && run.queue_position !== undefined) return "queued";
  return isRunStatus(run.status) ? run.status : "interrupted";
}

export interface StatusPillProps {
  status: RunStatus;
  /** 1-based spawn-queue position — rendered for queued runs */
  queuePosition?: number | null;
}

export function StatusPill(handle: Handle<StatusPillProps>) {
  return () => {
    const { status, queuePosition } = handle.props;
    const label =
      status === "queued" && queuePosition !== null && queuePosition !== undefined
        ? `queued (${queuePosition})`
        : status;
    const glyph = GLYPHS[status] ?? "●";

    return (
      <span data-status={status} mix={[pillStyle, STATUS_STYLES[status]]}>
        {glyph} {label}
      </span>
    );
  };
}

const GLYPHS: Record<RunStatus, string> = {
  running: "▶",
  paused: "⏸",
  success: "✓",
  failed: "✗",
  interrupted: "⚠",
  queued: "⏳",
};

const pillStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  whiteSpace: "nowrap",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const STATUS_STYLES: Record<RunStatus, ReturnType<typeof css>> = {
  running: css({
    color: "var(--status-running)",
    background: "var(--status-running-soft)",
    "@keyframes showrunner-running-pulse": {
      "0%": { opacity: 1 },
      "50%": { opacity: 0.35 },
      "100%": { opacity: 1 },
    },
    animation: "showrunner-running-pulse 1.4s ease-in-out infinite",
  }),
  paused: css({
    color: "var(--status-interrupted)",
    background: "var(--status-interrupted-soft)",
  }),
  success: css({
    color: "var(--status-success)",
    background: "var(--status-success-soft)",
  }),
  failed: css({
    color: "var(--status-failed)",
    background: "var(--status-failed-soft)",
  }),
  interrupted: css({
    color: "var(--status-muted)",
    background: "var(--status-muted-soft)",
  }),
  queued: css({
    color: "var(--status-queued)",
    background: "var(--status-queued-soft)",
    opacity: 0.75,
  }),
};
