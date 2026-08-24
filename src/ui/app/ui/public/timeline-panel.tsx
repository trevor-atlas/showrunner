import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../../../daemon/db.ts";
import type { TimelinePhase, TimelineSegment, TimelineView } from "../../../../daemon/client.ts";
import { routes } from "../../routes.ts";
import { fmtDuration, fmtMoney, fmtTime } from "./format.ts";
import { lifetime, outcomeLabel } from "./timeline-model.ts";
import { parseEnvelope, parseViolations, type ParsedEnvelope } from "./envelope-parse.ts";

/**
 * The R5 detail panel — the selected phase's full record, rendered below the
 * chart. Top to bottom: header (name, agent, status chip, visit count, budget
 * usage for the current visit, reported + estimated spend, lifetime), visit
 * history (newest first, with the per-cause narrative — on_fail banners link
 * to the causing phase), envelopes (all attempts: valid/rejected, violations,
 * the correction that followed, and the accepted envelope's summary /
 * artifacts / handoff), gates (pass/fail + override badges), and sessions
 * (collapsible, grouped by visit).
 *
 * The envelopes/gates data is LAZY (R5): the initial selection's data is
 * server-rendered by renderRunDetail; later selections fetch client-side
 * through the envelopes.json / gates.json remix proxies — the panel just
 * renders whatever the owner hands it (`null` = loading/error). The phase
 * links (visit-banner cause + the header's drill-in link) are real anchors so
 * selection is server-navigable: `?phase=<name>` deep links re-render the
 * whole page with that phase selected.
 *
 * This component lives in the BROWSER module graph (it renders inside the
 * run-live-region clientEntry), so it cannot import the server-only
 * phase-drill-in cards — the section rendering below follows their visual
 * language (Card-style sections, mono rows, ✓/✗ glyphs, badge chips) instead
 * of importing them.
 */

export interface TimelinePanelProps {
  runId: string;
  /** the LIVE timeline (the R6-refetched snapshot with the tracked status
   * overlaid) — the panel's phase lookup + the paused-reason banner read it */
  timeline: TimelineView;
  /** the selected phase name, or null (R5) */
  selected: string | null;
  /** agent sessions for ALL phases — filtered to the selected phase's
   * phase_id here (RunDetail.sessions) */
  sessions: AgentSessionRow[];
  /** the selected phase's envelopes; null while loading / after an error */
  envelopes: EnvelopeRow[] | null;
  /** the selected phase's gates; null while loading / after an error */
  gates: GateResultWithOverride[] | null;
  envelopesError: boolean;
  gatesError: boolean;
  /** the pause viewer's reason while the run is paused (null otherwise) —
   * surfaced in the panel header; live transitions ride the run_status →
   * paused event (run-live-region captures it), SSR rides getPause */
  pauseReason: string | null;
}

export function TimelinePanel(handle: Handle<TimelinePanelProps>) {
  return () => {
    const { runId, timeline, selected, sessions, envelopes, gates, envelopesError, gatesError, pauseReason } = handle.props;
    const phase = selected !== null ? (timeline.phases.find((p) => p.name === selected) ?? null) : null;

    return (
      <section data-testid="timeline-panel" data-selected={selected ?? ""} mix={panelStyle}>
        {/* R6: the pause reason surfaces in the panel header while the run is
        paused — the same value the pause viewer reports (getPause at SSR;
        the run_status → paused event's reason on a live transition) */}
        {timeline.status === "paused" && pauseReason !== null && pauseReason !== "" ? (
          <p data-panel-pause-reason mix={pausedBannerStyle}>
            ⏸ paused — {pauseReason}
          </p>
        ) : null}
        {phase === null ? (
          <p data-panel-empty mix={emptyStyle}>
            select a phase to see its record
          </p>
        ) : (
          <>
            <PanelHeader phase={phase} runId={runId} />
            <VisitHistory phase={phase} />
            <EnvelopeSection envelopes={envelopes} envelopesError={envelopesError} />
            <GatesSection gates={gates} gatesError={gatesError} />
            <SessionsSection sessions={sessions} phase={phase} />
          </>
        )}
      </section>
    );
  };
}

// ── 1. header ───────────────────────────────────────────────────────────────

