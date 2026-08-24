import { css } from "remix/ui";
import type { Handle, RemixNode } from "remix/ui";

/**
 * The shared shell for the browser-safe phase cards (issue #37): Card / Pre /
 * Badge plus the `mono` face and the ✓/✗ glyphs, ported from the server-only
 * `ui/phase-drill-in/card.tsx` into the public (browser) module graph so every
 * phase card renders through one shell. Pure presentation — props in, JSX out,
 * no `node:*` and no disk. Styles read the #31 design tokens (`var(--…)`), the
 * same surface `timeline-panel.tsx` already consumes, so the cards re-skin with
 * the theme instead of pinning literal hex. The old drill-in shell stays until
 * ticket 11 deletes it.
 */
export interface CardProps {
  /** the uppercase card label, e.g. "AGENT" */
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
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--card)",
});

const cardHeaderStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const cardTitleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-xs)",
  fontWeight: 800,
  letterSpacing: "0.09em",
  color: "var(--muted-foreground)",
});

const cardSummaryStyle = css({
  fontSize: "var(--font-size-md)",
  color: "var(--foreground)",
  fontFamily: "var(--font-mono)",
});

const cardBodyStyle = css({
  display: "grid",
  gap: "0.5rem",
  fontSize: "var(--font-size-md)",
});

/** The mono face used across card data rows. */
export const mono = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-md)",
  color: "var(--foreground)",
});

/** Green check / red cross glyphs used by envelope + gate rows. */
export const okGlyph = "✓";
export const badGlyph = "✗";

/** A small inline badge (override badge, estimated marker). */
export function Badge(handle: Handle<{ tone?: "amber" | "green" | "grey"; children?: RemixNode }>) {
  return () => (
    <span
      mix={[
        badgeStyle,
        handle.props.tone === "green" ? badgeGreen : handle.props.tone === "grey" ? badgeGrey : badgeAmber,
      ]}
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
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  padding: "1px 7px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const badgeAmber = css({ color: "var(--status-paused)", background: "var(--amber-soft)" });
const badgeGreen = css({ color: "var(--status-success)", background: "var(--status-success-soft)" });
const badgeGrey = css({ color: "var(--status-muted)", background: "var(--status-muted-soft)" });

/** A mono <pre> used for JSON/prompt/raw blocks (overflowing content scrolls). */
export function Pre(handle: Handle<{ children?: RemixNode }>) {
  return () => <pre mix={preStyle}>{handle.props.children}</pre>;
}

const preStyle = css({
  margin: 0,
  padding: "0.6rem 0.75rem",
  overflow: "auto",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--muted)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
  lineHeight: 1.5,
});
