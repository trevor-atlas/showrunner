import { css } from "remix/ui";
import type { Handle, RemixNode } from "remix/ui";


import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../repository/db.ts";
import type { TimelinePhase, TimelineView } from "../../contract.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../lib/phase-data.ts";
import { fmtMoney, fmtTime } from "./format.ts";
import { lifetime } from "./timeline-model.ts";
import { AgentCard } from "./agent-card.tsx";
import { PhaseConfigCard } from "./phase-config-card.tsx";
import { InputsCard } from "./inputs-card.tsx";
import { OutputsCard } from "./outputs-card.tsx";
import { EnvelopeCard } from "./envelope-card.tsx";
import { GatesCard } from "./gates-card.tsx";
import { SpendCard } from "./spend-card.tsx";
import { SessionsCard } from "./sessions-card.tsx";
import { VisitHistoryCard } from "./visit-history-card.tsx";

/**
 * The folded phase detail (issue #41) — the selected phase's full record,
 * rendered below the timeline chart as a compact HEADER plus a labelled grid
 * of the #37 pure-presentation cards. This replaces the old drill-in PAGE: the
 * separate `/runs/:runId/phases/:phase` route is gone; selecting a phase (a
 * chart bubble click or a `?phase=` deep link) renders its record here.
 *
 * The header carries the phase's identity/lifecycle facts (name, agent, status
 * chip, visit count, current-visit corrections/budget, lifetime) plus the
 * paused-reason banner. Spend deliberately does NOT live in the header — it
 * lives ONLY in the SPEND card (one render site per number).
 *
 * The card data is LAZY: the initial selection's cards are server-rendered by
 * renderRunDetail (which seeds the region cache); later selections fetch the
 * six phase proxies client-side (envelopes/gates + the four #35 surfaces). The
 * per-phase cards load on SELECTION, not on the SSE signal (#38 kept per-card
 * signal refetch out of scope) — the region hands this component whatever the
 * cache holds (`null` = loading; the *Error flag = the fetch failed). Sessions
 * feed from RunDetail.sessions (no proxy) and visit history from the live
 * timeline snapshot (both already in the region).
 *
 * This component lives in the BROWSER module graph (it renders inside the
 * run-live-region clientEntry), so it consumes the #37 cards under public/ and
 * only imports server-only modules for their TYPES.
 */

export interface TimelinePanelProps {
  runId: string;
  /** the LIVE timeline (the R6-refetched snapshot with the tracked status
   * overlaid) — the phase lookup, visit-history card, and paused banner read it */
  timeline: TimelineView;
  /** the selected phase name, or null (R5) */
  selected: string | null;
  /** agent sessions for ALL phases — filtered to the selected phase here */
  sessions: AgentSessionRow[];
  /** the selected phase's card surfaces; null while loading / after an error */
  envelopes: EnvelopeRow[] | null;
  gates: GateResultWithOverride[] | null;
  snapshot: PhaseSnapshotData | null;
  inputs: PhaseInputsData | null;
  outputs: PhaseOutputsData | null;
  spend: PhaseSpendData | null;
  envelopesError: boolean;
  gatesError: boolean;
  snapshotError: boolean;
  inputsError: boolean;
  outputsError: boolean;
  spendError: boolean;
  /** the pause viewer's reason while the run is paused (null otherwise) —
   * surfaced in the phase header; live transitions ride the run_status →
   * paused event (run-live-region captures it), SSR rides getPause */
  pauseReason: string | null;
  /** the live feed + raw transcript, owned by the region (interactive state
   * lives there) — the panel places it in the left column under ENVELOPE so
   * the running log sits beside the accepted-envelope narrative */
  feedSlot?: RemixNode;
}

export function TimelinePanel(handle: Handle<TimelinePanelProps>) {
  return () => {
    const props = handle.props;
    const { timeline, selected, pauseReason } = props;
    const phase = selected !== null ? (timeline.phases.find((p) => p.name === selected) ?? null) : null;

    return (
      <section data-testid="phase-detail" data-selected={selected ?? ""} mix={panelStyle}>
        {/* the pause reason surfaces in the phase header while the run is
        paused — the same value the pause viewer reports (getPause at SSR;
        the run_status → paused event's reason on a live transition) */}
        {timeline.status === "paused" && pauseReason !== null && pauseReason !== "" ? (
          <p data-panel-pause-reason mix={pausedBannerStyle}>
            ⏸ paused — {pauseReason}
          </p>
        ) : null}
        {phase === null ? (
          <>
            <p data-panel-empty mix={emptyStyle}>select a phase to see its record</p>
            {props.feedSlot ?? null}
          </>
        ) : (
          <>
            <PhaseHeader phase={phase} />
            <PhaseCards phase={phase} props={props} />
          </>
        )}
      </section>
    );
  };
}

