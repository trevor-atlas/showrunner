import { clientEntry, css, type Handle, type SerializableProps } from "remix/ui";

import { Gantt } from "../../ui/public/gantt.tsx";
import { computeGantt } from "../../ui/public/gantt-model.ts";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import { EventFeed } from "../../ui/public/event-feed.tsx";

/**
 * The run-detail LIVE region (spec §16.5): the hydrated clientEntry that owns
 * the gantt + live feed. Server-rendered once with the initial snapshot (full
 * history — §4.3 the cursor query IS the read transport), then the browser
 * polls `GET /runs/:runId/events.json?cursor=N` every ~1s while the page is
 * open, keeping `next_cursor` in setup scope — the same query, sliding
 * window, zero server state. Each poll merges the new events, recomputes the
 * gantt from the same phase_start/phase_end/run_status events the feed shows,
 * and `handle.update()` re-renders both — the gantt and the feed are always
 * one snapshot.
 *
 * Read-only: this region never POSTs — the control verbs are T10b's ticket.
 */

/** The poll cadence (§16.5: 1 s per open run detail page). */
export const POLL_MS = 1000;

/** The per-phase shape the region carries across the client-entry boundary. */
export type LivePhase = {
  name: string;
  agent: string;
  status: string;
  corrections: number;
  visits: number;
  spend_usd: number;
  started_at: string | null;
  ended_at: string | null;
};

export interface RunLiveRegionProps extends SerializableProps {
  runId: string;
  /** run timeline + status (for the gantt + now cursor) */
  run: { started_at: string; ended_at: string | null; status: string };
  /** the run's phases in blueprint order (from the detail endpoint) */
  phases: LivePhase[];
  /** the FULL event history so far (initial load or last poll merge) */
  events: FeedEvent[];
  /** the last event rowid — the cursor for the next poll (§4.3) */
  cursor: number;
  /** the events.json proxy href for this run (routes.runs.events.href) */
  eventsHref: string;
}

export const RunLiveRegion = clientEntry(
  import.meta.url,
  function RunLiveRegion(handle: Handle<RunLiveRegionProps>) {
    // ── setup scope — runs once ───────────────────────────────────────────
    let events: FeedEvent[] = [...handle.props.events];
    let cursor = handle.props.cursor;
    let status = handle.props.run.status;
    let autoScroll = true;
    let hoverPaused = false;
    let feedNode: HTMLElement | null = null;
    let polling = false;

    const poll = async (): Promise<void> => {
      if (polling) return; // a slow round-trip must not stack polls
      polling = true;
      try {
        const url = new URL(handle.props.eventsHref, window.location.href);
        url.searchParams.set("cursor", String(cursor));
        const response = await fetch(url);
        if (!response.ok) {
          // 404 = the run is gone — stop polling; anything else (e.g. the
          // daemon hiccupping) is transient — keep the last snapshot and
          // retry on the next tick
          if (response.status === 404) stopPolling();
          return;
        }
        const page = (await response.json()) as { events: FeedEvent[]; next_cursor: number };
        if (page.events.length > 0) {
          events = [...events, ...page.events];
          cursor = page.next_cursor;
        } else {
          cursor = page.next_cursor; // idempotent at the tail (§4.3)
        }
        // keep the run status live from run_status events — the gantt's
        // paused amber edge + fill edge track it
        for (const ev of page.events) {
          if (ev.type === "run_status") {
            const to = (ev.data as { to?: unknown }).to;
            if (typeof to === "string" && (to === "paused" || to === "running")) status = to;
          }
        }
        await handle.update();
        if (autoScroll && !hoverPaused && feedNode) {
          feedNode.scrollTop = feedNode.scrollHeight;
        }
      } catch {
        // transient fetch/parse failure — the next tick retries
      } finally {
        polling = false;
      }
    };

    const stopPolling = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    let timer: ReturnType<typeof setInterval> | null = null;
    // Setup ALSO runs server-side during SSR (clientEntry components render
    // like any other component) — the poll loop is browser-only, so only arm
    // it when window exists. The abort listener mirrors that.
    if (typeof window !== "undefined") {
      timer = setInterval(() => void poll(), POLL_MS);
      handle.signal.addEventListener("abort", () => stopPolling());
    }

    return () => {
      const { runId, run, phases } = handle.props;
      const now = Date.now();
      const model = computeGantt(phases, { ...run, status }, events, now);

      return (
        <div mix={regionStyle}>
          <Gantt model={model} runId={runId} />
          <EventFeed
            events={events}
            autoScroll={autoScroll}
            onToggleAutoScroll={() => {
              autoScroll = !autoScroll;
              handle.update();
            }}
            onHoverChange={(paused) => {
              hoverPaused = paused;
            }}
            feedRef={(node) => {
              feedNode = node;
              if (node !== null && autoScroll && !hoverPaused) {
                node.scrollTop = node.scrollHeight;
              }
            }}
          />
        </div>
      );
    };
  },
);

const regionStyle = css({
  display: "grid",
  gap: "1.25rem",
});
