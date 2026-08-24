/**
 * Badge (issue #36) — a small status pill with five tones. Tone → the #31
 * status tokens (var(--…) only, no hardcoded color). Browser-bundle-safe
 * (public/, remix/ui only) and SSR-safe (a static inline element).
 */
import { css, type Handle, type RemixNode } from "remix/ui";

export type BadgeTone = "neutral" | "success" | "warning" | "destructive" | "info";

export interface BadgeProps {
  tone?: BadgeTone;
  children?: RemixNode;
}

export function Badge(handle: Handle<BadgeProps>) {
  return () => {
    const { tone = "neutral", children } = handle.props;
    return (
      <span data-component="badge" data-tone={tone} mix={[baseStyle, toneStyle[tone]]}>
        {children}
      </span>
    );
  };
}

const baseStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  borderRadius: "999px",
  padding: "0.1rem 0.5rem",
  fontSize: "var(--font-size-xs)",
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  lineHeight: 1.5,
  border: "1px solid transparent",
  whiteSpace: "nowrap",
});

const toneStyle: Record<BadgeTone, ReturnType<typeof css>> = {
  neutral: css({
    background: "var(--status-muted-soft)",
    color: "var(--muted-foreground)",
    borderColor: "var(--border)",
  }),
  success: css({
    background: "var(--status-success-soft)",
    color: "var(--status-success)",
    borderColor: "var(--status-success)",
  }),
  warning: css({
    background: "var(--status-interrupted-soft)",
    color: "var(--status-interrupted)",
    borderColor: "var(--status-interrupted)",
  }),
  destructive: css({
    background: "var(--status-failed-soft)",
    color: "var(--status-failed)",
    borderColor: "var(--status-failed)",
  }),
  info: css({
    background: "var(--status-running-soft)",
    color: "var(--status-running)",
    borderColor: "var(--status-running)",
  }),
};
