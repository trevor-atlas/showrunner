import { css, on, ref, type Handle } from "remix/ui";

import { fmtDuration, fmtMoney, fmtTime } from "./format.ts";

/**
 * The live feed: folded server events (types 1–12)
 * rendered newest-last, one typed row per event. Tool calls read aloud like
 * `bash: ls -la src` and expand (via a native <details>) to the raw args +
 * result snippet; corrections show ⚠ with the message; gate results ✗/✓ with
 * violations; human actions get a distinct marker; spend deltas show the USD
 * and token counts; run/phase/agent lifecycle rows summarize their events.
 *
 * The feed container owns auto-scroll (toggleable; paused on hover — the
 * scroll state lives in the poll owner and is passed down as `autoScroll` /
 * `onToggleAutoScroll`; the container element is surfaced through
 * `feedRef` so the owner can scroll it after each poll update).
 */

/** The event row shape the feed renders (serializable at the client-entry
 * boundary; the server's `data` column is arbitrary JSON, validated per type
 * at render time). */
export type FeedEvent = {
  id: number;
  phase_id: string | null;
  agent_session_id: string | null;
  type: string;
  ts: string;
  data: any;
};

export interface EventFeedProps {
  events: FeedEvent[];
  /** auto-scroll is ON — the owner owns the flag (toggleable state) */
  autoScroll: boolean;
  /** flip the auto-scroll flag */
  onToggleAutoScroll: () => void;
  /** hover pause notification (the owner suppresses auto-scroll while the
   * pointer is over the feed) */
  onHoverChange?: (paused: boolean) => void;
  /** the scrollable container, surfaced to the poll owner */
  feedRef?: (node: HTMLElement | null) => void;
}

export function EventFeed(handle: Handle<EventFeedProps>) {
  return () => {
    const { events, autoScroll, onToggleAutoScroll, onHoverChange, feedRef } = handle.props;
    return (
      <section data-testid="live-feed" mix={feedStyle}>
        <header mix={feedHeaderStyle}>
          <h2 mix={feedTitleStyle}>live feed</h2>
          <button
            type="button"
            data-auto-scroll={autoScroll ? "on" : "off"}
            mix={[toggleStyle, on("click", onToggleAutoScroll)]}
            aria-pressed={autoScroll}
          >
            auto-scroll {autoScroll ? "●" : "○"}
          </button>
        </header>
        <div
          data-feed
          mix={[
            scrollStyle,
            on("pointerenter", () => onHoverChange?.(true)),
            on("pointerleave", () => onHoverChange?.(false)),
            ref((node) => feedRef?.(node as HTMLElement | null)),
          ]}
        >
          {events.length === 0 ? (
            <p mix={emptyFeedStyle} data-feed-empty>
              no events yet — the live feed appears here as the run runs
            </p>
          ) : (
            events.map((event) => <EventRow key={event.id} event={event} />)
          )}
        </div>
      </section>
    );
  };
}

/**
 * Typed rendering per event type. One row: clock time + glyph +
 * per-type detail. The `data-event-type` attribute keeps every row
 * assertable.
 */
export function EventRow(handle: Handle<{ event: FeedEvent }>) {
  return () => {
    const { event } = handle.props;
    return (
      <div mix={rowStyle} data-event-type={event.type} data-event-id={event.id}>
        <span mix={timeStyle}>{fmtTime(event.ts)}</span>
        {renderByType(event)}
      </div>
    );
  };
}

