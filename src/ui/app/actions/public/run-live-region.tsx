import { clientEntry, css, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../../../daemon/db.ts";
import type { PhaseEnvelopes, PhaseGates, TimelineView } from "../../../../daemon/contract.ts";
import { routes } from "../../routes.ts";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import { EventFeed } from "../../ui/public/event-feed.tsx";
import { computeTimelineLayout } from "../../ui/public/timeline-model.ts";
import { Timeline } from "../../ui/public/timeline.tsx";
import { TimelinePanel } from "../../ui/public/timeline-panel.tsx";

/**
 * The client-entry boundary widens the daemon wire types (client.ts/db.ts)
 * with the SerializableProps index signature. The values are plain JSON — the
 * serialization at the entry boundary is exactly what the API returns —
 * so the widened types are structural only; the intersection documents that
 * these props ARE serializable (the same `as unknown as` widening the
 * server-side client uses at the daemon boundary).
 */
export type SerializableTimelineView = TimelineView & SerializableObject;
export type SerializableEnvelopeRow = EnvelopeRow & SerializableObject;
export type SerializableGateResult = GateResultWithOverride & SerializableObject;
export type SerializableAgentSession = AgentSessionRow & SerializableObject;

/**
 * The run-detail LIVE region (R4/R5): the hydrated clientEntry
 * that owns the timeline chart + the R5 detail panel + the live feed.
 * Server-rendered once with the initial snapshot (the R3 TimelineView — the
 * chart renders from it at SSR — plus the full event history; the cursor
 * query IS the read transport), then the browser polls
 * `GET /runs/:runId/events.json?cursor=N` every ~1s while the page is open,
 * keeping `next_cursor` in setup scope. Each poll merges the new events,
 * re-renders the feed, and recomputes the timeline's live edges (the now
 * cursor + open-segment ends) from the same events.
 *
 * R5 selection lives in SETUP scope so it survives the polls: the initial
 * selection (the ?phase= deep link, validated, or the auto-selected phase) is
 * resolved server-side; bubble/row clicks update the selection AND the
 * browser URL (history.replaceState with the same ?phase= query, so the
 * selection is always deep-linkable). The panel's envelopes/gates are fetched
 * LAZILY on selection through the envelopes.json / gates.json remix proxies
 * (the browser never talks to the daemon — the iron convention); the initial
 * selection's data is server-rendered by renderRunDetail and seeds the cache.
 *
 * R6 live behavior: each poll fetches events.json AND timeline.json in
 * parallel; the fresh R3 TimelineView replaces the setup-scope snapshot the
 * chart + panel render from (open bubbles extend to now, new segments appear
 * between refreshes, row order stays fixed — blueprint order is server-side).
 * A transient timeline fetch failure keeps the last snapshot and retries next
 * tick (same tolerance as the events fetch); a 404 on either proxy means the
 * run is gone and stops the poll. The paused treatment (striped active
 * bubble) comes from the tracked run status; the pause reason travels in the
 * run_status → paused event the poll already receives (pauseAt writes
 * `reason: pause.reason` — the same value the pause viewer reports), so
 * the panel header can surface it live with no extra proxy. The timeline
 * refetch never touches the R5 selection — it lives in a separate setup-scope
 * variable.
 *
 * Terminal transition (polish, T10b): a run that completes while the page is
 * open (a run_status → success/failed event arrives through the poll) freezes
 * the timeline — its right edge becomes the run_status moment, the now-cursor
 * disappears (both derived from the live ended_at/status in the layout) — and
 * the poll loop stops (a terminal run emits no more events; the feed is
 * final). Interrupted is NOT terminal — the run awaits a human resume, so the
 * poll keeps running; open segments render with the interrupted outcome per
 * R3 rule 2. Until then the poll keeps running: after any control action
 * the loop resumes automatically from the same sliding window.
 *
 * Read-only: this region never POSTs — the control verbs are T10b's ticket
 * and live in the run-detail page's server-rendered forms.
 */

/** The poll cadence (1 s per open run detail page). */
export const POLL_MS = 1000;

/** One selected phase's lazily-fetched panel data (per-phase cache). */
interface PhasePanelData {
  envelopes: EnvelopeRow[] | null;
  gates: GateResultWithOverride[] | null;
  envelopesError: boolean;
  gatesError: boolean;
}

export interface RunLiveRegionProps extends SerializableProps {
  runId: string;
  /** the R3 timeline view (per-visit segments, blueprint order) — the chart
   * and panel render from it; REPLACED by the R6 timeline.json refetch on
   * every poll while the page is open */
  timeline: SerializableTimelineView;
  /** the R5 initial selection — resolved server-side from ?phase= or
   * auto-select; null only when no phase is selectable */
  initialSelection: string | null;
  /** the initial selection's envelopes/gates, server-rendered (R5) */
  initialEnvelopes: SerializableEnvelopeRow[];
  initialGates: SerializableGateResult[];
  /** agent sessions for ALL phases (RunDetail.sessions) — the panel filters
   * to the selected phase */
  sessions: SerializableAgentSession[];
  /** the FULL event history so far (initial load or last poll merge) */
  events: FeedEvent[];
  /** the last event rowid — the cursor for the next poll */
  cursor: number;
  /** the events.json proxy href for this run (routes.runs.events.href) */
  eventsHref: string;
  /** the timeline.json proxy href for this run (routes.runs.timeline.href —
   * the R6 per-tick timeline refetch) */
  timelineHref: string;
  /** the pause viewer's reason when the run is paused at SSR (null
   * otherwise) — the panel header surfaces it; the live poll captures the
   * same value from the run_status → paused event */
  pauseReason: string | null;
}

export const RunLiveRegion = clientEntry(
  import.meta.url,
  function RunLiveRegion(handle: Handle<RunLiveRegionProps>) {
    // ── setup scope — runs once ───────────────────────────────────────────
    let events: FeedEvent[] = [...handle.props.events];
    let cursor = handle.props.cursor;
    let status: string = handle.props.timeline.status;
    let endedAt: string | null = handle.props.timeline.ended_at;
    // R6: the chart/panel timeline snapshot — REPLACED by the timeline.json
    // refetch on every poll (R5 selection stays in its own variable below, so
    // refetches never reset it)
    let timeline: TimelineView = handle.props.timeline;
    // R6 pause surfacing: the pause viewer's reason (SSR seed) or the
    // reason captured live from the run_status → paused event
    let pauseReason: string | null = handle.props.pauseReason;
    // R5: the selection survives polls because it lives here, not in props
    let selection: string | null = handle.props.initialSelection;
    let autoScroll = true;
    let hoverPaused = false;
    let feedNode: HTMLElement | null = null;
    let polling = false;
    let terminal = isTerminalStatus(status);

    // R5: the per-phase panel data cache — seeded with the server-rendered
    // initial selection; later selections are fetched lazily via the proxies
    const phaseData = new Map<string, PhasePanelData>();
    const inflight = new Set<string>();
    if (handle.props.initialSelection !== null) {
      phaseData.set(handle.props.initialSelection, {
        envelopes: handle.props.initialEnvelopes,
        gates: handle.props.initialGates,
        envelopesError: false,
        gatesError: false,
      });
    }

    /** R5 select: update the selection, mirror it in the URL (?phase= — the
     * deep link), and lazily fetch the phase's envelopes/gates when missing. */
    const select = (name: string | null): void => {
      selection = name;
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (name !== null) url.searchParams.set("phase", name);
        else url.searchParams.delete("phase");
        window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      }
      if (name !== null) {
        const existing = phaseData.get(name);
        if (existing === undefined) {
          phaseData.set(name, { envelopes: null, gates: null, envelopesError: false, gatesError: false });
        }
        const data = phaseData.get(name)!;
        // (re)fetch when anything is still missing — also retries after an
        // earlier fetch failed
        if (data.envelopes === null || data.gates === null) void loadPhaseData(name);
      }
      void handle.update();
    };

    /** R5 lazy fetch: the envelopes.json / gates.json proxies (the browser
     * never talks to the daemon). */
    const loadPhaseData = async (name: string): Promise<void> => {
      if (inflight.has(name)) return; // a slow round-trip must not stack
      inflight.add(name);
      try {
        const runId = handle.props.runId;
        const [envRes, gatesRes] = await Promise.all([
          fetch(routes.runs.phases.envelopes.href({ runId, phase: name })),
          fetch(routes.runs.phases.gates.href({ runId, phase: name })),
        ]);
        const env: PhaseEnvelopes | null = envRes.ok ? ((await envRes.json()) as PhaseEnvelopes) : null;
        const gates: PhaseGates | null = gatesRes.ok ? ((await gatesRes.json()) as PhaseGates) : null;
        phaseData.set(name, {
          envelopes: env !== null ? env.envelopes : null,
          gates: gates !== null ? gates.gates : null,
          envelopesError: !envRes.ok,
          gatesError: !gatesRes.ok,
        });
      } catch {
        // transient failure — the panel shows the error state; selecting the
        // phase again retries
        phaseData.set(name, { envelopes: null, gates: null, envelopesError: true, gatesError: true });
      } finally {
        inflight.delete(name);
        if (selection === name) void handle.update();
      }
    };

    const poll = async (): Promise<void> => {
      if (polling) return; // a slow round-trip must not stack polls
      polling = true;
      try {
        const eventsUrl = new URL(handle.props.eventsHref, window.location.href);
        eventsUrl.searchParams.set("cursor", String(cursor));
        const timelineUrl = new URL(handle.props.timelineHref, window.location.href);
        // R6: the timeline refetch rides the SAME poll tick as the events
        // page — one round-trip, both fetches in flight. A 404 on either
        // proxy = the run is gone → stop polling; any other failure is
        // transient — keep the last snapshot and retry on the next tick.
        const [eventsResponse, timelineResponse] = await Promise.all([fetch(eventsUrl), fetch(timelineUrl)]);
        if (eventsResponse.status === 404 || timelineResponse.status === 404) {
          stopPolling();
          return;
        }
        if (!eventsResponse.ok || !timelineResponse.ok) return; // transient
        const page = (await eventsResponse.json()) as { events: FeedEvent[]; next_cursor: number };
        const view = (await timelineResponse.json()) as TimelineView;
        if (page.events.length > 0) {
          events = [...events, ...page.events];
          cursor = page.next_cursor;
        } else {
          cursor = page.next_cursor; // idempotent at the tail
        }
        // keep the run status + timeline live from run_status events — a
        // TERMINAL transition (success/failed) freezes the timeline at the
        // run_status moment, drops the now-cursor, and stops the poll
        // (polish, T10b — the timeline's live edges derive from these)
        for (const ev of page.events) {
          if (ev.type === "run_status") {
            const data = (ev.data ?? {}) as { to?: unknown; reason?: unknown };
            const to = data.to;
            if (typeof to === "string" && isTrackedStatus(to)) {
              status = to;
              if (to === "success" || to === "failed") {
                endedAt = ev.ts;
                terminal = true;
                stopPolling();
              }
              // R6 pause surfacing: the run_status → paused event carries the
              // pause reason (pauseAt writes `reason: pause.reason` — the same
              // value the pause viewer reports), so the panel header can
              // surface it LIVE with no extra proxy. Cleared on any other
              // transition; the panel only renders it while the live status
              // is paused anyway.
              pauseReason = to === "paused" && typeof data.reason === "string" && data.reason !== "" ? data.reason : null;
            }
          }
        }
        // R6: replace the chart/panel snapshot with the fresh R3 view — the
        // open bubble extends to now, new segments appear, closed visits
        // finalize, all between refreshes, with NO re-sort (blueprint order
        // is fixed server-side). A terminal view (the run finished between
        // polls) freezes the poll exactly like the terminal event does.
        timeline = view;
        if (view.status === "success" || view.status === "failed") {
          status = view.status;
          endedAt = view.ended_at;
          terminal = true;
          stopPolling();
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
    // it when window exists AND the run is not already terminal. The abort
    // listener mirrors that.
    if (typeof window !== "undefined" && !terminal) {
      timer = setInterval(() => void poll(), POLL_MS);
      handle.signal.addEventListener("abort", () => stopPolling());
    }

    return () => {
      const { runId, sessions } = handle.props;
      const now = Date.now();
      // the chart's live edges: the run_status events polled in advance the
      // ended_at/status the model reads (T10b terminal freeze, now cursor);
      // the snapshot itself is the R6-refetched timeline (new segments +
      // fresh status/ended_at arrive with each poll)
      const liveTimeline: TimelineView = { ...timeline, status: status as TimelineView["status"], ended_at: endedAt };
      const model = computeTimelineLayout(liveTimeline, now);
      const data = selection !== null ? phaseData.get(selection) : undefined;

      return (
        <div mix={regionStyle}>
          <Timeline model={model} runId={runId} selected={selection} onSelect={select} />
          <TimelinePanel
            runId={runId}
            timeline={liveTimeline}
            selected={selection}
            sessions={sessions}
            envelopes={data?.envelopes ?? null}
            gates={data?.gates ?? null}
            envelopesError={data?.envelopesError ?? false}
            gatesError={data?.gatesError ?? false}
            pauseReason={pauseReason}
          />
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

/** The statuses the live loop tracks from run_status events. Interrupted is
 * tracked too (NOT terminal — the run awaits a human resume, so the poll
 * keeps running and open segments render interrupted per R3 rule 2); only
 * success/failed freeze the poll. */
function isTrackedStatus(value: string): boolean {
  return value === "running" || value === "paused" || value === "interrupted" || value === "success" || value === "failed";
}

/** A terminal status — the timeline freezes + the poll stops. */
function isTerminalStatus(value: string): boolean {
  return value === "success" || value === "failed";
}