// ── the phase header (identity + lifecycle, NO spend) ────────────────────────

function PhaseHeader(handle: Handle<{ phase: TimelinePhase }>) {
  return () => {
    const { phase } = handle.props;
    const last = phase.segments.length > 0 ? phase.segments[phase.segments.length - 1]! : null;
    const life = lifetime(phase);
    const lifetimeLabel =
      life.startMs !== null
        ? `${fmtTime(new Date(life.startMs).toISOString())} → ${life.endMs !== null ? fmtTime(new Date(life.endMs).toISOString()) : "now"}`
        : "—";
    return (
      <header data-phase-header mix={headerStyle}>
        <div mix={headerRowStyle}>
          <span data-phase-name mix={phaseTitleStyle}>{phase.name}</span>
          <span data-phase-agent mix={monoStyle}>agent {phase.agent}</span>
          <PhaseChip status={phase.status} />
        </div>
        <div mix={metaRowStyle}>
          <span data-panel-visits>
            {phase.segments.length} {phase.segments.length === 1 ? "visit" : "visits"}
          </span>
          <span data-panel-budget title="corrections issued in the current visit vs the phase's visit budget">
            {last !== null ? `corrections ${last.corrections} / budget ${phase.budget}` : "no visits yet"}
          </span>
          <span data-panel-lifetime mix={monoStyle}>lifetime {lifetimeLabel}</span>
        </div>
      </header>
    );
  };
}

/** The phase-status chip — same status tokens as the SPA (status-pill.tsx). */
function PhaseChip(handle: Handle<{ status: string }>) {
  return () => {
    const { status } = handle.props;
    return (
      <span data-phase-chip data-phase-chip-status={status} mix={[chipStyle, CHIP_TONES[status] ?? chipDim]}>
        <span aria-hidden mix={chipDotStyle} />
        {status.replace("_", " ")}
      </span>
    );
  };
}

const CHIP_TONES: Record<string, ReturnType<typeof css>> = {
  in_progress: css({ color: "var(--status-running)", background: "var(--status-running-soft)" }),
  success: css({ color: "var(--status-success)", background: "var(--status-success-soft)" }),
  failed: css({ color: "var(--status-failed)", background: "var(--status-failed-soft)" }),
  skipped: css({ color: "var(--status-muted)", background: "var(--status-muted-soft)" }),
  pending: css({ color: "var(--status-queued)", background: "var(--status-queued-soft)" }),
};

// ── the card grid ────────────────────────────────────────────────────────────

/**
 * The labelled card grid: AGENT, PHASE CONFIG, INPUTS, OUTPUTS, ENVELOPE,
 * GATES, SPEND, SESSIONS, VISIT HISTORY. Each card is wrapped in a
 * `data-card="…"` slot (stable selector so tests key off testids, not prose).
 * Snapshot-derived cards (AGENT/PHASE CONFIG) and the four proxy-backed cards
 * render a loading/error placeholder until their data arrives; sessions +
 * visit history are always available (region-owned).
 */