function renderByType(event: FeedEvent) {
  switch (event.type) {
    case "tool_call":
      return <ToolCallRow event={event} />;
    case "correction":
      return (
        <span data-message={(event.data as { message?: string }).message ?? ""}>
          <span mix={corrGlyphStyle}>⚠ corr</span>{" "}
          {(event.data as { message?: string }).message ?? ""}
        </span>
      );
    case "gate_result":
      return <GateRow event={event} />;
    case "human_action":
      return <HumanActionRow event={event} />;
    case "spend":
      return <SpendRow event={event} />;
    case "run_status": {
      const d = event.data as { from?: string; to?: string; reason?: string };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>run</span> {d.from ?? "?"} → {d.to ?? "?"}
          {d.reason ? <span mix={mutedStyle}> · {d.reason}</span> : null}
        </span>
      );
    }
    case "phase_start": {
      const d = event.data as { phase?: string; agent?: string; visit?: number; budget?: number };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>phase</span> {d.phase ?? "?"} started
          <span mix={mutedStyle}>
            {" "}
            · agent {d.agent ?? "?"} · visit {d.visit ?? 0} · budget {d.budget ?? 0}
          </span>
        </span>
      );
    }
    case "phase_end": {
      const d = event.data as { phase?: string; status?: string; visits?: number; corrections?: number; spend_usd?: number };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>phase</span> {d.phase ?? "?"} {d.status ?? "?"}
          <span mix={mutedStyle}>
            {" "}
            · visits {d.visits ?? 0} · corrections {d.corrections ?? 0} · {fmtMoney(d.spend_usd ?? 0)}
          </span>
        </span>
      );
    }
    case "agent_start": {
      const d = event.data as { agent?: string; model?: string; pid?: number };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>agent</span> {d.agent ?? "?"} started
          <span mix={mutedStyle}>
            {" "}
            · {d.model ?? "?"} · pid {d.pid ?? 0}
          </span>
        </span>
      );
    }
    case "agent_end": {
      const d = event.data as { agent?: string; exit?: number | null; ok?: boolean };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>agent</span> {d.agent ?? "?"} ended ·{" "}
          {d.ok === false ? "✗" : "✓"} exit {d.exit === null || d.exit === undefined ? "?" : d.exit}
        </span>
      );
    }
    case "envelope": {
      const d = event.data as { phase?: string; visit?: number; attempt?: number; valid?: boolean };
      return (
        <span>
          <span mix={envelopeGlyphStyle}>envelope</span> {d.phase ?? "?"} · visit {d.visit ?? 0} ·
          attempt {d.attempt ?? 0} · {d.valid ? "valid" : "rejected"}
        </span>
      );
    }
    case "run_submitted": {
      const d = event.data as { blueprint?: string; cwd?: string };
      return (
        <span>
          <span mix={lifecycleGlyphStyle}>run</span> submitted · {d.blueprint ?? "?"}
          <span mix={mutedStyle}> · cwd {d.cwd ?? "?"}</span>
        </span>
      );
    }
    default:
      return <span mix={mutedStyle}>unknown event</span>;
  }
}

/** Tool call — `bash: ls -la src`, expandable to args + result snippet. */
function ToolCallRow(handle: Handle<{ event: FeedEvent }>) {
  return () => {
    const { event } = handle.props;
    const d = event.data as {
      tool?: string;
      args?: unknown;
      result_snippet?: string;
      ok?: boolean;
      duration_ms?: number;
      agent?: string;
    };
    const name = describeToolCall(d.tool ?? "tool", d.args);
    return (
      <span data-tool-call data-tool-name={name} data-tool-ok={d.ok === false ? "false" : "true"}>
        <span mix={toolGlyphStyle}>▶ tool</span>{" "}
        <code mix={toolNameStyle}>{name}</code>
        {d.ok === false ? <span mix={toolFailStyle}> ✗</span> : <span mix={toolOkStyle}> ✓</span>}
        {typeof d.duration_ms === "number" ? (
          <span mix={mutedStyle}> {fmtDuration(d.duration_ms)}</span>
        ) : null}
        <details mix={detailsStyle}>
          <summary mix={summaryStyle}>args + result</summary>
          <pre mix={snippetStyle}>
            {JSON.stringify(d.args ?? null, null, 2)}
            {"\n— result —\n"}
            {d.result_snippet ?? ""}
          </pre>
        </details>
      </span>
    );
  };
}

/** Gate result — ✗/✓ gate with the violation count. */
function GateRow(handle: Handle<{ event: FeedEvent }>) {
  return () => {
    const { event } = handle.props;
    const d = event.data as { gate?: string; pass?: boolean; violations?: string[] };
    const violations = d.violations ?? [];
    return (
      <span data-gate={d.gate ?? "?"} data-gate-pass={d.pass === false ? "false" : "true"}>
        {d.pass === false ? <span mix={gateFailGlyphStyle}>✗ gate</span> : <span mix={gatePassGlyphStyle}>✓ gate</span>}{" "}
        {d.gate ?? "?"}
        {violations.length > 0 ? (
          <span mix={mutedStyle}> · violations: {violations.length}</span>
        ) : null}
      </span>
    );
  };
}

/** Human action — steer / approve / override / restart / fail (distinct). */
function HumanActionRow(handle: Handle<{ event: FeedEvent }>) {
  return () => {
    const { event } = handle.props;
    const d = event.data as { action?: string; by?: string; detail?: string };
    return (
      <span data-human-action={d.action ?? "?"}>
        <span mix={humanGlyphStyle}>human</span> {d.action ?? "?"}
        {d.by ? <span mix={mutedStyle}> · by {d.by}</span> : null}
        {d.detail ? <span mix={mutedStyle}> · {d.detail}</span> : null}
      </span>
    );
  };
}

