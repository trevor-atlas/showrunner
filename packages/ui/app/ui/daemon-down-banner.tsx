import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import { routes } from "../routes.ts";

/**
 * Daemon-down banner (spec §16.10): the daemon socket is unreachable, so the
 * page shell still renders but no data rows appear. `retry` re-navigates to
 * the run list, which re-fetches GET /runs server-side.
 */
export interface DaemonDownBannerProps {
  /** "expected at <socket>" — the resolved daemon transport, §16.10 */
  expectedAt: string;
}

export function DaemonDownBanner(handle: Handle<DaemonDownBannerProps>) {
  return () => (
    <div data-state="daemon-down" role="alert" mix={bannerStyle}>
      <span mix={bannerTextStyle}>
        showrunner daemon is not running (expected at {handle.props.expectedAt})
      </span>
      <a href={routes.home.href()} mix={retryStyle}>
        retry
      </a>
    </div>
  );
}

const bannerStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  flexWrap: "wrap",
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

const retryStyle = css({
  appearance: "none",
  border: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: "12px",
  fontWeight: 700,
  textDecoration: "underline",
  cursor: "pointer",
});
