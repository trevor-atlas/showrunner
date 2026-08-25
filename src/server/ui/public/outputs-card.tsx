import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { EnvelopeRow } from "../../../daemon/db.ts";
import { acceptedEnvelope } from "./envelope-card.tsx";
import { parseEnvelope } from "./envelope-parse.ts";
import { Card, mono, Pre } from "./phase-card-shell.tsx";

/**
 * OUTPUTS card (issue #37) — the phase's `outputs/` dir listing, its
 * FINDINGS.md (collapsed), and the accepted envelope's claimed artifacts
 * reconciled against what the agent actually wrote (✓ present / ⚠ listed but
 * missing). Pure presentation over #35's outputs.json proxy plus the envelopes
 * proxy — this card is the single owner of artifact-existence, moved here off
 * the ENVELOPE card.
 */
export interface OutputsCardProps {
  /** the phase's outputs/ dir listing (outputs.json) */
  files: string[];
  /** the phase's FINDINGS.md, or null when none was written (outputs.json) */
  findingsMd: string | null;
  /** the phase's envelopes — the accepted one names the claimed artifacts */
  envelopes: EnvelopeRow[];
}

/** The accepted envelope's claimed artifacts ([] when none is accepted). */
export function acceptedArtifacts(envelopes: readonly EnvelopeRow[]): string[] {
  const accepted = acceptedEnvelope(envelopes);
  if (accepted === null) return [];
  return parseEnvelope(accepted.json)?.artifacts ?? [];
}

/** Was a claimed artifact actually written to the phase's outputs/ dir? */
export function artifactPresent(name: string, files: readonly string[]): boolean {
  return files.includes(name);
}

export function OutputsCard(handle: Handle<OutputsCardProps>) {
  return () => {
    const { files, findingsMd, envelopes } = handle.props;
    const artifacts = acceptedArtifacts(envelopes);
    return (
      <Card title="OUTPUTS" summary={files.length === 0 ? "no output files" : `${files.length} file${files.length === 1 ? "" : "s"}`} defaultOpen={files.length > 0 || artifacts.length > 0}>
        <div mix={rowStyle}>
          <span mix={labelStyle}>files</span>
          {files.length === 0 ? (
            <span data-outputs-empty mix={emptyStyle}>— none written</span>
          ) : (
            <ul data-outputs-files mix={listStyle}>
              {files.map((f) => (
                <li key={f} mix={mono}>{f}</li>
              ))}
            </ul>
          )}
        </div>
        <div mix={rowStyle}>
          <span
            mix={labelStyle}
            title="files the accepted envelope claimed, checked against this phase's outputs/ dir"
          >
            artifacts
          </span>
          {artifacts.length === 0 ? (
            <span data-artifacts-empty mix={emptyStyle}>— none claimed</span>
          ) : (
            <ul data-outputs-artifacts mix={listStyle}>
              {artifacts.map((a) =>
                artifactPresent(a, files) ? (
                  <li key={a} data-artifact={a} data-artifact-present="1" mix={mono} title="present in this phase's outputs/">
                    ✓ {a}
                  </li>
                ) : (
                  <li
                    key={a}
                    data-artifact={a}
                    data-artifact-present="0"
                    mix={[mono, missingStyle]}
                    title="listed but not found in this phase's outputs/ — the agent claimed a file it did not write"
                  >
                    ⚠ {a}
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
        {findingsMd !== null ? (
          <details mix={detailsStyle}>
            <summary mix={summaryStyle}>FINDINGS.md</summary>
            <Pre>{findingsMd}</Pre>
          </details>
        ) : null}
      </Card>
    );
  };
}

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

const listStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.15rem",
});

const missingStyle = css({
  color: "var(--status-interrupted)",
  cursor: "help",
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
