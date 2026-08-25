import type { Handle } from "remix/ui";
import { css } from "remix/ui";

import type { EnvelopeRow, GateResultWithOverride } from "../../repository/db.ts";
import type { PauseView, RawTail, RunDetail, TimelineView } from "../../contract.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../lib/phase-data.ts";
import { routes } from "../../routes.ts";
import { fmtMoney, fmtRunId, fmtStartedAt } from "../../ui/format.ts";
import { NeedsReviewBanner } from "../../ui/needs-review-banner.tsx";
import { PauseMenu, type ControlError } from "../../ui/pause-menu.tsx";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import type {
  RunLiveRegionProps,
  SerializableAgentSession,
  SerializableEnvelopeRow,
  SerializableGateResult,
  SerializablePhaseInputs,
  SerializablePhaseOutputs,
  SerializablePhaseSnapshot,
  SerializablePhaseSpend,
  SerializableRawTail,
  SerializableTimelineView,
} from "../public/run-live-region.tsx";
import { RunLiveRegion } from "../public/run-live-region.tsx";
import { StatusPill, isRunStatus, type RunStatus } from "../../ui/public/status-pill.tsx";
import { Document } from "../document.tsx";

/**
 * The run detail page (R4/R5/R6): header + control bar +
 * timeline chart + detail panel + live feed. Server-rendered from the
 * detail endpoint, the R3 timeline view (per-visit segments), and the FULL
 * event history (the cursor query IS the read transport, so a paused/
 * completed run renders its whole history here); the browser then polls the
 * events.json + timeline.json proxies and the hydrated live region re-renders
 * the timeline's live edges + the feed (R6 — the timeline snapshot is
 * refetched each tick so open bubbles grow and new segments appear).
 *
 * R5 selection: the initial selection (the ?phase= deep link, validated, or
 * the auto-selected phase) is resolved server-side and its envelopes/gates
 * are server-rendered; later selections fetch through the proxies.
 *
 * T10b — the control surface: the control bar mounts the resume HEADER
 * action (only when the run is `interrupted`) and the pause menu
 * when the run is `paused`. Both post to remix POST routes that call
 * the server endpoints server-side; the browser never mutates server
 * state itself (no optimistic mutation).
 *
 * A missing run renders the 404 page with a back-link. The UI and
 * the server share one process (merged web server), so there is no "server
 * down" shell state.
 */

export interface RunDetailPageProps {
  runId: string;
  /** the detail payload for the run */
  detail: RunDetail;
  /** the R3 timeline view — the chart + panel render from it */
  timeline: TimelineView;
  /** the R5 initial selection: the ?phase= deep link (validated) or the
   * auto-selected phase; null only when no phase is selectable */
  initialSelection: string | null;
  /** the initial selection's envelopes/gates — server-rendered (R5) */
  initialEnvelopes: EnvelopeRow[];
  initialGates: GateResultWithOverride[];
  /** the initial selection's #35 card surfaces — server-rendered (#41);
   * null only when no phase is selectable */
  initialSnapshot: PhaseSnapshotData | null;
  initialInputs: PhaseInputsData | null;
  initialOutputs: PhaseOutputsData | null;
  initialSpend: PhaseSpendData | null;
  /** the run-scoped RAW TRANSCRIPT tail — server-rendered (#41) */
  initialRaw: RawTail;
  /** the full event history at load (initial feed + initial cursor) */
  events: FeedEvent[];
  /** the last event rowid — the poll loop starts from here */
  cursor: number;
  /** the pause viewer — the menu renders from it when the run is paused */
  pause: PauseView | null;
  /** the FAILED gate names on the paused phase — the override select options */
  overrideGates: string[];
  /** the pending control error (from the last failed control POST), or null */
  controlError: ControlError | null;
}

