import { css, type Handle } from "remix/ui";

import type { TrajectoryEntry, TrajectoryView } from "../../../contract.ts";

/**
 * The Trajectory tab's scrolling LOG FEED (#84 — the deepseek-style feed).
 * One typed row per parsed trajectory entry in raw-stream order: a USER row
 * (lane "input"), an ASSISTANT row (lane "model"), or a TOOL row (lane
 * "tools"), each with the row's text/jsonl TRUNCATED to a single readable
 * line. Swimlanes / drill-in / zoom are later tickets (#85–#87) — this feed is
 * the flat baseline they extend.
 *
 * Rows carry stable queryable attributes (`data-testid="trajectory-row"`,
 * `data-seq`, `data-lane`) so tests key off them, not prose — the same house
 * style as the live event feed's `data-event-type`/`data-event-id`.
 */
export interface TrajectoryFeedProps {
  view: TrajectoryView;
}

export function TrajectoryFeed(handle: Handle<TrajectoryFeedProps>) {
  return () => {
    const { view } = handle.props;
    return (
      <section data-testid="trajectory-feed" mix={feedStyle}>
        {view.entries.length === 0 ? (
          <p data-feed-empty mix={emptyStyle}>
            no trajectory yet — this phase has no parsed activity
          </p>
        ) : (
          view.entries.map((entry) => <TrajectoryRow key={entry.seq} entry={entry} />)
        )}
      </section>
    );
  };
}

/** One trajectory row — the lane discriminates the shape, so a tool's fields
 * never appear on a message row and vice versa (the #83 union). */
function TrajectoryRow(handle: Handle<{ entry: TrajectoryEntry }>) {
  return () => {
    const { entry } = handle.props;
    return (
      <div data-testid="trajectory-row" data-seq={entry.seq} data-lane={entry.lane} mix={rowStyle}>
        <span mix={labelStyle} data-role={laneLabel(entry)}>
          {laneLabel(entry)}
        </span>
        <span mix={textStyle}>{truncate(rowText(entry))}</span>
      </div>
    );
  };
}

/** USER (input) / ASSISTANT (model) / TOOL (tools) — the row's kind badge. */
function laneLabel(entry: TrajectoryEntry): "USER" | "ASSISTANT" | "TOOL" {
  switch (entry.lane) {
    case "input":
      return "USER";
    case "model":
      return "ASSISTANT";
    case "tools":
      return "TOOL";
  }
}

/** The row's one-line jsonl body: a message shows its text; a tool call shows
 * the tool name plus the compact jsonl of its args/result (truncated by the
 * row). */
function rowText(entry: TrajectoryEntry): string {
  if (entry.lane === "tools") {
    return `${entry.tool} ${jsonl({ args: entry.args, result: entry.result, ok: entry.ok })}`;
  }
  return entry.text;
}

/** Compact single-line JSON — the "jsonl" the row truncates. */
function jsonl(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

const CLAMP = 240;

/** Truncate to a single readable line with an ellipsis marker. */
function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CLAMP ? `${oneLine.slice(0, CLAMP)}…` : oneLine;
}

const feedStyle = css({
  maxHeight: "28rem",
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  padding: "0.5rem 0.75rem",
  display: "grid",
  gap: "0.15rem",
});

const emptyStyle = css({
  margin: 0,
  padding: "1rem 0",
  textAlign: "center",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-mono)",
});

const rowStyle = css({
  display: "flex",
  alignItems: "baseline",
  gap: "0.5rem",
  padding: "0.2rem 0",
  fontSize: "var(--font-size-sm)",
  borderBottom: "1px solid var(--secondary)",
  fontFamily: "var(--font-mono)",
  "&[data-lane='input']": { color: "var(--foreground)" },
  "&[data-lane='model']": { color: "var(--foreground)" },
  "&[data-lane='tools']": { color: "var(--muted-foreground)" },
});

const labelStyle = css({
  fontWeight: 700,
  fontSize: "var(--font-size-xs)",
  whiteSpace: "nowrap",
  "&[data-role='USER']": { color: "var(--accent-sky)" },
  "&[data-role='ASSISTANT']": { color: "var(--accent-violet)" },
  "&[data-role='TOOL']": { color: "var(--status-running)" },
});

const textStyle = css({
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
});
