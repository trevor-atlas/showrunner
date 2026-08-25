/**
 * Kpi (issue #36) — a single stat block: a muted label above a large value,
 * with an optional sub line (delta / unit / context). Browser-bundle-safe
 * (public/, remix/ui only), tokens only, SSR-safe (static element tree).
 */
import { css, type Handle, type RemixNode } from "remix/ui";

export interface KpiProps {
  label: RemixNode;
  value: RemixNode;
  sub?: RemixNode;
}

export function Kpi(handle: Handle<KpiProps>) {
  return () => {
    const { label, value, sub } = handle.props;
    return (
      <div data-component="kpi" mix={kpiStyle}>
        <span data-kpi-label mix={labelStyle}>
          {label}
        </span>
        <span data-kpi-value mix={valueStyle}>
          {value}
        </span>
        {sub != null ? (
          <span data-kpi-sub mix={subStyle}>
            {sub}
          </span>
        ) : null}
      </div>
    );
  };
}

const kpiStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  padding: "0.6rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--card)",
  color: "var(--card-foreground)",
});

const labelStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--muted-foreground)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  fontFamily: "var(--font-sans)",
});

const valueStyle = css({
  fontSize: "var(--font-size-title)",
  fontWeight: 600,
  color: "var(--foreground)",
  fontFamily: "var(--font-sans)",
});

const subStyle = css({
  fontSize: "var(--font-size-sm)",
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-sans)",
});
