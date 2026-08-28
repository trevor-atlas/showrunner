import { css, on, type Handle } from "remix/ui";

import type { TrajectoryEntry } from "../../../contract.ts";

/**
 * The Trajectory tab's drill-in DETAIL SIDEBAR (#86). Given the feed entry the
 * user clicked, it renders a `kind · Turn N · Step M` header and four
 * switchable sub-tabs — Summary / Payload / Result / Timing — so the reader can
 * inspect one row without leaving the feed. The lane discriminates the shape
 * (the #83 union): a tool surfaces its args (Payload), its result snippet
 * (Result), and its correlated ts + duration (Timing); a message surfaces its
 * text (Payload) with an explicit n/a Result and "not available" Timing.
 *
 * The sidebar carries stable attributes (`data-testid="trajectory-detail"` and
 * `…-header`/`…-subtab`/`…-panel`/`…-close`) so tests key off them — the same
 * house style as the feed rows and swimlane points. Colors come from theme
 * tokens, never hardcoded hex.
 */
export interface TrajectoryDetailProps {
  entry: TrajectoryEntry;
  onClose: () => void;
}

type SubTab = "summary" | "payload" | "result" | "timing";

const SUB_TABS: readonly { id: SubTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "payload", label: "Payload" },
  { id: "result", label: "Result" },
  { id: "timing", label: "Timing" },
];

export function TrajectoryDetail(handle: Handle<TrajectoryDetailProps>) {
  let active: SubTab = "summary";
  const show = (id: SubTab): void => {
    active = id;
    void handle.update();
  };
  return () => {
    const { entry, onClose } = handle.props;
    return (
      <aside data-testid="trajectory-detail" mix={sidebarStyle}>
        <header data-testid="trajectory-detail-header" mix={headerStyle}>
          <span mix={headerTextStyle}>
            {entryKind(entry)} · Turn {entry.turn} · Step {entry.step}
          </span>
          <button
            type="button"
            data-testid="trajectory-detail-close"
            aria-label="close detail"
            mix={[closeStyle, on("click", () => onClose())]}
          >
            ×
          </button>
        </header>
        <nav role="tablist" aria-label="detail sections" mix={tabBarStyle}>
          {SUB_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              data-testid="trajectory-detail-subtab"
              data-subtab={tab.id}
              aria-selected={active === tab.id}
              mix={[tabStyle, active === tab.id ? tabActiveStyle : null, on("click", () => show(tab.id))]}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <div data-testid="trajectory-detail-panel" data-subtab={active} mix={bodyStyle}>
          <SubPanel entry={entry} active={active} />
        </div>
      </aside>
    );
  };
}

function SubPanel(handle: Handle<{ entry: TrajectoryEntry; active: SubTab }>) {
  return () => {
    const { entry, active } = handle.props;
    switch (active) {
      case "summary":
        return <pre mix={preStyle}>{summaryText(entry)}</pre>;
      case "payload":
        return <pre mix={preStyle}>{payloadText(entry)}</pre>;
      case "result":
        return <pre mix={preStyle}>{entry.lane === "tools" ? entry.result : "n/a — messages carry no result"}</pre>;
      case "timing":
        return <pre mix={preStyle}>{timingText(entry)}</pre>;
    }
  };
}

/** USER (input) / ASSISTANT (model) / TOOL (tools) — the entry's kind badge,
 * the same mapping the feed rows use. */
function entryKind(entry: TrajectoryEntry): "USER" | "ASSISTANT" | "TOOL" {
  switch (entry.lane) {
    case "input":
      return "USER";
    case "model":
      return "ASSISTANT";
    case "tools":
      return "TOOL";
  }
}

/** A compact overview of the entry — the tool name / ok status, or the
 * message role. */
function summaryText(entry: TrajectoryEntry): string {
  if (entry.lane === "tools") {
    return `${entry.tool} · ${entry.ok ? "ok" : "failed"}`;
  }
  return `${entry.role} message`;
}

/** Payload = a message's text, or a tool's args as pretty json. */
function payloadText(entry: TrajectoryEntry): string {
  if (entry.lane === "tools") {
    return prettyJson(entry.args);
  }
  return entry.text;
}

/** Timing = a tool's correlated ts + duration when known; otherwise (or for a
 * message) an explicit "not available". */
function timingText(entry: TrajectoryEntry): string {
  if (entry.lane !== "tools" || (entry.ts === null && entry.duration_ms === null)) {
    return "timing not available";
  }
  const ts = entry.ts ?? "not available";
  const duration = entry.duration_ms === null ? "not available" : `${entry.duration_ms} ms`;
  return `ts: ${ts}\nduration: ${duration}`;
}

/** Multi-line pretty JSON — the "jsonl" the feed truncates, expanded here. */
function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

const sidebarStyle = css({
  flexShrink: 0,
  width: "18rem",
  maxHeight: "28rem",
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  display: "grid",
  gridTemplateRows: "auto auto 1fr",
  gap: "0.5rem",
  padding: "0.5rem 0.75rem",
});

const headerStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.5rem",
});

const headerTextStyle = css({
  fontWeight: 700,
  fontSize: "var(--font-size-sm)",
  fontFamily: "var(--font-mono)",
  color: "var(--foreground)",
});

const closeStyle = css({
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  cursor: "pointer",
  fontSize: "var(--font-size-md)",
  lineHeight: 1,
  padding: "0 0.25rem",
  "&:hover": { color: "var(--foreground)" },
});

const tabBarStyle = css({
  display: "flex",
  gap: "0.25rem",
  borderBottom: "1px solid var(--border)",
});

const tabStyle = css({
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  cursor: "pointer",
  fontSize: "var(--font-size-xs)",
  fontWeight: 600,
  padding: "0.2rem 0.4rem",
  borderBottom: "2px solid transparent",
});

const tabActiveStyle = css({
  color: "var(--foreground)",
  borderBottomColor: "var(--accent-sky)",
});

const bodyStyle = css({
  minHeight: 0,
  overflow: "auto",
});

const preStyle = css({
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--font-size-xs)",
  color: "var(--foreground)",
});
