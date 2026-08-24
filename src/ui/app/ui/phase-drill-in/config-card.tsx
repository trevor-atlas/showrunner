import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { SnapshotPhase } from "../../lib/blueprint-snapshot.ts";
import { describeContextEntries } from "../../lib/phase-data.ts";
import { Card, mono, Pre } from "./card.tsx";

/**
 * CONFIG card — the phase's agent configuration FROM THE
 * BLUEPRINT SNAPSHOT, never the live blueprint module: "the snapshot is what
 * actually ran". Renders agent name/model, tools, context (inlined-file
 * markers + literals), and the prompt pre block.
 */

export interface ConfigCardProps {
  /** the run's phase row (drill-in header context) */
  agentName: string;
  snapshotPhase: SnapshotPhase | null;
  /** the run's cwd — where relative context entries were resolved at run time */
  cwd: string;
  /** the snapshot's blueprint module dir (dirname of doc.module), for context fallback */
  moduleDir: string | null;
}

export function ConfigCard(handle: Handle<ConfigCardProps>) {
  return () => {
    const { snapshotPhase } = handle.props;
    if (snapshotPhase === null) {
      return (
        <Card title="CONFIG" summary={handle.props.agentName}>
          <p mix={noneStyle}>no blueprint snapshot for this phase (fixture/observation run)</p>
        </Card>
      );
    }
    const agent = snapshotPhase.agent;
    const context = describeContextEntries(agent.context, handle.props.cwd, handle.props.moduleDir);
    return (
      <Card
        title="CONFIG"
        summary={`agent: ${agent.name} · model: ${agent.model}`}
      >
        <div mix={rowStyle}>
          <span mix={labelStyle}>tools</span>
          <span mix={mono}>{agent.tools.length === 0 ? "—" : agent.tools.join(", ")}</span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>context</span>
          <span mix={mono}>
            {context.length === 0 ? "—" : context.map((c) => c.entry).join(" · ")}
          </span>
        </div>
        <div mix={rowStyle}>
          <span mix={labelStyle}>prompt</span>
          <Pre>{agent.prompt}</Pre>
        </div>
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
  fontSize: "11px",
  fontWeight: 800,
  letterSpacing: "0.06em",
  color: "#6b7280",
  textTransform: "uppercase",
});

const noneStyle = css({
  margin: 0,
  color: "#6b7280",
  fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: "12px",
});
