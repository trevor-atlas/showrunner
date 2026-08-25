import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { RawTail } from "../../contract.ts";
import { Pre } from "./phase-card-shell.tsx";

/**
 * RAW TRANSCRIPT section (issue #41) — the run-scoped raw_output.jsonl tail,
 * collapsed in a native <details> and rendered verbatim in a scrollable mono
 * block. The old drill-in OUTPUT card's raw tail moved here so a run's output
 * stays viewable after the phase drill-in page folded into the run page.
 *
 * Pure presentation over the server RawTail shape ({ raw, line_count,
 * truncated }): the summary reports the full line count and, when the tail
 * dropped earlier lines, the truncated flag. The owner (run-live-region)
 * SSR-seeds it and refetches raw.json on every SSE change wake-up — this
 * component just renders whatever it is handed.
 */
export interface RawTranscriptProps {
  raw: RawTail;
}

export function RawTranscript(handle: Handle<RawTranscriptProps>) {
  return () => {
    const { raw } = handle.props;
    const summary =
      raw.line_count === 0
        ? "RAW TRANSCRIPT · raw_output.jsonl (empty)"
        : `RAW TRANSCRIPT · ${raw.line_count} line${raw.line_count === 1 ? "" : "s"}` +
          (raw.truncated ? " · earlier lines omitted" : "");
    return (
      <details data-testid="raw-transcript" data-raw-truncated={raw.truncated ? "1" : "0"} mix={detailsStyle}>
        <summary mix={summaryStyle}>{summary}</summary>
        <div mix={scrollWrapStyle}>
          <Pre>{raw.raw === "" ? "(no raw output)" : raw.raw}</Pre>
        </div>
      </details>
    );
  };
}

const detailsStyle = css({
  padding: "0.6rem 0.75rem",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  background: "var(--card)",
  fontSize: "var(--font-size-md)",
});

const summaryStyle = css({
  cursor: "pointer",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-xs)",
  fontWeight: 800,
  letterSpacing: "0.09em",
  userSelect: "none",
});

const scrollWrapStyle = css({
  maxHeight: "24rem",
  overflowY: "auto",
  marginTop: "0.4rem",
});
