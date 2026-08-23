import type { Handle } from "remix/ui";
import { css } from "remix/ui";

import type { RunDetail } from "../../../../daemon/src/client.ts";
import { routes } from "../../routes.ts";
import { DaemonDownBanner } from "../../ui/daemon-down-banner.tsx";
import { fmtMoney, fmtRunId, fmtStartedAt } from "../../ui/format.ts";
import { NeedsReviewBanner } from "../../ui/needs-review-banner.tsx";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import type { LivePhase, RunLiveRegionProps } from "../public/run-live-region.tsx";
import { RunLiveRegion } from "../public/run-live-region.tsx";
import { StatusPill, isRunStatus, type RunStatus } from "../../ui/status-pill.tsx";
import { Document } from "../document.tsx";

/**
 * The run detail page (spec §16.7): header + control bar + gantt + live feed.
 * Server-rendered from the §13 detail endpoint + the FULL event history
 * (§4.3 — the cursor query IS the read transport, so a paused/completed run
 * renders its whole history here); the browser then polls the events.json
 * proxy and the hydrated live region re-renders gantt + feed (§16.5).
 *
 * Read-only: the control bar is DISPLAY ONLY (status, cwd, spend, needs
 * review badge) — the fail / resume / pause-menu controls are T10b's ticket,
 * nothing here is clickable for controls.
 *
 * A missing run renders the 404 page with a back-link (§16.10); a down
 * daemon renders the shell with the DaemonDownBanner instead of 500ing.
 */

export interface RunDetailPageProps {
  runId: string;
  /** null when the daemon is down (the shell still renders) */
  detail: RunDetail | null;
  /** the run's phases re-ordered into blueprint order (§16.7) */
  livePhases: LivePhase[];
  /** the full event history at load (initial feed + initial cursor) */
  events: FeedEvent[];
  /** the last event rowid — the poll loop starts from here (§4.3) */
  cursor: number;
  daemonDown: boolean;
  daemonAddress: string;
}

export function RunDetailPage(handle: Handle<RunDetailPageProps>) {
  return () => {
    const { runId, detail, livePhases, events, cursor, daemonDown, daemonAddress } = handle.props;

    if (detail === null) {
      return (
        <Document title={`Showrunner · ${fmtRunId(runId)}`}>
          <main mix={pageStyle}>
            <PageHeader runId={runId} blueprint="" status="running" />
            {daemonDown ? <DaemonDownBanner expectedAt={daemonAddress} /> : null}
          </main>
        </Document>
      );
    }

    const run = detail.run;
    const pillStatus = isRunStatus(run.status) ? run.status : "interrupted";
    const regionProps: RunLiveRegionProps = {
      runId,
      run: { started_at: run.started_at, ended_at: run.ended_at, status: run.status },
      phases: livePhases,
      events,
      cursor,
      eventsHref: routes.runs.events.href({ runId }),
    };

    return (
      <Document title={`Showrunner · ${run.blueprint} · ${fmtRunId(runId)}`}>
        <main mix={pageStyle}>
          <PageHeader runId={runId} blueprint={run.blueprint} status={pillStatus} />

          {/* §16.7 control bar — DISPLAY ONLY until T10b adds the verbs */}
          <div data-control-bar mix={controlBarStyle}>
            <span data-meta="status">{pillStatus}</span>
            <span data-meta="cwd" mix={monoStyle}>
              cwd {run.cwd}
            </span>
            <span data-meta="started" mix={monoStyle}>
              started {fmtStartedAt(run.started_at)}
            </span>
            {run.ended_at !== null ? (
              <span data-meta="ended" mix={monoStyle}>
                ended {fmtStartedAt(run.ended_at)}
              </span>
            ) : null}
            <span data-meta="spend" mix={monoStyle}>
              spend {fmtMoney(detail.spend_usd)}
            </span>
            {run.needs_review !== 0 ? (
              <span data-meta="needs-review" mix={needsReviewBadgeStyle}>
                ⚠ needs review
              </span>
            ) : null}
          </div>

          {run.needs_review !== 0 ? <NeedsReviewBanner /> : null}

          {daemonDown ? <DaemonDownBanner expectedAt={daemonAddress} /> : null}

          {daemonDown ? null : <RunLiveRegion {...regionProps} />}
        </main>
      </Document>
    );
  };
}

function PageHeader(handle: Handle<{ runId: string; blueprint: string; status: RunStatus }>) {
  return () => {
    const { runId, blueprint, status } = handle.props;
    return (
      <header mix={headerStyle}>
        <nav mix={breadcrumbStyle} aria-label="breadcrumb">
          <a href={routes.home.href()} mix={crumbLinkStyle}>
            ‹ runs
          </a>
        </nav>
        <h1 mix={titleStyle}>
          {blueprint === "" ? fmtRunId(runId) : blueprint}
          <span mix={runIdStyle}>{fmtRunId(runId)}</span>
          <StatusPill status={status} />
        </h1>
      </header>
    );
  };
}

/** §16.10 missing run — 404 with a back-link to the run list. */
export function NotFoundPage(handle: Handle<{ runId: string }>) {
  return () => (
    <Document title={`Showrunner · not found`}>
      <main mix={pageStyle}>
        <nav mix={breadcrumbStyle} aria-label="breadcrumb">
          <a href={routes.home.href()} mix={crumbLinkStyle}>
            ‹ runs
          </a>
        </nav>
        <h1 mix={titleStyle}>not found</h1>
        <p mix={notFoundTextStyle} data-state="not-found">
          run {handle.props.runId} not found —{" "}
          <a href={routes.home.href()} mix={crumbLinkStyle}>
            back to runs
          </a>
        </p>
      </main>
    </Document>
  );
}

const pageStyle = css({
  maxWidth: "60rem",
  margin: "0 auto",
  padding: "2rem 1.5rem",
  display: "grid",
  gap: "1.25rem",
});

const headerStyle = css({
  display: "grid",
  gap: "0.4rem",
});

const breadcrumbStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "12px",
});

const crumbLinkStyle = css({
  color: "#3573f6",
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" },
});

const titleStyle = css({
  margin: 0,
  fontSize: "18px",
  fontWeight: 800,
  letterSpacing: "-0.02em",
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const runIdStyle = css({
  fontSize: "11px",
  fontWeight: 500,
  color: "#9ca3af",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const controlBarStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
  padding: "0.5rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#f9fafb",
  fontSize: "12px",
  color: "#374151",
});

const monoStyle = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
});

const needsReviewBadgeStyle = css({
  color: "#92400e",
  background: "rgba(243, 193, 74, 0.2)",
  border: "1px solid #f3c14a",
  borderRadius: "999px",
  padding: "1px 10px",
  fontWeight: 700,
  fontSize: "11px",
});

const notFoundTextStyle = css({
  margin: 0,
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "13px",
});
