import { css } from "remix/ui";
import type { Handle, RemixNode } from "remix/ui";

/**
 * The phase drill-in's stacked-card shell: CONFIG / ENVELOPE / GATES /
 * SPEND / OUTPUT are one card each, in a linear stack (tabs deferred — v1
 * keeps it linear). Drill-in-only component set — T10a owns the shared
 * Gantt/EventFeed; this file is named `phase-drill-in/` so the ownership is
 * unambiguous.
 */
export interface CardProps {
  /** the uppercase card label, e.g. "CONFIG" */
  title: string;
  /** one-line summary after the title, e.g. "agent: builder · model: …" */
  summary?: string;
  children?: RemixNode;
}

export function Card(handle: Handle<CardProps>) {
  return () => (
    <section mix={cardStyle}>
      <header mix={cardHeaderStyle}>
        <h2 mix={cardTitleStyle}>{handle.props.title}</h2>
        {handle.props.summary ? <span mix={cardSummaryStyle}>{handle.props.summary}</span> : null}
      </header>
      <div mix={cardBodyStyle}>{handle.props.children}</div>
    </section>
  );
}

const cardStyle = css({
  display: "grid",
  gap: "0.6rem",
  padding: "0.9rem 1.1rem 1.1rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  background: "#fdfdfd",
});

const cardHeaderStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const cardTitleStyle = css({
  margin: 0,
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.09em",
  color: "#6b7280",
});

const cardSummaryStyle = css({
  fontSize: "13px",
  color: "#111827",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const cardBodyStyle = css({
  display: "grid",
  gap: "0.5rem",
  fontSize: "13px",
});

/** The mono face used across drill-in data rows. */
export const mono = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
});

/** Green check / red cross glyphs used by envelope + gate rows. */
export const okGlyph = "✓";
export const badGlyph = "✗";

/** A small inline badge (override badge, estimated marker). */
export function Badge(handle: Handle<{ tone?: "amber" | "green" | "grey"; children?: RemixNode }>) {
  return () => (
    <span
      mix={[badgeStyle, handle.props.tone === "green" ? badgeGreen : handle.props.tone === "grey" ? badgeGrey : badgeAmber]}
    >
      {handle.props.children}
    </span>
  );
}

const badgeStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.25rem",
  whiteSpace: "nowrap",
  fontSize: "11px",
  fontWeight: 700,
  padding: "1px 7px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const badgeAmber = css({ color: "#92400e", background: "rgba(243, 193, 74, 0.15)" });
const badgeGreen = css({ color: "#15803d", background: "rgba(21, 128, 61, 0.12)" });
const badgeGrey = css({ color: "#6b7280", background: "rgba(107, 114, 128, 0.12)" });

/** A mono <pre> used for JSON/prompt/raw blocks (overflowing content scrolls). */
export function Pre(handle: Handle<{ children?: RemixNode }>) {
  return () => <pre mix={preStyle}>{handle.props.children}</pre>;
}

const preStyle = css({
  margin: 0,
  padding: "0.6rem 0.75rem",
  overflow: "auto",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#f9fafb",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
  lineHeight: 1.5,
});
