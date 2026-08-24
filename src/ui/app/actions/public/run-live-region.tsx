import { clientEntry, css, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../../../daemon/db.ts";
import type { PhaseEnvelopes, PhaseGates, RawTail, TimelineView } from "../../../../daemon/contract.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../lib/phase-data.ts";
import { routes } from "../../routes.ts";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import { EventFeed } from "../../ui/public/event-feed.tsx";
import { createCoalescedNotifier, subscribeSse, type SseSubscription } from "./sse.ts";
import { computeTimelineLayout } from "../../ui/public/timeline-model.ts";
import { Timeline } from "../../ui/public/timeline.tsx";
import { TimelinePanel } from "../../ui/public/timeline-panel.tsx";
import { RawTranscript } from "../../ui/public/raw-transcript.tsx";

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
/** #41: the four #35 card surfaces + the RAW tail, widened at the client-entry
 * boundary (plain JSON — structural widening only). */
export type SerializablePhaseSnapshot = PhaseSnapshotData & SerializableObject;
export type SerializablePhaseInputs = PhaseInputsData & SerializableObject;
export type SerializablePhaseOutputs = PhaseOutputsData & SerializableObject;
export type SerializablePhaseSpend = PhaseSpendData & SerializableObject;
export type SerializableRawTail = RawTail & SerializableObject;

/**
 * The run-detail LIVE region (R4/R5): the hydrated clientEntry
 * that owns the timeline chart + the R5 detail panel + the live feed.
 * Server-rendered once with the initial snapshot (the R3 TimelineView — the
 * chart renders from it at SSR — plus the full event history; the cursor
 * query IS the read transport), then the browser SUBSCRIBES to the
 * run-scoped SSE change stream (`GET /runs/:runId/events.sse`) while the page
 * is open and refetches `GET /runs/:runId/events.json?cursor=N` on every
 * `change` wake-up, keeping `next_cursor` in setup scope. Each refetch merges
 * the new events (the same sliding-window cursor merge as the old poll),
 * re-renders the feed, and recomputes the timeline's live edges (the now
 * cursor + open-segment ends) from the same events — push-instant instead of
 * up to ~1s stale, with the same semantics.
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
 * R6 live behavior: each refetch fetches events.json AND timeline.json in
 * parallel; the fresh R3 TimelineView replaces the setup-scope snapshot the
 * chart + panel render from (open bubbles extend to now, new segments appear
 * between refreshes, row order stays fixed — blueprint order is server-side).
 * A transient timeline fetch failure keeps the last snapshot and schedules ONE
 * delayed retry ~1s later (same tolerance as the events fetch, without a poll
 * loop); a 404 on either proxy means the run is gone and stops the live
 * subscription. The paused treatment (striped active
 * bubble) comes from the tracked run status; the pause reason travels in the
 * run_status → paused event the poll already receives (pauseAt writes
 * `reason: pause.reason` — the same value the pause viewer reports), so
 * the panel header can surface it live with no extra proxy. The timeline
 * refetch never touches the R5 selection — it lives in a separate setup-scope
 * variable.
 *
 * Terminal transition (polish, T10b): a run that completes while the page is
 * open (a run_status → success/failed event arrives through a refetch) freezes
 * the timeline — its right edge becomes the run_status moment, the now-cursor
 * disappears (both derived from the live ended_at/status in the layout) — and
 * the SSE subscription stops (a terminal run emits no more events; the feed is
 * final). Interrupted is NOT terminal — the run awaits a human resume, so the
 * subscription keeps running; open segments render with the interrupted
 * outcome per R3 rule 2. Until then the subscription stays open: after any
 * control action new change frames resume refetches from the same sliding
 * window.
 *
 * Read-only: this region never POSTs — the control verbs are T10b's ticket
 * and live in the run-detail page's server-rendered forms.
 */

/** The one-shot retry delay after a transient refetch failure (ms) — the old
 * "retry next tick" tolerance, now a single setTimeout with no poll loop. */
const RETRY_MS = 1000;

/** One selected phase's lazily-fetched card data (per-phase cache). #41 folded
 * the drill-in surfaces in, so a selection now caches the full card record:
 * envelopes/gates PLUS the four #35 proxies (snapshot/inputs/outputs/spend).
 * `null` = still loading; the matching *Error flag = the fetch failed (the card
 * shows its error/loading state). */
interface PhasePanelData {
  envelopes: EnvelopeRow[] | null;
  gates: GateResultWithOverride[] | null;
  snapshot: PhaseSnapshotData | null;
  inputs: PhaseInputsData | null;
  outputs: PhaseOutputsData | null;
  spend: PhaseSpendData | null;
  envelopesError: boolean;
  gatesError: boolean;
  snapshotError: boolean;
  inputsError: boolean;
  outputsError: boolean;
  spendError: boolean;
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
  /** the initial selection's #35 card surfaces, server-rendered (#41); null
   * only when no phase is selectable */
  initialSnapshot: SerializablePhaseSnapshot | null;
  initialInputs: SerializablePhaseInputs | null;
  initialOutputs: SerializablePhaseOutputs | null;
  initialSpend: SerializablePhaseSpend | null;
  /** the run-scoped RAW TRANSCRIPT tail, server-rendered (#41); refetched on
   * every SSE change wake-up */
  initialRaw: SerializableRawTail;
  /** the raw.json proxy href for this run (routes.runs.raw.href) — the RAW
   * TRANSCRIPT refetch target */
  rawHref: string;
  /** agent sessions for ALL phases (RunDetail.sessions) — the panel filters
   * to the selected phase */
  sessions: SerializableAgentSession[];
  /** the FULL event history so far (initial load or last poll merge) */
  events: FeedEvent[];
  /** the last event rowid — the cursor for the next poll */
  cursor: number;
  /** the events.json proxy href for this run (routes.runs.events.href) */
  eventsHref: string;
  /** the run-scoped SSE change stream href (routes.runs.live.href) — the live
   * region subscribes to it and refetches events.json + timeline.json on each
   * change wake-up (replaces the old ~1s poll) */
  liveHref: string;
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
    // #41: the run-scoped RAW TRANSCRIPT tail — SSR seed, then refetched on
    // every SSE change wake-up (the ONLY per-signal card refetch; the phase
    // cards load on selection, not per-signal — #38 kept that out of scope)
    let raw: RawTail = handle.props.initialRaw;
    let rawInflight = false;
    // R5: the selection survives polls because it lives here, not in props
    let selection: string | null = handle.props.initialSelection;
    let autoScroll = true;
    let hoverPaused = false;
    let feedNode: HTMLElement | null = null;
    let polling = false;
    let terminal = isTerminalStatus(status);
    // the run-scoped SSE subscription (armed below when window exists and the
    // run is not already terminal) and the single pending one-shot retry timer
    let subscription: SseSubscription | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    // R5: the per-phase panel data cache — seeded with the server-rendered
    // initial selection; later selections are fetched lazily via the proxies
    const phaseData = new Map<string, PhasePanelData>();
    const inflight = new Set<string>();
    if (handle.props.initialSelection !== null) {
      phaseData.set(handle.props.initialSelection, {
        envelopes: handle.props.initialEnvelopes,
        gates: handle.props.initialGates,
        snapshot: handle.props.initialSnapshot,
        inputs: handle.props.initialInputs,
        outputs: handle.props.initialOutputs,
        spend: handle.props.initialSpend,
        envelopesError: false,
        gatesError: false,
        snapshotError: false,
        inputsError: false,
        outputsError: false,
        spendError: false,
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
          phaseData.set(name, emptyPhaseData());
        }
        const data = phaseData.get(name)!;
        // (re)fetch when ANY surface is still missing — also retries after an
        // earlier fetch failed
        if (
          data.envelopes === null ||
          data.gates === null ||
          data.snapshot === null ||
          data.inputs === null ||
          data.outputs === null ||
          data.spend === null
        ) {
          void loadPhaseData(name);
        }
      }
      void handle.update();
    };

    /** #41 lazy fetch: a selected phase's full card record through the six
     * phase proxies (envelopes/gates + the four #35 surfaces). The browser
     * never talks to the daemon. Same inflight dedup + per-surface error state
     * as the old envelopes/gates fetch. */
    const loadPhaseData = async (name: string): Promise<void> => {
      if (inflight.has(name)) return; // a slow round-trip must not stack
      inflight.add(name);
      try {
        const runId = handle.props.runId;
        const [envRes, gatesRes, snapRes, inRes, outRes, spendRes] = await Promise.all([
          fetch(routes.runs.phases.envelopes.href({ runId, phase: name })),
          fetch(routes.runs.phases.gates.href({ runId, phase: name })),
          fetch(routes.runs.phases.snapshot.href({ runId, phase: name })),
          fetch(routes.runs.phases.inputs.href({ runId, phase: name })),
          fetch(routes.runs.phases.outputs.href({ runId, phase: name })),
          fetch(routes.runs.phases.spend.href({ runId, phase: name })),
        ]);
        const env: PhaseEnvelopes | null = envRes.ok ? ((await envRes.json()) as PhaseEnvelopes) : null;
        const gates: PhaseGates | null = gatesRes.ok ? ((await gatesRes.json()) as PhaseGates) : null;
        phaseData.set(name, {
          envelopes: env !== null ? env.envelopes : null,
          gates: gates !== null ? gates.gates : null,
          snapshot: snapRes.ok ? ((await snapRes.json()) as PhaseSnapshotData) : null,
          inputs: inRes.ok ? ((await inRes.json()) as PhaseInputsData) : null,
          outputs: outRes.ok ? ((await outRes.json()) as PhaseOutputsData) : null,
          spend: spendRes.ok ? ((await spendRes.json()) as PhaseSpendData) : null,
          envelopesError: !envRes.ok,
          gatesError: !gatesRes.ok,
          snapshotError: !snapRes.ok,
          inputsError: !inRes.ok,
          outputsError: !outRes.ok,
          spendError: !spendRes.ok,
        });
      } catch {
        // transient failure — the cards show their error state; selecting the
        // phase again retries
        phaseData.set(name, {
          envelopes: null,
          gates: null,
          snapshot: null,
          inputs: null,
          outputs: null,
          spend: null,
          envelopesError: true,
          gatesError: true,
          snapshotError: true,
          inputsError: true,
          outputsError: true,
          spendError: true,
        });
      } finally {
        inflight.delete(name);
        if (selection === name) void handle.update();
      }
    };

    /** #41: refetch the run-scoped RAW TRANSCRIPT tail on the SSE signal. A
     * failure keeps the last tail (best-effort) and never disturbs the
     * events/timeline refetch path (#38 semantics unchanged). */
    const refreshRaw = async (): Promise<void> => {
      if (rawInflight || typeof window === "undefined") return;
      rawInflight = true;
      try {
        const res = await fetch(new URL(handle.props.rawHref, window.location.href));
        if (res.ok) {
          raw = (await res.json()) as RawTail;
          await handle.update();
        }
      } catch {
        // keep the last tail
      } finally {
        rawInflight = false;
      }
    };

    const poll = async (): Promise<void> => {
      if (polling) return; // a slow round-trip must not stack refetches
      polling = true;
      try {
        const eventsUrl = new URL(handle.props.eventsHref, window.location.href);
        eventsUrl.searchParams.set("cursor", String(cursor));
        const timelineUrl = new URL(handle.props.timelineHref, window.location.href);
        // R6: the timeline refetch rides the SAME refetch as the events page —
        // one round-trip, both fetches in flight. A 404 on either proxy = the
        // run is gone → stop the live subscription; any other failure is
        // transient — keep the last snapshot and schedule ONE delayed retry.
        const [eventsResponse, timelineResponse] = await Promise.all([fetch(eventsUrl), fetch(timelineUrl)]);
        if (eventsResponse.status === 404 || timelineResponse.status === 404) {
          stopLive();
          return;
        }
        if (!eventsResponse.ok || !timelineResponse.ok) {
          scheduleRetry(); // transient — one delayed retry, not a poll loop
          return;
        }
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
                stopLive();
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
        // refetches) freezes the subscription exactly like the terminal event
        // does.
        timeline = view;
        if (view.status === "success" || view.status === "failed") {
          status = view.status;
          endedAt = view.ended_at;
          terminal = true;
          stopLive();
        }
        await handle.update();
        if (autoScroll && !hoverPaused && feedNode) {
          feedNode.scrollTop = feedNode.scrollHeight;
        }
      } catch {
        // transient fetch/parse throw — schedule one delayed retry
        scheduleRetry();
      } finally {
        polling = false;
      }
    };

    // Transient-failure tolerance without a poll: a non-404 failure or a
    // fetch/parse throw schedules EXACTLY ONE retry ~1s later. The guard keeps
    // it one-shot (no stacking) rather than a setInterval loop; a terminal run
    // never retries. A retry that fails again reschedules the same single
    // timer — the old "retry next tick" tolerance, so a blip never stalls.
    const scheduleRetry = (): void => {
      if (terminal || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void poll();
      }, RETRY_MS);
    };

    // stopLive: tear down the SSE subscription AND clear the pending one-shot
    // retry — the terminal freeze, a 404 run-gone, and the abort listener all
    // route through here.
    const stopLive = (): void => {
      if (subscription !== null) {
        subscription.unsubscribe();
        subscription = null;
      }
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    // Setup ALSO runs server-side during SSR (clientEntry components render
    // like any other component) — the live subscription is browser-only, so
    // only arm it when window exists AND the run is not already terminal. The
    // abort listener mirrors that.
    if (typeof window !== "undefined" && !terminal) {
      // Wake-ups drive poll() through createCoalescedNotifier (#33): a change
      // frame that lands while a poll is in flight schedules EXACTLY ONE
      // trailing rerun instead of being dropped by poll's own `polling` guard.
      // This is the backstop the old setInterval provided — without it the
      // LAST frame (terminal run_status) landing mid-poll would be lost, the
      // freeze would never happen, and the EventSource would leak on a done
      // run. poll's `polling` guard stays as belt-and-suspenders.
      // #41: each change wake-up drives the events/timeline refetch (poll, #38
      // semantics unchanged) AND the run-scoped RAW TRANSCRIPT refetch. The
      // per-phase cards are NOT refetched here — they load on selection only.
      const notify = createCoalescedNotifier(() => Promise.all([poll(), refreshRaw()]).then(() => undefined));
      subscription = subscribeSse(handle.props.liveHref, { onchange: notify });
      handle.signal.addEventListener("abort", () => stopLive());
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
            snapshot={data?.snapshot ?? null}
            inputs={data?.inputs ?? null}
            outputs={data?.outputs ?? null}
            spend={data?.spend ?? null}
            envelopesError={data?.envelopesError ?? false}
            gatesError={data?.gatesError ?? false}
            snapshotError={data?.snapshotError ?? false}
            inputsError={data?.inputsError ?? false}
            outputsError={data?.outputsError ?? false}
            spendError={data?.spendError ?? false}
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
          {/* #41: the run-scoped RAW TRANSCRIPT — collapsed, SSR-seeded, and
          refetched on every SSE change wake-up (below the feed) */}
          <RawTranscript raw={raw} />
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

/** A fresh, all-loading per-phase card cache entry (#41). */
function emptyPhaseData(): PhasePanelData {
  return {
    envelopes: null,
    gates: null,
    snapshot: null,
    inputs: null,
    outputs: null,
    spend: null,
    envelopesError: false,
    gatesError: false,
    snapshotError: false,
    inputsError: false,
    outputsError: false,
    spendError: false,
  };
}
