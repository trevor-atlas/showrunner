import { css } from "remix/ui";
import type { Handle } from "remix/ui";

/**
 * Empty state (spec §16.10): no runs yet — the one-line CTA that points at
 * the CLI's submit verb. Rendered only when the daemon is up and the list is
 * empty (a down daemon renders the DaemonDownBanner instead).
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
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
});