/** Spend delta — USD + token counts. */
function SpendRow(handle: Handle<{ event: FeedEvent }>) {
  return () => {
    const { event } = handle.props;
    const d = event.data as {
      phase?: string;
      tokens_in?: number;
      tokens_out?: number;
      cache_read?: number;
      cache_write?: number;
      usd?: number | null;
      estimated?: boolean;
    };
    return (
      <span data-spend>
        <span mix={spendGlyphStyle}>spend</span>{" "}
        {d.usd !== null && d.usd !== undefined ? fmtMoney(d.usd) : "?"}
        {d.estimated ? <span mix={mutedStyle}> (est)</span> : null}
        <span mix={mutedStyle}>
          {" "}
          · in {d.tokens_in ?? 0} · out {d.tokens_out ?? 0} · cache r/w {d.cache_read ?? 0}/{d.cache_write ?? 0}
        </span>
      </span>
    );
  };
}

/**
 * The naming rule for tool calls: name the row the way you'd read
 * it aloud — `bash: ls -la src`, `edit: packages/server/src/db.ts`. String
 * args are used as-is; object args pick the most name-like field; anything
 * else falls back to compact JSON.
 */
export function describeToolCall(tool: string, args: unknown): string {
  if (typeof args === "string") {
    const trimmed = args.trim();
    return `${tool}: ${trimmed === "" ? "(no args)" : trimmed}`;
  }
  if (typeof args === "object" && args !== null) {
    const obj = args as Record<string, unknown>;
    const candidate =
      obj.filePath ?? obj.path ?? obj.package ?? obj.command ?? obj.message ?? obj.name ?? obj.tool ?? obj.content;
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return `${tool}: ${candidate.trim()}`;
    }
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(args) ?? "";
  } catch {
    serialized = String(args);
  }
  const label = serialized.length > 40 ? `${serialized.slice(0, 40)}…` : serialized;
  return `${tool}: ${label === "undefined" || label === "" ? "(no args)" : label}`;
}

const feedStyle = css({
  display: "grid",
  gap: "0.5rem",
});

const feedHeaderStyle = css({
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
});

const feedTitleStyle = css({
  margin: 0,
  fontSize: "var(--font-size-xs)",
  textTransform: "lowercase",
  letterSpacing: "0.06em",
  color: "var(--muted-foreground)",
  fontWeight: 700,
});

const toggleStyle = css({
  appearance: "none",
  font: "inherit",
  fontSize: "var(--font-size-xs)",
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: "999px",
  border: "1px solid var(--input)",
  background: "var(--card)",
  color: "var(--foreground)",
  cursor: "pointer",
  "&:hover": {
    background: "var(--secondary)",
  },
});

const scrollStyle = css({
  maxHeight: "20rem",
  overflowY: "auto",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "var(--card)",
  padding: "0.5rem 0.75rem",
  display: "grid",
  gap: "0.15rem",
});

const emptyFeedStyle = css({
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
});

const timeStyle = css({
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-xs)",
  whiteSpace: "nowrap",
});

const mutedStyle = css({
  color: "var(--muted-foreground)",
});

const toolGlyphStyle = css({
  color: "var(--status-running)",
  fontWeight: 700,
});

const toolNameStyle = css({
  color: "var(--foreground)",
  fontWeight: 600,
});

const toolOkStyle = css({ color: "var(--status-success)" });

const toolFailStyle = css({ color: "var(--status-failed)" });

const corrGlyphStyle = css({
  color: "var(--status-interrupted)",
  fontWeight: 700,
});

const gateFailGlyphStyle = css({ color: "var(--status-failed)", fontWeight: 700 });

const gatePassGlyphStyle = css({ color: "var(--status-success)", fontWeight: 700 });

const humanGlyphStyle = css({
  color: "var(--accent-violet)",
  fontWeight: 700,
});

const spendGlyphStyle = css({
  color: "var(--accent-teal)",
  fontWeight: 700,
});

const lifecycleGlyphStyle = css({
  color: "var(--muted-foreground)",
  fontWeight: 700,
});

const envelopeGlyphStyle = css({
  color: "var(--accent-sky)",
  fontWeight: 700,
});

const detailsStyle = css({
  marginLeft: "0.25rem",
});

const summaryStyle = css({
  cursor: "pointer",
  color: "var(--muted-foreground)",
  fontSize: "var(--font-size-xs)",
  userSelect: "none",
});

const snippetStyle = css({
  margin: "0.3rem 0 0.4rem 1.25rem",
  padding: "0.4rem 0.5rem",
  background: "var(--secondary)",
  border: "1px solid var(--border)",
  borderRadius: "6px",
  fontSize: "var(--font-size-xs)",
  whiteSpace: "pre-wrap",
  maxHeight: "10rem",
  overflowY: "auto",
});
