import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { SnapshotPhase } from "../../lib/blueprint-snapshot.ts";
import { Card, mono, Pre } from "./phase-card-shell.tsx";

/**
 * PHASE CONFIG card (issue #37) — the phase's execution policy from the run's
 * blueprint snapshot: budget, require_approval, on_fail target, the gates list
 * in declared order, and the envelope contract rendered as a collapsed mono
 * block. Pure presentation. `phase === null` is the "no blueprint snapshot"
 * state.
 *
 * NOTE (verified against runner.ts:415 `envelope: renderSchema(...)`):
 * `SnapshotPhase.envelope` is typed `unknown` but the daemon serializes a
 * PRE-RENDERED schema STRING (a multi-line `{ … }` type description), not a zod
 * object. "Render the contract" means render that string; `renderEnvelopeContract`
 * coerces defensively with `String()` and falls back for older/empty snapshots.
 */
export interface PhaseConfigCardProps {
  /** the phase's SnapshotPhase, or null when the run wrote no snapshot */
  phase: SnapshotPhase | null;
}

/**
 * The envelope contract as a display string. The snapshot stores a rendered
 * schema string (runner.ts renderSchema); coerce with `String()` so older
 * snapshots that stored something else never crash the card, and fall back to
 * a note when the field is absent/empty.
 */
export function renderEnvelopeContract(envelope: unknown): string {
  if (envelope === null || envelope === undefined) return "(no envelope contract recorded)";
  const text = String(envelope);
  return text === "" ? "(no envelope contract recorded)" : text;
}

export function PhaseConfigCard(handle: Handle<PhaseConfigCardProps>) {
  return () => {
    const { phase } = handle.props;
    if (phase === null) {
      return (
        <Card title="PHASE CONFIG">
          <p data-config-empty mix={noneStyle}>
            no blueprint snapshot for this phase (fixture/observation run)
          </p>
        </Card>
      );
    }
    return (
      <Card title="PHASE CONFIG" summary={`budget ${phase.budget}`}>
        <div mix={rowStyle}>
          <span mix={labelStyle}>budget</span>
          <span data-config-budget mix={mono}>{phase.budget}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>approval</span>
          <span data-config-approval mix={mono}>{phase.require_approval ? "required" : "not required"}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>on fail</span>
          <span data-config-onfail mix={mono}>{phase.on_fail ?? "—"}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>gates</span>
          <span data-config-gates mix={mono}>{phase.gates.length === 0 ? "—" : phase.gates.join(", ")}</span>
        </div>
        <details mix={detailsStyle}>
          <summary mix={summaryStyle}>envelope contract</summary>
          <Pre>{renderEnvelopeContract(phase.envelope)}</Pre>
        </details>
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
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-sm)",
});
