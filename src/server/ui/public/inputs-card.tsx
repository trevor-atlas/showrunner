import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { PhaseInputFile } from "../../lib/phase-data.ts";
import { Card, mono, Pre } from "./phase-card-shell.tsx";

/**
 * INPUTS card (issue #37) — the predecessor handoff materialized into this
 * phase's `inputs/` dir: each file's relative path with its contents collapsed,
 * and the per-file truncated affordance when the proxy clipped a large file at
 * its cap. Pure presentation over #35's inputs.json proxy. The first phase in
 * blueprint order has no predecessor, so `isFirst` renders the "none" state.
 */
export interface InputsCardProps {
  /** materialized input files ({rel, contents, truncated}) from inputs.json */
  files: PhaseInputFile[];
  /** true for the first blueprint phase — no predecessor, so "none" */
  isFirst: boolean;
}

export function InputsCard(handle: Handle<InputsCardProps>) {
  return () => {
    const { files, isFirst } = handle.props;
    const summary = isFirst
      ? "none (first phase)"
      : files.length === 0
        ? "no input files"
        : `${files.length} file${files.length === 1 ? "" : "s"}`;
    return (
      <Card title="INPUTS" summary={summary}>
        {isFirst ? (
          <p data-inputs-none mix={noneStyle}>first phase — no predecessor handoff</p>
        ) : files.length === 0 ? (
          <p data-inputs-empty mix={noneStyle}>no input files materialized for this phase</p>
        ) : (
          <ul mix={fileListStyle}>
            {files.map((f) => (
              <li key={f.rel} data-input-file mix={fileRowStyle}>
                <span mix={fileHeadStyle}>
                  <span data-input-rel mix={mono}>{f.rel}</span>
                  {f.truncated ? (
                    <span data-input-truncated mix={truncatedStyle}>⚠ truncated (preview clipped at the per-file cap)</span>
                  ) : null}
                </span>
                <details mix={detailsStyle}>
                  <summary mix={summaryStyle}>contents</summary>
                  <Pre>{f.contents === "" ? "(empty file)" : f.contents}</Pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  };
}

const fileListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.4rem",
});

const fileRowStyle = css({
  display: "grid",
  gap: "0.2rem",
  padding: "0.4rem 0.6rem",
  borderLeft: "3px solid var(--border)",
  background: "var(--muted)",
});

const fileHeadStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.6rem",
  flexWrap: "wrap",
});

const truncatedStyle = css({
  fontSize: "var(--font-size-xs)",
  color: "var(--status-interrupted)",
  fontWeight: 600,
  fontFamily: "var(--font-mono)",
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

const noneStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});
