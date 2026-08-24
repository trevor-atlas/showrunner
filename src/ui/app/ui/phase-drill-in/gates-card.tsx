import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { GateResultWithOverride } from "../../../../daemon/db.ts";
import { fmtStartedAt } from "../format.ts";
import { Badge, badGlyph, Card, mono, okGlyph } from "./card.tsx";
import { parseViolations } from "../public/envelope-parse.ts";

/**
 * GATES card (§16.8) — per gate: pass/fail, the violations list, and the
 * §5.3 override badge (who + why + when — the audit trail is the point). The
 * original gate_results row is KEPT when overridden (pass stays 0); the
 * override is a separate marker the §13.1 gates endpoint joins in.
 *
 * Rendered data ONLY — no override button here (the override control is
 * T10b's ticket; this page is read-only).
 */

export interface GatesCardProps {
  gates: GateResultWithOverride[];
}

export function GatesCard(handle: Handle<GatesCardProps>) {
  return () => {
    const { gates } = handle.props;
    return (
      <Card title="GATES" summary={gates.length === 0 ? "no gate results" : `${gates.length} gate run(s)`}>
        {gates.length === 0 ? (
          <p mix={emptyStyle}>no gate results recorded for this phase</p>
        ) : (
          <ul mix={gateListStyle}>
            {gates.map((g) => (
              <li key={g.id} mix={gateRowStyle}>
                <span mix={mono}>
                  {g.pass === 1 ? okGlyph : badGlyph} {g.gate}
                  <span mix={runMetaStyle}> · {fmtStartedAt(g.ran_at)}</span>
                </span>
                {g.pass === 0 && g.violations !== "[]" ? (
                  <span mix={violationsStyle}>
                    {parseViolations(g.violations).join("; ") || "no violations recorded"}
                  </span>
                ) : null}
                {g.overridden === 1 ? (
                  <span mix={overrideStyle}>
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
  borderLeft: "3px solid #e5e7eb",
  background: "#f9fafb",
});

const runMetaStyle = css({
  color: "#6b7280",
  fontSize: "11px",
});

const violationsStyle = css({
  color: "#b91c1c",
  fontSize: "12px",
});

const overrideStyle = css({
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap",
  fontSize: "12px",
  color: "#92400e",
});

const emptyStyle = css({
  margin: 0,
  color: "#6b7280",
  fontSize: "12px",
});
