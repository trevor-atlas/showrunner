import { css } from "remix/ui";

/**
 * Needs-review banner: the run was resumed after an
 * interruption — the transcript may be incomplete; review before trusting.
 * Shown on run detail (and phase drill-in) when the run is flagged.
 */
export function NeedsReviewBanner() {
  return () => (
    <div data-state="needs-review" role="alert" mix={bannerStyle}>
      <span mix={bannerTextStyle}>
        ⚠ resumed after an interruption — the transcript may be incomplete; review before trusting
      </span>
    </div>
  );
}

const bannerStyle = css({
  padding: "0.6rem 1rem",
  border: "1px solid var(--amber-border)",
  borderRadius: "8px",
  background: "var(--amber-soft)",
  color: "var(--status-paused)",
});

const bannerTextStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
});
