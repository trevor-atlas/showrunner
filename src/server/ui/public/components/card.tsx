/**
 * Card (issue #36) — a titled section shell: a header (title + optional
 * summary) over a body slot. Browser-bundle-safe by construction (lives under
 * public/, imports only remix/ui) and styled exclusively with the #31 tokens
 * via `var(--…)`. SSR-safe: a plain element tree, no effects, no DOM access.
 */
import { css, type Handle, type RemixNode } from "remix/ui";

export interface CardProps {
  title: RemixNode;
  summary?: RemixNode;
  children?: RemixNode;
}

export function Card(handle: Handle<CardProps>) {
  return () => {
    const { title, summary, children } = handle.props;
    return (
      <section data-component="card" mix={cardStyle}>
        <header mix={headerStyle}>
          <h2 mix={titleStyle}>{title}</h2>
          {summary != null ? <p mix={summaryStyle}>{summary}</p> : null}
        </header>
        {children != null ? <div mix={bodyStyle}>{children}</div> : null}
      </section>
    );
  };
}

const cardStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--card)",
  color: "var(--card-foreground)",
  padding: "0.75rem 0.9rem",
});

const headerStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
});

const titleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-title)",
  fontFamily: "var(--font-sans)",
  fontWeight: 600,
  color: "var(--foreground)",
});

const summaryStyle = css({
  margin: 0,
  fontSize: "var(--font-size-sm)",
  color: "var(--muted-foreground)",
});

const bodyStyle = css({
  display: "flex",
  flexDirection: "column",
  gap: "0.5rem",
});
