/**
 * Button (issue #36) — four variants (primary / secondary / ghost /
 * destructive) over the #31 tokens. A real `<button>` so it is keyboard- and
 * screen-reader-native; `onClick` is wired through the `on` mixin so it works
 * once hydrated and is inert (but present) during SSR. Browser-bundle-safe
 * (public/, remix/ui only).
 */
import { css, on, type Handle, type RemixNode } from "remix/ui";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";

export interface ButtonProps {
  variant?: ButtonVariant;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
  children?: RemixNode;
}

export function Button(handle: Handle<ButtonProps>) {
  return () => {
    const { variant = "primary", type = "button", disabled = false, onClick, children } = handle.props;
    return (
      <button
        data-component="button"
        data-variant={variant}
        type={type}
        disabled={disabled}
        mix={[
          baseStyle,
          variantStyle[variant],
          onClick != null ? on("click", (event) => onClick(event as MouseEvent)) : null,
        ]}
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
  gap: "0.35rem",
  borderRadius: "8px",
  padding: "0.35rem 0.75rem",
  fontSize: "var(--font-size-md)",
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  lineHeight: 1.4,
  cursor: "pointer",
  border: "1px solid transparent",
  "&:disabled": {
    opacity: 0.55,
    cursor: "not-allowed",
  },
  "&:focus-visible": {
    outline: "2px solid var(--ring)",
    outlineOffset: "1px",
  },
});

const variantStyle: Record<ButtonVariant, ReturnType<typeof css>> = {
  primary: css({
    background: "var(--primary)",
    color: "var(--primary-foreground)",
    borderColor: "var(--primary)",
  }),
  secondary: css({
    background: "var(--secondary)",
    color: "var(--secondary-foreground)",
    borderColor: "var(--border)",
  }),
  ghost: css({
    background: "transparent",
    color: "var(--foreground)",
    borderColor: "transparent",
    "&:hover": {
      background: "var(--accent)",
    },
  }),
  destructive: css({
    background: "var(--destructive)",
    color: "var(--destructive-foreground)",
    borderColor: "var(--destructive)",
  }),
};
