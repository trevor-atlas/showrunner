import { dirname, isAbsolute, join } from "node:path";
import { existsSync, statSync } from "node:fs";

import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { SnapshotPhase } from "../../lib/blueprint-snapshot.ts";
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

export type ContextEntryKind = "inlined-file" | "literal";

export interface ContextEntry {
  /** the raw snapshot entry text */
  raw: string;
  kind: ContextEntryKind;
  /** rendered text: "README.md (inlined)" for files, quoted literals otherwise */
  entry: string;
}

/**
 * Resolve each context entry the way the daemon did at run time
 * (handoff.ts resolveContextFile: cwd first, then the blueprint module dir):
 * an entry that resolves to an existing file is marked "(inlined)"; anything
 * else was passed through as a literal. Best-effort — files may have changed
 * since the snapshot, so this is the current-resolution view.
 */
export function describeContextEntries(
  entries: readonly string[],
  cwd: string,
  moduleDir: string | null,
): ContextEntry[] {
  return entries.map((raw) => {
    const file = resolveContextFile(cwd, moduleDir, raw);
    if (file !== null) {
      return { raw, kind: "inlined-file", entry: `${raw} (inlined)` };
    }
    return { raw, kind: "literal", entry: `"${raw}"` };
  });
}

function resolveContextFile(cwd: string, moduleDir: string | null, entry: string): string | null {
  const candidates: string[] = [];
  if (isAbsolute(entry)) {
    candidates.push(entry);
  } else {
    candidates.push(join(cwd, entry));
    if (moduleDir !== null) candidates.push(join(moduleDir, entry));
  }
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // keep walking
    }
  }
  return null;
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