function PanelHeader(handle: Handle<{ phase: TimelinePhase; runId: string }>) {
  return () => {
    const { phase, runId } = handle.props;
    const last = phase.segments.length > 0 ? phase.segments[phase.segments.length - 1]! : null;
    const life = lifetime(phase);
    const lifetimeLabel =
      life.startMs !== null
        ? `${fmtTime(new Date(life.startMs).toISOString())} → ${life.endMs !== null ? fmtTime(new Date(life.endMs).toISOString()) : "now"}`
        : "—";
    return (
      <section data-panel-header mix={cardSectionStyle}>
        <div mix={headerRowStyle}>
          <a
            href={routes.runs.phases.show.href({ runId, phase: phase.name })}
            data-phase-detail-link
            mix={phaseTitleStyle}
          >
            {phase.name}
          </a>
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
          <span data-panel-spend>
            spend {fmtMoney(phase.spend_usd)}
            {phase.estimated_spend_usd > 0 ? <span data-panel-spend-est mix={estStyle}> · est. {fmtMoney(phase.estimated_spend_usd)}</span> : null}
          </span>
          <span data-panel-lifetime mix={monoStyle}>lifetime {lifetimeLabel}</span>
        </div>
      </section>
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
  in_progress: css({ color: "#3573f6", background: "rgba(53, 115, 246, 0.1)" }),
  success: css({ color: "#15803d", background: "rgba(21, 128, 61, 0.12)" }),
  failed: css({ color: "#b91c1c", background: "rgba(185, 28, 28, 0.12)" }),
  skipped: css({ color: "#6b7280", background: "rgba(107, 114, 128, 0.12)" }),
  pending: css({ color: "#9ca3af", background: "rgba(156, 163, 175, 0.1)" }),
};

// ── 2. visit history ────────────────────────────────────────────────────────

function VisitHistory(handle: Handle<{ phase: TimelinePhase }>) {
  return () => {
    const { phase } = handle.props;
    const visits = [...phase.segments].reverse(); // newest first (R5)
    return (
      <section data-panel-visits-section mix={cardSectionStyle}>
        <h3 mix={sectionTitleStyle}>VISIT HISTORY</h3>
        {visits.length === 0 ? (
          <p data-visits-empty mix={emptyStyle}>no visits recorded for this phase</p>
        ) : (
          <ul mix={visitListStyle}>
            {visits.map((segment) => (
              <VisitBlock key={segment.visit} phase={phase} segment={segment} />
            ))}
          </ul>
        )}
      </section>
    );
  };
}

function VisitBlock(handle: Handle<{ phase: TimelinePhase; segment: TimelineSegment }>) {
  return () => {
    const { phase, segment } = handle.props;
    const endMs = segment.ended_at !== null ? Date.parse(segment.ended_at) : Date.now();
    const durationMs = Math.max(0, endMs - Date.parse(segment.started_at));
    const cause = segment.cause;
    return (
      <li data-visit-block data-visit={segment.visit} data-visit-outcome={segment.outcome} mix={visitBlockStyle}>
        <div mix={visitRowStyle}>
          <span data-visit-interval mix={monoStyle}>
            {fmtTime(segment.started_at)} → {segment.ended_at !== null ? fmtTime(segment.ended_at) : "now"}
          </span>
          <span data-visit-duration mix={monoStyle}>{fmtDuration(durationMs)}</span>
          <span data-visit-outcome mix={OUTCOME_TEXT_TONES[segment.outcome]}>{outcomeLabel(segment.outcome)}</span>
          {segment.corrections > 0 ? (
            <span data-visit-corrections mix={correctionsBadgeStyle}>
              ↻{segment.corrections} correction{segment.corrections === 1 ? "" : "s"}
            </span>
          ) : null}
          <span data-visit-attempts mix={monoStyle}>{segment.envelope_attempts} envelope attempt{segment.envelope_attempts === 1 ? "" : "s"}</span>
        </div>
        {cause === null ? (
          <p data-cause="prer2" mix={causeStyle}>Reason not recorded (run predates revisit causes).</p>
        ) : cause.kind === "on_fail" ? (
          <p data-cause="on_fail" mix={causeBannerStyle}>
            Visit {segment.visit} started because{" "}
            <a href={selectHref(cause.from_phase)} data-cause-phase={cause.from_phase} mix={causeLinkStyle}>
              {cause.from_phase}
            </a>{" "}
            (visit {cause.from_visit}) failed its gates and exhausted its budget.
          </p>
        ) : cause.kind === "human" ? (
          <p data-cause="human" mix={causeStyle}>
            Started by a human action — {cause.action}
            {cause.by !== undefined && cause.by !== null ? ` by ${cause.by}` : ""}.
          </p>
        ) : segment.visit > 1 ? (
          <p data-cause="flow-rerun" mix={causeStyle}>Re-ran in normal order after an upstream jump.</p>
        ) : (
          // flow on visit 1 is the normal case — nothing renders (R5)
          null
        )}
      </li>
    );
  };
}

/** A ?phase= deep link — server-navigable selection (R5). */
function selectHref(phase: string): string {
  return `?phase=${encodeURIComponent(phase)}`;
}

// ── 3. envelopes ────────────────────────────────────────────────────────────

function EnvelopeSection(handle: Handle<{ envelopes: EnvelopeRow[] | null; envelopesError: boolean }>) {
  return () => {
    const { envelopes, envelopesError } = handle.props;
    return (
      <section data-panel-envelopes mix={cardSectionStyle}>
        <h3 mix={sectionTitleStyle}>ENVELOPES</h3>
        {envelopesError ? (
          <p data-envelopes-error mix={errorStyle}>couldn't load envelopes</p>
        ) : envelopes === null ? (
          <p data-envelopes-loading mix={emptyStyle}>loading envelopes…</p>
        ) : envelopes.length === 0 ? (
          <p data-envelopes-empty mix={emptyStyle}>no envelope attempts recorded for this phase</p>
        ) : (
          <ul mix={attemptListStyle}>
            {envelopes.map((e) => (
              <li key={e.id} data-envelope-attempt data-attempt-valid={e.valid} mix={attemptRowStyle}>
                <div mix={visitRowStyle}>
                  <span mix={monoStyle}>
                    {e.valid === 1 ? okGlyph : badGlyph} {attemptState(e)}
                  </span>
                  <span data-envelope-time mix={monoStyle}>
                    {fmtTime(e.validated_at)}
                    {multiVisitLabel(envelopes, e)}
                  </span>
                </div>
                {e.valid === 0 && parseViolations(e.violations).length > 0 ? (
                  <span data-envelope-violations mix={violationsStyle}>
                    violations: {parseViolations(e.violations).join("; ") || "—"}
                  </span>
                ) : null}
                <span data-envelope-correction mix={correctionStyle}>
                  {e.correction !== null ? (
                    <>
                      <span mix={correctedLabel}>→ corrected</span> {e.correction}
                    </>
                  ) : (
                    <span mix={noCorrectionStyle}>→ no correction followed</span>
                  )}
                </span>
                {e.valid === 1 ? <AcceptedSurface envelope={parseEnvelope(e.json)} /> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };
}

/** One-line state label for an attempt, per the "✗ invalid … ✓ valid" pair. */
function attemptState(e: EnvelopeRow): string {
  if (e.valid !== 1) return "rejected";
  return parseViolations(e.violations).length > 0 ? "valid, gate violations" : "valid";
}

function multiVisitLabel(envelopes: readonly EnvelopeRow[], e: EnvelopeRow): string {
  const multi = envelopes.some((x) => x.visit !== 1);
  return multi ? ` · v${e.visit} #${e.attempt + 1}` : "";
}

/** The valid envelope's readable surface: summary, artifacts, handoff. */
function AcceptedSurface(handle: Handle<{ envelope: ParsedEnvelope | null }>) {
  return () => {
    const { envelope } = handle.props;
    if (envelope === null) return <p mix={emptyStyle} data-envelope-surface>accepted envelope could not be parsed</p>;
    return (
      <div data-envelope-surface mix={surfaceStyle}>
        <div mix={rowStyle}>
          <span mix={labelStyle} title="what the agent says it did">summary</span>
          <span>{envelope.summary || "—"}</span>
        </div>
        {envelope.artifacts.length > 0 ? (
          <div mix={rowStyle}>
            <span mix={labelStyle} title="files this agent wrote to its outputs/ directory">artifacts</span>
            <ul mix={artifactListStyle}>
              {envelope.artifacts.map((a) => (
                <li key={a} mix={monoStyle}>{a}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div mix={rowStyle}>
          <span mix={labelStyle} title="the handoff the next phase receives">handoff</span>
          <span>{envelope.notes || "—"}</span>
        </div>
      </div>
    );
  };
}

// ── 4. gates ────────────────────────────────────────────────────────────────

function GatesSection(handle: Handle<{ gates: GateResultWithOverride[] | null; gatesError: boolean }>) {
  return () => {
    const { gates, gatesError } = handle.props;
    return (
      <section data-panel-gates mix={cardSectionStyle}>
        <h3 mix={sectionTitleStyle}>GATES</h3>
        {gatesError ? (
          <p data-gates-error mix={errorStyle}>couldn't load gates</p>
        ) : gates === null ? (
          <p data-gates-loading mix={emptyStyle}>loading gates…</p>
        ) : gates.length === 0 ? (
          <p data-gates-empty mix={emptyStyle}>no gate results recorded for this phase</p>
        ) : (
          <ul mix={gateListStyle}>
            {gates.map((g) => (
              <li key={g.id} data-gate-row data-gate={g.gate} data-gate-pass={g.pass} mix={gateRowStyle}>
                <span mix={monoStyle}>
                  {g.pass === 1 ? okGlyph : badGlyph} {g.gate} · {fmtTime(g.ran_at)}
                </span>
                {g.pass === 0 && parseViolations(g.violations).length > 0 ? (
                  <span data-gate-violations mix={violationsStyle}>
                    {parseViolations(g.violations).join("; ") || "no violations recorded"}
                  </span>
                ) : null}
                {g.overridden === 1 ? (
                  <span data-gate-overridden mix={overrideStyle}>
                    <span mix={overrideBadgeStyle}>overridden</span>
                    <span>
                      by {g.override_by ?? "unknown"} — {g.override_reason ?? "(no reason)"}
                      {g.overridden_at !== null ? ` · ${fmtTime(g.overridden_at)}` : ""}
                    </span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  };
}

// ── 5. sessions (collapsible, low priority) ────────────────────────────────

function SessionsSection(handle: Handle<{ sessions: AgentSessionRow[]; phase: TimelinePhase }>) {
  return () => {
    const { sessions, phase } = handle.props;
    const phaseSessions = sessions
      .filter((s) => s.phase_id === phase.phase_id)
      .sort((a, b) => (a.visit !== b.visit ? a.visit - b.visit : a.started_at < b.started_at ? -1 : 1));
    return (
      <details data-panel-sessions mix={detailsStyle}>
        <summary mix={summaryStyle}>SESSIONS ({phaseSessions.length})</summary>
        {phaseSessions.length === 0 ? (
          <p data-sessions-empty mix={emptyStyle}>no agent sessions recorded for this phase</p>
        ) : (
          <ul mix={sessionListStyle}>
            {phaseSessions.map((s) => (
              <li key={s.id} data-session-row data-session-visit={s.visit} mix={sessionRowStyle}>
                <span data-session-id mix={monoStyle}>visit {s.visit} · {s.pi_session_id}</span>
                <span data-session-duration mix={monoStyle}>
                  {fmtTime(s.started_at)} → {s.ended_at !== null ? fmtTime(s.ended_at) : "now"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    );
  };
}

// ── shared styles (the drill-in card visual language) ───────────────────────

const panelStyle = css({
  display: "grid",
  gap: "0.75rem",
});

/** R6: the paused-reason banner in the panel header — amber, matching the
 * pause menu's visual language. */
const pausedBannerStyle = css({
  margin: 0,
  padding: "0.4rem 0.7rem",
  border: "1px solid #f3c14a",
  borderRadius: "8px",
  background: "rgba(243, 193, 74, 0.1)",
  color: "#78350f",
  fontSize: "12px",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const emptyStyle = css({
  margin: 0,
  color: "#6b7280",
  fontSize: "12px",
});

const errorStyle = css({
  margin: 0,
  color: "#b91c1c",
  fontSize: "12px",
  fontWeight: 600,
});

const cardSectionStyle = css({
  display: "grid",
  gap: "0.5rem",
  padding: "0.9rem 1.1rem 1.1rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  background: "#fdfdfd",
});

const sectionTitleStyle = css({
  margin: 0,
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.09em",
  color: "#6b7280",
});

const monoStyle = css({
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
  color: "#374151",
});

const headerRowStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  flexWrap: "wrap",
});

const phaseTitleStyle = css({
  fontSize: "16px",
  fontWeight: 800,
  color: "#111827",
  textDecoration: "none",
  letterSpacing: "-0.02em",
  "&:hover": {
    color: "#3573f6",
    textDecoration: "underline",
  },
});

const metaRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem 1.25rem",
  flexWrap: "wrap",
  fontSize: "12px",
  color: "#374151",
});

const estStyle = css({
  color: "#92400e",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "11px",
});

const chipStyle = css({
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  whiteSpace: "nowrap",
  fontSize: "11px",
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

const chipDim = css({ color: "#9ca3af", background: "rgba(156, 163, 175, 0.1)" });

const visitListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
});

const visitBlockStyle = css({
  display: "grid",
  gap: "0.25rem",
  padding: "0.45rem 0.6rem",
  borderLeft: "3px solid #e5e7eb",
  background: "#f9fafb",
});

const visitRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
  fontSize: "12px",
});

const OUTCOME_TEXT_TONES: Record<string, ReturnType<typeof css>> = {
  in_progress: css({ color: "#3573f6", fontWeight: 600 }),
  success: css({ color: "#15803d", fontWeight: 600 }),
  failed: css({ color: "#b91c1c", fontWeight: 600 }),
  interrupted: css({ color: "#b45309", fontWeight: 600 }),
  skipped: css({ color: "#6b7280", fontWeight: 600 }),
};

const correctionsBadgeStyle = css({
  fontSize: "11px",
  fontWeight: 700,
  color: "#b45309",
  background: "#fff7ed",
  border: "1px solid #fcd34d",
  borderRadius: "999px",
  padding: "0 6px",
  lineHeight: "16px",
  whiteSpace: "nowrap",
});

const causeStyle = css({
  margin: 0,
  fontSize: "12px",
  color: "#111827",
});

const causeBannerStyle = css({
  margin: 0,
  fontSize: "12px",
  color: "#92400e",
  background: "rgba(243, 193, 74, 0.12)",
  border: "1px solid #f3c14a",
  borderRadius: "6px",
  padding: "0.3rem 0.5rem",
});

const causeLinkStyle = css({
  color: "#92400e",
  fontWeight: 700,
  textDecoration: "underline",
  "&:hover": {
    color: "#b45309",
  },
});

const attemptListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
});

const attemptRowStyle = css({
  display: "grid",
  gap: "0.15rem",
  padding: "0.4rem 0.6rem",
  borderLeft: "3px solid #e5e7eb",
  background: "#f9fafb",
});

const violationsStyle = css({
  color: "#b91c1c",
  fontSize: "12px",
});

const correctionStyle = css({
  fontSize: "12px",
  color: "#111827",
});

const correctedLabel = css({
  color: "#92400e",
  fontWeight: 700,
});

const noCorrectionStyle = css({
  color: "#9ca3af",
});

const surfaceStyle = css({
  display: "grid",
  gap: "0.3rem",
  padding: "0.4rem 0.5rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#ffffff",
  fontSize: "12px",
});

const rowStyle = css({
  display: "grid",
  gridTemplateColumns: "5.5rem 1fr",
  gap: "0.25rem 0.75rem",
  alignItems: "baseline",
});

const labelStyle = css({
  fontSize: "10px",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "#6b7280",
  textTransform: "uppercase",
});

const artifactListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.1rem",
});

const gateListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
});

const gateRowStyle = css({
  display: "grid",
  gap: "0.15rem",
  padding: "0.4rem 0.6rem",
  borderLeft: "3px solid #e5e7eb",
  background: "#f9fafb",
});

const overrideStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "12px",
  color: "#92400e",
});

const overrideBadgeStyle = css({
  display: "inline-flex",
  alignItems: "center",
  whiteSpace: "nowrap",
  fontSize: "11px",
  fontWeight: 700,
  padding: "1px 7px",
  borderRadius: "999px",
  border: "1px solid currentColor",
});

const detailsStyle = css({
  padding: "0.6rem 0.75rem",
  border: "1px solid #e5e7eb",
  borderRadius: "10px",
  background: "#fdfdfd",
  fontSize: "13px",
});

const summaryStyle = css({
  cursor: "pointer",
  color: "#6b7280",
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.09em",
  userSelect: "none",
});

const sessionListStyle = css({
  listStyle: "none",
  margin: "0.4rem 0 0",
  padding: 0,
  display: "grid",
  gap: "0.3rem",
});

const sessionRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
  padding: "0.35rem 0.5rem",
  borderLeft: "3px solid #e5e7eb",
  background: "#f9fafb",
});

const okGlyph = "✓";
const badGlyph = "✗";