export function RunDetailPage(handle: Handle<RunDetailPageProps>) {
  return () => {
    const {
      runId,
      detail,
      timeline,
      initialSelection,
      initialEnvelopes,
      initialGates,
      initialSnapshot,
      initialInputs,
      initialOutputs,
      initialSpend,
      initialRaw,
      events,
      cursor,
      pause,
      overrideGates,
      controlError,
    } = handle.props;

    const run = detail.run;
    const pillStatus = isRunStatus(run.status) ? run.status : "interrupted";
    const regionProps: RunLiveRegionProps = {
      runId,
      // the client-entry boundary: the server wire values are plain JSON, so
      // the SerializableProps widening is structural only (see the region's
      // Serializable* types)
      timeline: timeline as unknown as SerializableTimelineView,
      initialSelection,
      initialEnvelopes: initialEnvelopes as unknown as SerializableEnvelopeRow[],
      initialGates: initialGates as unknown as SerializableGateResult[],
      // #41: the initial selection's #35 card surfaces + the RAW tail widened
      // at the client-entry boundary (plain JSON, structural widening only)
      initialSnapshot: initialSnapshot as unknown as SerializablePhaseSnapshot | null,
      initialInputs: initialInputs as unknown as SerializablePhaseInputs | null,
      initialOutputs: initialOutputs as unknown as SerializablePhaseOutputs | null,
      initialSpend: initialSpend as unknown as SerializablePhaseSpend | null,
      initialRaw: initialRaw as unknown as SerializableRawTail,
      rawHref: routes.runs.raw.href({ runId }),
      sessions: detail.sessions as unknown as SerializableAgentSession[],
      events,
      cursor,
      eventsHref: routes.runs.events.href({ runId }),
      // the run-scoped SSE change stream the live region subscribes to — each
      // change wake-up drives one events.json + timeline.json refetch
      liveHref: routes.runs.live.href({ runId }),
      // R6: the live region refetches the timeline on each change through the
      // timeline.json proxy (new segments + open bubbles growing to now)
      timelineHref: routes.runs.timeline.href({ runId }),
      // R6 pause surfacing: the pause viewer's reason (fetched above when
      // the run is paused at SSR) — the panel header renders it; mid-poll
      // transitions ride the run_status → paused event's reason instead
      pauseReason: pause?.reason ?? null,
    };

    // resume is a HEADER action for INTERRUPTED runs only — never part
    // of the pause menu. A pending resume error keeps the control rendered so
    // the 409/validation failure stays visible on the form.
    const showResume = run.status === "interrupted" || controlError?.verb === "resume";
    // the pause menu renders when the run is paused (the pause state +
    // kind come from the pause viewer).
    const showMenu = run.status === "paused" && pause !== null && pause.paused;

    return (
      <Document title={`Showrunner · ${run.blueprint} · ${fmtRunId(runId)}`}>
        <main mix={pageStyle}>
          <PageHeader runId={runId} blueprint={run.blueprint} status={pillStatus} />

          {/* control bar — status, cwd, started/ended, spend, needs
          review badge, and the resume HEADER action (interrupted runs) */}
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
            {showResume ? (
              <span mix={resumeControlStyle}>
                <form method="post" action={routes.runs.resume.href({ runId })} data-form="resume">
                  <button type="submit" mix={resumeButtonStyle}>
                    resume
                  </button>
                </form>
                {controlError?.verb === "resume" ? (
                  <span mix={resumeErrorStyle} data-form-error data-error-for="resume" role="alert">
                    {controlError.message}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>

          {run.needs_review !== 0 ? <NeedsReviewBanner /> : null}

          {showMenu ? (
            <PauseMenu
              runId={runId}
              phase={pause.phase ?? ""}
              kind={pause.kind ?? "unknown"}
              reason={pause.reason ?? null}
              actions={pause.actions ?? []}
              queuedSteers={pause.queued_steers ?? []}
              overrideGates={overrideGates}
              error={controlError}
            />
          ) : null}

          <RunLiveRegion {...regionProps} />
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

/** missing run — 404 with a back-link to the run list. */
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
  maxWidth: "120rem",
  margin: "0 auto",
  padding: "2rem 2rem",
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
  fontSize: "var(--font-size-sm)",
});

const crumbLinkStyle = css({
  color: "var(--status-running)",
  textDecoration: "none",
  "&:hover": { textDecoration: "underline" },
});

const titleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-title)",
  fontWeight: 800,
  letterSpacing: "-0.02em",
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const runIdStyle = css({
  fontSize: "var(--font-size-xs)",
  fontWeight: 500,
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-mono)",
});

const controlBarStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexWrap: "wrap",
  padding: "0.5rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--muted)",
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const monoStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
});

const needsReviewBadgeStyle = css({
  color: "var(--status-paused)",
  background: "var(--amber-soft-strong)",
  border: "1px solid var(--amber-border)",
  borderRadius: "999px",
  padding: "1px 10px",
  fontWeight: 700,
  fontSize: "var(--font-size-xs)",
});

const resumeControlStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.6rem",
});

const resumeButtonStyle = css({
  appearance: "none",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  padding: "3px 14px",
  borderRadius: "999px",
  border: "1px solid var(--input)",
  background: "var(--card)",
  color: "var(--foreground)",
  cursor: "pointer",
  "&:hover": {
    background: "var(--secondary)",
  },
});

const resumeErrorStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--status-failed)",
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
});

const notFoundTextStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-md)",
});
