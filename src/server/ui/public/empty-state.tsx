import { css } from "remix/ui";
import type { Handle } from "remix/ui";

/**
 * Empty state: no runs yet — the one-line CTA that points at
 * the CLI's submit verb.
 */

export function EmptyState() {
  return () => (
    <div data-state="empty" mix={emptyStyle} role="status">
      <p mix={emptyTextStyle}>no runs yet — `showrunner run &lt;blueprint&gt;`</p>
    </div>
  );
}

const emptyStyle = css({
  padding: "3rem 1rem",
  textAlign: "center",
});

const emptyTextStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-md)",
});
