import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { GateResultWithOverride } from "../../../../daemon/db.ts";
import { fmtStartedAt } from "./format.ts";
import { parseViolations } from "./envelope-parse.ts";
import { Badge, badGlyph, Card, mono, okGlyph } from "./phase-card-shell.tsx";

/**
 * GATES card (issue #37) — per gate: pass/fail, the violations list, and the
 * override badge (who + why + when — the audit trail is the point). Pure
 * presentation over #35's gates proxy shape. The original gate_results row is
 * KEPT when overridden (pass stays 0); the override is a separate marker the
 * gates endpoint joins in. Read-only — no override control here.
 */
export interface GatesCardProps {
  gates: GateResultWithOverride[];
}

export function GatesCard(handle: Handle<GatesCardProps>) {
  return () => {
    const { gates } = handle.props;
    return (
      <Card title="GATES" summary={gates.length === 0 ? "no gate results" : `${gates.length} gate run(s)`} defaultOpen={gates.length > 0}>
        {gates.length === 0 ? (
          <p data-gates-empty mix={emptyStyle}>no gate results recorded for this phase</p>
        ) : (
          <ul mix={gateListStyle}>
            {gates.map((g) => (
              <li key={g.id} data-gate-row data-gate={g.gate} data-gate-pass={g.pass} mix={gateRowStyle}>
                <span mix={mono}>
                  {g.pass === 1 ? okGlyph : badGlyph} {g.gate}
                  <span mix={runMetaStyle}> · {fmtStartedAt(g.ran_at)}</span>
                </span>
                {g.pass === 0 && g.violations !== "[]" ? (
                  <span data-gate-violations mix={violationsStyle}>
                    {parseViolations(g.violations).join("; ") || "no violations recorded"}
                  </span>
                ) : null}
                {g.overridden === 1 ? (
                  <span data-gate-overridden mix={overrideStyle}>
                    <Badge tone="amber">overridden</Badge>
                    <span>
                      by {g.override_by ?? "unknown"} — {g.override_reason ?? "(no reason)"}
                      {g.overridden_at !== null ? ` · ${fmtStartedAt(g.overridden_at)}` : ""}
                    </span>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  };
}

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
  borderLeft: "3px solid var(--border)",
  background: "var(--muted)",
});

const runMetaStyle = css({
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-xs)",
});

const violationsStyle = css({
  color: "var(--status-failed)",
  fontSize: "var(--font-size-sm)",
});

const overrideStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "var(--font-size-sm)",
  color: "var(--status-paused)",
});

const emptyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});
