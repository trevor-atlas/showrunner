import { css } from "remix/ui";
import type { Handle } from "remix/ui";

/**
 * The shared run-status pill (spec §16.10, §16.6). Status → color/glyph:
 *
 *   running      ▶   blue, animated pulse
 *   paused       ⏸   amber
 *   success      ✓   green
 *   failed       ✗   red
 *   interrupted  ⚠   grey
 *   queued       ⏳   dim, with the §13.1 spawn-queue position when present
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

export interface StatusPillProps {
  status: RunStatus;
  /** §13.1: 1-based spawn-queue position — rendered for queued runs */
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
  fontSize: "12px",
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const STATUS_STYLES: Record<RunStatus, ReturnType<typeof css>> = {
  running: css({
    color: "#3573f6",
    background: "rgba(53, 115, 246, 0.1)",
    "@keyframes showrunner-running-pulse": {
      "0%": { opacity: 1 },
      "50%": { opacity: 0.35 },
      "100%": { opacity: 1 },
    },
    animation: "showrunner-running-pulse 1.4s ease-in-out infinite",
  }),
  paused: css({
    color: "#b45309",
    background: "rgba(180, 83, 9, 0.12)",
  }),
  success: css({
    color: "#15803d",
    background: "rgba(21, 128, 61, 0.12)",
  }),
  failed: css({
    color: "#b91c1c",
    background: "rgba(185, 28, 28, 0.12)",
  }),
  interrupted: css({
    color: "#6b7280",
    background: "rgba(107, 114, 128, 0.12)",
  }),
  queued: css({
    color: "#9ca3af",
    background: "rgba(156, 163, 175, 0.1)",
    opacity: 0.75,
  }),
};
