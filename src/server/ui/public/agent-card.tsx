import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { SnapshotPhase } from "../../lib/blueprint-snapshot.ts";
import type { ContextEntry, ContextEntryKind } from "../../lib/phase-data.ts";
import { Card, mono, Pre } from "./phase-card-shell.tsx";

/**
 * AGENT card (issue #37) — the phase's agent as it ran, from the run's
 * blueprint snapshot: name, model, tools, context entries, and the prompt
 * (collapsed). Pure presentation. Context entries arrive PRE-RESOLVED
 * ({raw, kind, entry}) from #35's snapshot.json proxy — the disk resolution
 * that used to live in config-card.tsx is server-side now, so this card never
 * touches the filesystem. `phase === null` is the "no blueprint snapshot"
 * state for fixture/observation runs.
 */
export interface AgentCardProps {
  /** the phase's SnapshotPhase, or null when the run wrote no snapshot */
  phase: SnapshotPhase | null;
  /** context entries resolved to {raw, kind, entry} by the snapshot proxy */
  context: ContextEntry[];
}

/** Human label for a context entry's resolution kind (title/aria affordance). */
export function contextKindLabel(kind: ContextEntryKind): string {
  return kind === "inlined-file" ? "inlined file" : "literal string";
}

export function AgentCard(handle: Handle<AgentCardProps>) {
  return () => {
    const { phase, context } = handle.props;
    if (phase === null) {
      return (
        <Card title="AGENT">
          <p data-agent-empty mix={noneStyle}>
            no blueprint snapshot for this phase (fixture/observation run)
          </p>
        </Card>
      );
    }
    const agent = phase.agent;
    return (
      <Card title="AGENT" summary={`agent: ${agent.name} · model: ${agent.model}`}>
        <div mix={rowStyle}>
          <span mix={labelStyle}>tools</span>
          <span data-agent-tools mix={mono}>{agent.tools.length === 0 ? "—" : agent.tools.join(", ")}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>context</span>
          {context.length === 0 ? (
            <span data-agent-context mix={mono}>—</span>
          ) : (
            <ul data-agent-context mix={contextListStyle}>
              {context.map((c) => (
                <li key={c.raw} mix={mono} data-context-kind={c.kind} title={contextKindLabel(c.kind)}>
                  {c.entry}
                </li>
              ))}
            </ul>
          )}
        </div>
        <details mix={detailsStyle}>
          <summary mix={summaryStyle}>prompt</summary>
          <Pre>{agent.prompt}</Pre>
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

const contextListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.15rem",
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