function PhaseCards(handle: Handle<{ phase: TimelinePhase; props: TimelinePanelProps }>) {
  return () => {
    const { phase, props } = handle.props;
    const {
      sessions,
      envelopes,
      gates,
      snapshot,
      inputs,
      outputs,
      spend,
      envelopesError,
      gatesError,
      snapshotError,
      inputsError,
      outputsError,
      spendError,
    } = props;
    const phaseSessions = sessions.filter((s) => s.phase_id === phase.phase_id);

    return (
      <div data-testid="phase-cards" mix={columnsStyle}>
        {/* left column: the content-heavy ENVELOPE narrative + the live feed
        (its own column so their height never leaves a void beside the short
        sections on the right) */}
        <div mix={colStyle}>
          <CardSlot name="envelope" loading={envelopes === null} error={envelopesError} kind="envelope">
            {envelopes !== null ? <EnvelopeCard envelopes={envelopes} /> : null}
          </CardSlot>
          {props.feedSlot ?? null}
        </div>
        {/* right column: the compact policy / io / accounting sections */}
        <div mix={colStyle}>
          <CardSlot name="outputs" loading={outputs === null} error={outputsError} kind="outputs">
            {outputs !== null ? (
              <OutputsCard files={outputs.files} findingsMd={outputs.findingsMd} envelopes={envelopes ?? []} />
            ) : null}
          </CardSlot>
          <CardSlot name="gates" loading={gates === null} error={gatesError} kind="gates">
            {gates !== null ? <GatesCard gates={gates} /> : null}
          </CardSlot>
          <CardSlot name="agent" loading={snapshot === null} error={snapshotError} kind="agent">
            {snapshot !== null ? <AgentCard phase={snapshot.phase} context={snapshot.context} /> : null}
          </CardSlot>
          <CardSlot name="phase-config" loading={snapshot === null} error={snapshotError} kind="phase config">
            {snapshot !== null ? <PhaseConfigCard phase={snapshot.phase} /> : null}
          </CardSlot>
          <CardSlot name="inputs" loading={inputs === null} error={inputsError} kind="inputs">
            {inputs !== null ? <InputsCard files={inputs.files} isFirst={inputs.isFirst} /> : null}
          </CardSlot>
          <CardSlot name="spend" loading={spend === null} error={spendError} kind="spend">
            {spend !== null ? (
              <SpendCard
                tokensIn={spend.tokensIn}
                tokensOut={spend.tokensOut}
                cacheRead={spend.cacheRead}
                cacheWrite={spend.cacheWrite}
                spendUsd={spend.spendUsd}
                estimatedUsd={spend.estimatedUsd}
              />
            ) : null}
          </CardSlot>
          <CardSlot name="sessions" loading={false} error={false} kind="sessions">
            <SessionsCard sessions={phaseSessions} />
          </CardSlot>
          <CardSlot name="visit-history" loading={false} error={false} kind="visit history">
            <VisitHistoryCard phase={phase} />
          </CardSlot>
        </div>
      </div>
    );
  };
}

/** One card slot: a stable `data-card` wrapper that shows the card, or a
 * loading / error placeholder while the phase's data is in flight (#41 lazy
 * fetch). SSR-seeded selections always have data, so the placeholders only
 * appear during a client-side selection round-trip. */
function CardSlot(
  handle: Handle<{ name: string; kind: string; loading: boolean; error: boolean; children?: RemixNode }>,
) {
  return () => {
    const { name, kind, loading, error, children } = handle.props;
    return (
      <div data-card={name} mix={slotStyle}>
        {error ? (
          <p data-card-error mix={errorStyle}>couldn't load {kind}</p>
        ) : loading ? (
          <p data-card-loading mix={emptyStyle}>loading {kind}…</p>
        ) : (
          children
        )}
      </div>
    );
  };
}

// ── styles ───────────────────────────────────────────────────────────────────

const panelStyle = css({
  display: "grid",
  gap: "0.75rem",
});

/** the paused-reason banner in the phase header — amber, matching the pause
 * menu's visual language. */
const pausedBannerStyle = css({
  margin: 0,
  padding: "0.4rem 0.7rem",
  border: "1px solid var(--amber-border)",
  borderRadius: "8px",
  background: "var(--amber-soft-faint)",
  color: "var(--amber-ink)",
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-mono)",
});

const emptyStyle = css({
  margin: 0,
  padding: "0.65rem 0.5rem",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});

const errorStyle = css({
  margin: 0,
  padding: "0.65rem 0.5rem",
  color: "var(--status-failed)",
  fontSize: "var(--font-size-sm)",
  fontWeight: 600,
});

const headerStyle = css({
  display: "grid",
  gap: "0.4rem",
  padding: "0.9rem 1.1rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--card)",
});

const headerRowStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const phaseTitleStyle = css({
  fontSize: "var(--font-size-title)",
  fontWeight: 800,
  color: "var(--foreground)",
  letterSpacing: "-0.02em",
});

const monoStyle = css({
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const metaRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem 1.25rem",
  flexWrap: "wrap",
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const chipStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  whiteSpace: "nowrap",
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const chipDotStyle = css({
  width: "7px",
  height: "7px",
  borderRadius: "999px",
  background: "currentColor",
});

const chipDim = css({ color: "var(--status-queued)", background: "var(--status-queued-soft)" });

/** Two columns of flat collapsible sections: the content-heavy ENVELOPE
 * narrative on the left, the compact policy / io / accounting sections stacked
 * on the right. Because sections are flat `<details>` (uniform collapsed
 * heading rows, no per-card borders), the two columns read cleanly regardless
 * of which sections are expanded. Collapses to one column below ~72rem. */
const columnsStyle = css({
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "0 2rem",
  alignItems: "start",
  "@media (max-width: 72rem)": {
    gridTemplateColumns: "1fr",
  },
});

/** One column: sections stack, each carrying its own bottom-border divider. */
const colStyle = css({
  display: "flex",
  flexDirection: "column",
});

const slotStyle = css({
  display: "block",
});
