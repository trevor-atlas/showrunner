/**
 * Tooltip (issue #36) — an in-place hover/focus overlay.
 *
 * remix/ui has NO portals (verified: no portal export in the public API), and
 * the `remix/ui/popover` primitive that `Select` builds on renders in place but
 * is a click/anchor-driven surface with runtime positioning — heavier than a
 * tooltip needs and not hover-driven. So this is the ticket's documented
 * default: a plain absolutely-positioned span revealed by CSS `:hover` /
 * `:focus-within` on the wrapper. No JS state, no portal, no DOM access →
 * SSR-safe by construction, and the bubble is always in the markup (hidden via
 * opacity/visibility) so screen readers can still reach it and hydration is a
 * no-op. `role="tooltip"` + `aria-describedby` tie the bubble to the trigger.
 *
 * Browser-bundle-safe (public/, remix/ui only), tokens only.
 */
import { css, type Handle, type RemixNode } from "remix/ui";

export interface TooltipProps {
  /** the tooltip text/content shown on hover or focus */
  content: RemixNode;
  /** a stable id linking the bubble to the trigger for `aria-describedby` */
  id: string;
  children?: RemixNode;
}

export function Tooltip(handle: Handle<TooltipProps>) {
  return () => {
    const { content, id, children } = handle.props;
    return (
      <span data-component="tooltip" mix={wrapStyle}>
        <span data-tooltip-trigger aria-describedby={id} tabindex={0} mix={triggerStyle}>
          {children}
        </span>
        <span data-tooltip-bubble id={id} role="tooltip" mix={bubbleStyle}>
          {content}
        </span>
      </span>
    );
  };
}

const wrapStyle = css({
  position: "relative",
  display: "inline-flex",
  "&:hover [data-tooltip-bubble], &:focus-within [data-tooltip-bubble]": {
    opacity: 1,
    visibility: "visible",
  },
});

const triggerStyle = css({
  display: "inline-flex",
  alignItems: "center",
  cursor: "help",
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const bubbleStyle = css({
  position: "absolute",
  bottom: "calc(100% + 6px)",
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 20,
  maxWidth: "16rem",
  padding: "0.3rem 0.5rem",
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "var(--popover)",
  color: "var(--popover-foreground)",
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-sans)",
  lineHeight: 1.4,
  whiteSpace: "normal",
  boxShadow: "0 4px 12px var(--shadow-hover)",
  opacity: 0,
  visibility: "hidden",
  pointerEvents: "none",
});
