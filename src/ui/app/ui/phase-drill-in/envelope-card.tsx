import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { EnvelopeRow } from "../../../../daemon/db.ts";
import { fmtStartedAt } from "../format.ts";
import { badGlyph, Card, mono, okGlyph, Pre } from "./card.tsx";
import { parseEnvelope, parseViolations, type ParsedEnvelope } from "../public/envelope-parse.ts";

/**
 * ENVELOPE card (§16.8) — the accepted envelope + the FULL attempt history:
 * every attempt (valid/invalid, the violations that rejected it, and the
 * correction message that followed — filled by the loop once the correction is
 * actually sent), attempt number, and timestamps. The accepted envelope is
 * shown READABLY — what the agent said it did (summary), the handoff
 * (notes_for_next_agent), the files it produced (artifacts — checked against
 * its outputs/ dir), and the FINDINGS.md content when the phase wrote one —
 * with the raw JSON viewable inline; the envelope.json source path is shown
 * (§10).
 *
 * The data comes from the daemon's §13.1 envelope-history endpoint: ALL
 * attempts for the phase, ordered visit → attempt (T03's model). `outputs` is
 * the phase's outputs/ dir listing read server-side by the drill-in controller.
 */

export interface EnvelopeCardProps {
  envelopes: EnvelopeRow[];
  /** the phase's outputs/ dir: files the agent actually wrote + FINDINGS.md */
  outputs: { files: string[]; findingsMd: string | null };
}

/** The accepted envelope: the last attempt that parsed AND passed its gates. */
export function acceptedEnvelope(envelopes: readonly EnvelopeRow[]): EnvelopeRow | null {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    const e = envelopes[i]!;
    if (e.valid === 1 && parseViolations(e.violations).length === 0) return e;
  }
  return null;
}

export function EnvelopeCard(handle: Handle<EnvelopeCardProps>) {
  return () => {
    const { envelopes, outputs } = handle.props;
    const accepted = acceptedEnvelope(envelopes);
    const multiVisit = envelopes.some((e) => e.visit !== 1);

    const summary = accepted
      ? `accepted ${fmtStartedAt(accepted.validated_at)} (attempt ${attemptLabel(accepted, envelopes.length, multiVisit)})`
      : "no accepted envelope";

    return (
      <Card title="ENVELOPE" summary={summary}>
        {envelopes.length === 0 ? (
          <p mix={emptyStyle}>no envelope attempts recorded for this phase</p>
        ) : (
          <>
            <ul mix={attemptListStyle}>
              {envelopes.map((e, i) => (
                <li key={e.id} mix={attemptRowStyle}>
                  <span mix={mono}>
                    {i + 1}. {e.valid === 1 ? okGlyph : badGlyph} {attemptState(e)}
                  </span>
                  {e.valid === 1 && parseViolations(e.violations).length > 0 ? (
                    <span mix={violationsStyle}>
                      violations: {parseViolations(e.violations).join("; ") || "—"}
                    </span>
                  ) : null}
                  <span mix={correctionStyle}>
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
                  <AcceptedSurface envelope={parseEnvelope(accepted.json)} outputs={outputs} />
                </section>
                <div mix={rowStyle}>
                  <span mix={labelStyle}>source</span>
                  <span mix={mono}>{accepted.source}</span>
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

/** One-line state label for an attempt row, per §16.8's "✗ invalid … ✓ valid". */
function attemptState(e: EnvelopeRow): string {
  if (e.valid !== 1) return "invalid";
  const violations = parseViolations(e.violations);
  if (violations.length > 0) return `valid, gate violations (${violations.length})`;
  return "valid, gates passed";
}

function attemptLabel(e: EnvelopeRow, total: number, multiVisit: boolean): string {
  if (multiVisit) return `v${e.visit} #${e.attempt + 1} of ${total}`;
  return `${e.attempt + 1} of ${total}`;
}

function prettyJson(text: string): string {
  if (text === "") return "(no envelope.json content — attempt wrote nothing)";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** The readable accepted-envelope surface: summary, handoff, artifacts (+existence), FINDINGS.md. */
function AcceptedSurface(handle: Handle<{ envelope: ParsedEnvelope | null; outputs: EnvelopeCardProps["outputs"] }>) {
  return () => {
    const { envelope, outputs } = handle.props;
    if (envelope === null) return <p mix={emptyStyle}>accepted envelope could not be parsed</p>;
    const artifactNames = new Set(outputs.files);
    return (
      <div mix={surfaceStyle}>
        <div mix={rowStyle}>
          <span mix={labelStyle} title="what the agent says it did">summary</span>
          <span>{envelope.summary || "—"}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle} title="the handoff the next phase receives">handoff</span>
          <span>{envelope.notes || "—"}</span>
        </div>
        {envelope.blocked ? (
          <div mix={rowStyle}>
            <span mix={labelStyle}>blocked</span>
            <span mix={blockedStyle}>{envelope.blockedReason || "agent reported blocked"}</span>
          </div>
        ) : null}
        <div mix={rowStyle}>
          <span
            mix={labelStyle}
            title="files this agent wrote to its outputs/ directory — forwarded to the next phase's inputs/ automatically"
          >
            artifacts
          </span>
          {envelope.artifacts.length === 0 ? (
            <span mix={emptyStyle}>— none listed</span>
          ) : (
            <ul mix={artifactListStyle}>
              {envelope.artifacts.map((a) => (
                <li key={a} mix={mono}>
                  {artifactNames.has(a) ? (
                    <span title="present in this phase's outputs/">✓ {a}</span>
                  ) : (
                    <span mix={missingStyle} title="listed but not found in this phase's outputs/ — the agent claimed a file it did not write">
                      ⚠ {a}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {outputs.findingsMd !== null ? (
          <details mix={detailsStyle}>
            <summary mix={summaryStyle}>FINDINGS.md</summary>
            <Pre>{outputs.findingsMd}</Pre>
          </details>
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

const metaStyle = css({
  fontSize: "11px",
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const rowStyle = css({
  display: "grid",
  gridTemplateColumns: "5.5rem 1fr",
  gap: "0.25rem 0.75rem",
  alignItems: "baseline",
});

const labelStyle = css({
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "#6b7280",
  textTransform: "uppercase",
});

const detailsStyle = css({
  fontSize: "13px",
});

const summaryStyle = css({
  cursor: "pointer",
  color: "#3573f6",
  fontSize: "12px",
  fontWeight: 700,
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
});

const emptyStyle = css({
  margin: 0,
  color: "#6b7280",
  fontSize: "12px",
});

const sectionStyle = css({
  display: "grid",
  gap: "0.4rem",
  padding: "0.5rem 0.6rem",
  border: "1px solid #e5e7eb",
  borderRadius: "8px",
  background: "#ffffff",
});

const sectionTitleStyle = css({
  margin: 0,
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "#6b7280",
  textTransform: "uppercase",
});

const surfaceStyle = css({
  display: "grid",
  gap: "0.4rem",
});

const artifactListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.15rem",
});

const missingStyle = css({
  color: "#b45309",
  cursor: "help",
});

const blockedStyle = css({
  color: "#b91c1c",
  fontWeight: 600,
  fontSize: "12px",
});
