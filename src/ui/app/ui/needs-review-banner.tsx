import { css } from "remix/ui";

/**
 * Needs-review banner (spec §16.10): the run was resumed after an
 * interruption — the transcript may be incomplete; review before trusting.
 * Shown on run detail (and phase drill-in, §16.8) when the run is flagged.
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
  border: "1px solid #f3c14a",
  borderRadius: "8px",
  background: "rgba(243, 193, 74, 0.12)",
  color: "#92400e",
});

const bannerTextStyle = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
});
