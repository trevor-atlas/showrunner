import { css } from "remix/ui";
import type { Handle } from "remix/ui";

import type { AgentSessionRow } from "../../../../daemon/db.ts";
import { fmtStartedAt } from "./format.ts";
import { Card, mono } from "./phase-card-shell.tsx";

/**
 * SESSIONS card (issue #37) — the phase's agent sessions, collapsed by default
 * (low priority, so it opens on demand): per visit the pi_session_id, the OS
 * pid (the column today's timeline panel lacks), and the session's start → end.
 * Pure presentation over #35's detail.sessions shape (AgentSessionRow[]),
 * pre-filtered to this phase by the owner; the card just sorts and renders.
 */
export interface SessionsCardProps {
  /** the phase's agent sessions (already scoped to the phase) */
  sessions: AgentSessionRow[];
}

export function SessionsCard(handle: Handle<SessionsCardProps>) {
  return () => {
    const sessions = [...handle.props.sessions].sort((a, b) =>
      a.visit !== b.visit ? a.visit - b.visit : a.started_at < b.started_at ? -1 : 1,
    );
    return (
      <Card title="SESSIONS" summary={`${sessions.length} session${sessions.length === 1 ? "" : "s"}`}>
        <div data-panel-sessions>
          {sessions.length === 0 ? (
            <p data-sessions-empty mix={emptyStyle}>no agent sessions recorded for this phase</p>
          ) : (
            <ul mix={sessionListStyle}>
              {sessions.map((s) => (
                <li key={s.id} data-session-row data-session-visit={s.visit} mix={sessionRowStyle}>
                  <span data-session-id mix={mono}>visit {s.visit} · {s.pi_session_id}</span>
                  <span data-session-pid mix={mono}>pid {s.pid}</span>
                  <span data-session-duration mix={mono}>
                    {fmtStartedAt(s.started_at)} → {s.ended_at !== null ? fmtStartedAt(s.ended_at) : "now"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    );
  };
}

const sessionListStyle = css({
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: "0.3rem",
});

const sessionRowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.75rem",
  flexWrap: "wrap",
  padding: "0.35rem 0.5rem",
  borderLeft: "3px solid var(--border)",
  background: "var(--muted)",
});

const emptyStyle = css({
  margin: 0,
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
});
