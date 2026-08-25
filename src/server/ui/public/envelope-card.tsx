import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { EnvelopeRow } from "../../repository/db.ts";
import { fmtStartedAt } from "./format.ts";
import { parseEnvelope, parseViolations, type ParsedEnvelope } from "./envelope-parse.ts";
import { badGlyph, Card, mono, okGlyph, Pre } from "./phase-card-shell.tsx";

/**
 * ENVELOPE card (issue #37) — the phase's full attempt history plus the
 * accepted envelope, readable. Every attempt shows valid/invalid, the
 * violations that rejected it, and the correction that followed; the accepted
 * envelope shows what the agent said it did (summary), the handoff, and the
 * blocked reason when present, with the raw JSON collapsed. Pure presentation
 * over #35's envelopes proxy shape.
 *
 * Artifact rows deliberately live in the OUTPUTS card (single owner): this
 * card reports what the envelope SAID; OUTPUTS reconciles the claimed artifacts
 * against the phase's `outputs/` dir.
 */
export interface EnvelopeCardProps {
  envelopes: EnvelopeRow[];
}

/** The accepted envelope: the last attempt that parsed AND passed its gates. */
export function acceptedEnvelope(envelopes: readonly EnvelopeRow[]): EnvelopeRow | null {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const e = envelopes[i]!;
    if (e.valid === 1 && parseViolations(e.violations).length === 0) return e;
  }
  return null;
}

/** One-line state label for an attempt row, per the "✗ invalid … ✓ valid" pair. */
export function attemptState(e: EnvelopeRow): string {
  if (e.valid !== 1) return "invalid";
  const violations = parseViolations(e.violations);
  if (violations.length > 0) return `valid, gate violations (${violations.length})`;
  return "valid, gates passed";
}

/** The accepted attempt's "attempt N of M" (multi-visit adds the visit). */
export function attemptLabel(e: EnvelopeRow, total: number, multiVisit: boolean): string {
  if (multiVisit) return `v${e.visit} #${e.attempt + 1} of ${total}`;
  return `${e.attempt + 1} of ${total}`;
}

export function EnvelopeCard(handle: Handle<EnvelopeCardProps>) {
  return () => {
    const { envelopes } = handle.props;
    const accepted = acceptedEnvelope(envelopes);
    const multiVisit = envelopes.some((e) => e.visit !== 1);

    const summary = accepted
      ? `accepted ${fmtStartedAt(accepted.validated_at)} (attempt ${attemptLabel(accepted, envelopes.length, multiVisit)})`
      : "no accepted envelope";

    return (
      <Card title="ENVELOPE" summary={summary} defaultOpen={envelopes.length > 0}>
        {envelopes.length === 0 ? (
          <p data-envelope-empty mix={emptyStyle}>no envelope attempts recorded for this phase</p>
        ) : (
          <>
            <ul mix={attemptListStyle}>
              {envelopes.map((e, i) => (
                <li key={e.id} data-envelope-attempt data-attempt-valid={e.valid} mix={attemptRowStyle}>
                  <span mix={mono}>
                    {i + 1}. {e.valid === 1 ? okGlyph : badGlyph} {attemptState(e)}
                  </span>
                  {e.valid === 1 && parseViolations(e.violations).length > 0 ? (
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
                  <span mix={metaStyle}>
                    {fmtStartedAt(e.validated_at)}
                    {multiVisit ? ` · v${e.visit}` : ""}
                  </span>
                </li>
              ))}
            </ul>

            {accepted !== null ? (
              <>
                <section mix={sectionStyle}>
                  <h3 mix={sectionTitleStyle}>ACCEPTED ENVELOPE</h3>
                  <AcceptedSurface envelope={parseEnvelope(accepted.json)} />
                </section>
                <div mix={rowStyle}>
                  <span mix={labelStyle}>source</span>
                  <span data-envelope-source mix={mono}>{accepted.source}</span>
                </div>
                <details mix={detailsStyle}>
                  <summary mix={summaryStyle}>view JSON</summary>
                  <Pre>{prettyJson(accepted.json)}</Pre>
                </details>
              </>
            ) : null}
          </>
        )}
      </Card>
    );
  };
}

function prettyJson(text: string): string {
  if (text === "") return "(no envelope.json content — attempt wrote nothing)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The readable accepted-envelope surface: summary, handoff, blocked. Artifacts
 * are the OUTPUTS card's job (single owner), so they are absent here. */
function AcceptedSurface(handle: Handle<{ envelope: ParsedEnvelope | null }>) {
  return () => {
    const { envelope } = handle.props;
    if (envelope === null) return <p data-envelope-surface mix={emptyStyle}>accepted envelope could not be parsed</p>;
    return (
      <div data-envelope-surface mix={surfaceStyle}>
        <div mix={rowStyle}>
          <span mix={labelStyle} title="what the agent says it did">summary</span>
          <span data-envelope-summary>{envelope.summary || "—"}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle} title="the handoff the next phase receives">handoff</span>
          <span data-envelope-handoff>{envelope.notes || "—"}</span>
        </div>
        {envelope.blocked ? (
          <div mix={rowStyle}>
            <span mix={labelStyle}>blocked</span>
            <span data-envelope-blocked mix={blockedStyle}>{envelope.blockedReason || "agent reported blocked"}</span>
          </div>
        ) : null}
      </div>
    );
  };
}

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
  borderLeft: "3px solid var(--border)",
  background: "var(--muted)",
});

const violationsStyle = css({
  color: "var(--status-failed)",
  fontSize: "var(--font-size-sm)",
});

const correctionStyle = css({
  fontSize: "var(--font-size-sm)",
  color: "var(--foreground)",
});

const correctedLabel = css({
  color: "var(--status-paused)",
  fontWeight: 700,
});

const noCorrectionStyle = css({
  color: "var(--muted-foreground)",
});

const metaStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--muted-foreground)",
  fontFamily: "var(--font-mono)",
});

const rowStyle = css({
  display: "grid",
  gridTemplateColumns: "5.5rem 1fr",
  gap: "0.25rem 0.75rem",
  alignItems: "baseline",
});

const labelStyle = css({
  fontSize: "var(--font-size-xs)",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "var(--muted-foreground)",
  textTransform: "uppercase",
});

const detailsStyle = css({
  fontSize: "var(--font-size-md)",
});

const summaryStyle = css({
  cursor: "pointer",
  color: "var(--status-running)",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  fontFamily: "var(--font-mono)",
});

const emptyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});

const sectionStyle = css({
  display: "grid",
  gap: "0.4rem",
  padding: "0.5rem 0.6rem",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
});

const sectionTitleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-xs)",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "var(--muted-foreground)",
  textTransform: "uppercase",
});

const surfaceStyle = css({
  display: "grid",
  gap: "0.4rem",
});

const blockedStyle = css({
  color: "var(--status-failed)",
  fontWeight: 600,
  fontSize: "var(--font-size-sm)",
});
