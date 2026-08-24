/**
 * IconButton (issue #36) — a square, icon-only button (the copy-to-clipboard
 * affordance the pages use). `aria-label` is REQUIRED because there is no text
 * child for a screen reader; the glyph is the `children` slot. `onClick` is
 * wired through the `on` mixin. Browser-bundle-safe (public/, remix/ui only),
 * SSR-safe.
 */
import { css, on, type Handle, type RemixNode } from "remix/ui";

export interface IconButtonProps {
  label: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
  children?: RemixNode;
}

export function IconButton(handle: Handle<IconButtonProps>) {
  return () => {
    const { label, disabled = false, onClick, children } = handle.props;
    return (
      <button
        data-component="icon-button"
        type="button"
        aria-label={label}
        title={label}
        disabled={disabled}
        mix={[baseStyle, onClick != null ? on("click", (event) => onClick(event as MouseEvent)) : null]}
      >
        {children}
      </button>
    );
  };
}

const baseStyle = css({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "1.75rem",
  height: "1.75rem",
  padding: 0,
  borderRadius: "6px",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--muted-foreground)",
  cursor: "pointer",
  "&:hover": {
    background: "var(--accent)",
    color: "var(--foreground)",
  },
  "&:disabled": {
    opacity: 0.55,
    cursor: "not-allowed",
  },
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});
