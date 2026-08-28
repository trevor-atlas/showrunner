import { clientEntry, css, on, type Handle, type SerializableObject, type SerializableProps } from "remix/ui";

import type { AgentSessionRow, EnvelopeRow, GateResultWithOverride } from "../../repository/db.ts";
import type { PhaseEnvelopes, PhaseGates, RawTail, TimelineView, TrajectoryView } from "../../contract.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../lib/phase-data.ts";
import { routes } from "../../routes.ts";
import type { FeedEvent } from "../../ui/public/event-feed.tsx";
import { EventFeed } from "../../ui/public/event-feed.tsx";
import { startLiveSnapshot, type LiveApplyOutcome } from "./live-snapshot.ts";
import { computeTimelineLayout } from "../../ui/public/timeline-model.ts";
import { Timeline } from "../../ui/public/timeline.tsx";
import { TimelinePanel } from "../../ui/public/timeline-panel.tsx";
import { RawTranscript } from "../../ui/public/raw-transcript.tsx";
import { TrajectoryPanel } from "../../ui/public/trajectory/trajectory-panel.tsx";

/**
 * The client-entry boundary widens the server wire types (client.ts/db.ts)
 * with the SerializableProps index signature. The values are plain JSON — the
 * serialization at the entry boundary is exactly what the API returns —
 * so the widened types are structural only; the intersection documents that
 * these props ARE serializable (the same `as unknown as` widening the
 * server-side client uses at the server boundary).
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
/** #84: the initial selection's parsed trajectory, widened at the client-entry
 * boundary (plain JSON — structural widening only). */
export type SerializableTrajectoryView = TrajectoryView & SerializableObject;

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
 * (the browser never talks to the server — the iron convention); the initial
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

/** #84: one phase's lazily-fetched trajectory (per-phase cache). `view` null
 * with `error` false = still loading; `error` true = the fetch failed (the
 * panel shows its error state; re-selecting the phase retries). */
interface TrajectoryCacheEntry {
  view: TrajectoryView | null;
  error: boolean;
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
  /** #84: the initial selection's parsed trajectory, server-rendered so the
   * Trajectory tab paints with no round-trip on first open; null when no
   * phase is selectable. Later selections fetch through the trajectory proxy
   * and are cached per phase (the same lazy-fetch pattern as the phase cards). */
  initialTrajectory: SerializableTrajectoryView | null;
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
    // R5: the selection survives polls because it lives here, not in props
    let selection: string | null = handle.props.initialSelection;
    // #82: the run-page view tab (Main | Trajectory). Held here in setup scope
    // so it survives SSE refetches — a change wake-up's apply() never touches it.
    let activeTab: "main" | "trajectory" = "main";
    let autoScroll = true;
    let hoverPaused = false;
    let feedNode: HTMLElement | null = null;
    // whether the run was ALREADY terminal at SSR — the live transport is only
    // armed for a still-running run (the adapter owns the terminal freeze once
    // it IS armed).
    const terminalAtSetup = isTerminalStatus(status);

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

    // #84: the per-phase TRAJECTORY cache — same lazy-fetch shape as phaseData,
    // seeded with the SSR-rendered initial selection so the Trajectory tab
    // paints without a round-trip. `view` null + no error = still loading.
    const trajectory = new Map<string, TrajectoryCacheEntry>();
    const trajInflight = new Set<string>();
    if (handle.props.initialSelection !== null && handle.props.initialTrajectory !== null) {
      trajectory.set(handle.props.initialSelection, { view: handle.props.initialTrajectory, error: false });
    }

    /** #84 lazy fetch: a selected phase's trajectory through the trajectory
     * proxy (the browser never talks to the server). Inflight dedup + an error
     * flag mirror loadPhaseData; re-selecting a cached phase never refetches. */
    const loadTrajectory = async (name: string): Promise<void> => {
      if (trajInflight.has(name)) return;
      trajInflight.add(name);
      try {
        const res = await fetch(routes.runs.phases.trajectory.href({ runId: handle.props.runId, phase: name }));
        trajectory.set(
          name,
          res.ok ? { view: (await res.json()) as TrajectoryView, error: false } : { view: null, error: true },
        );
      } catch {
        trajectory.set(name, { view: null, error: true });
      } finally {
        trajInflight.delete(name);
        if (selection === name) void handle.update();
      }
    };

    /** #84: load the selected phase's trajectory when the Trajectory tab needs
     * it — missing from the cache (never fetched, or a prior fetch failed). */
    const ensureTrajectory = (name: string): void => {
      const cached = trajectory.get(name);
      if (cached === undefined || cached.error) void loadTrajectory(name);
    };

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
        // #84: on the Trajectory tab, a phase-select also loads that phase's
        // trajectory (the Main tab loads it lazily on tab-switch instead)
        if (activeTab === "trajectory") ensureTrajectory(name);
      }
      void handle.update();
    };

    /** #41 lazy fetch: a selected phase's full card record through the six
     * phase proxies (envelopes/gates + the four #35 surfaces). The browser
     * never talks to the server. Same inflight dedup + per-surface error state
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

    /** #41: best-effort refetch of the run-scoped RAW TRANSCRIPT tail, folded
     * into the parallel `apply` round-trip. Never throws — a failure keeps the
     * last tail (returns null) so it never turns the events/timeline refetch
     * into a retry (#38 semantics unchanged). */
    const fetchRawTail = async (): Promise<RawTail | null> => {
      try {
        const res = await fetch(new URL(handle.props.rawHref, window.location.href));
        if (res.ok) return (await res.json()) as RawTail;
      } catch {
        // keep the last tail
      }
      return null;
    };

    /** #88: best-effort refetch of the SELECTED phase's trajectory, folded into
     * the parallel `apply` round-trip. Mirrors fetchRawTail — never throws, so
     * a failure keeps the last good view (returns null) and never turns the
     * events/timeline refetch into a retry. Only called while the Trajectory
     * tab is open on a non-terminal run (a terminal run freezes it). */
    const fetchTrajectory = async (name: string): Promise<TrajectoryView | null> => {
      try {
        const res = await fetch(routes.runs.phases.trajectory.href({ runId: handle.props.runId, phase: name }));
        if (res.ok) return (await res.json()) as TrajectoryView;
      } catch {
        // keep the last good view
      }
      return null;
    };

    /** The adapter's refetch (#58): one round-trip that fetches events.json +
     * timeline.json + the RAW tail in PARALLEL, merges the cursor, and updates
     * the render state — then returns the outcome the adapter acts on:
     *   - "stopped": a 404 on either proxy (the run is gone) OR a terminal
     *     transition (run_status → success/failed, or a terminal timeline
     *     view) — the adapter tears the stream down (the T10b freeze);
     *   - "retry": a transient non-404 failure — the adapter arms ONE delayed
     *     retry (a fetch/parse throw propagates and the adapter treats it the
     *     same way);
     *   - "applied": otherwise — keep listening.
     * The cursor merge + render state stay HERE; the adapter owns only WHEN. */
    const apply = async (): Promise<LiveApplyOutcome> => {
      const eventsUrl = new URL(handle.props.eventsHref, window.location.href);
      eventsUrl.searchParams.set("cursor", String(cursor));
      const timelineUrl = new URL(handle.props.timelineHref, window.location.href);
      // #88: while the Trajectory tab is open on a non-terminal run, the
      // selected phase's trajectory rides the SAME round-trip. Best-effort and
      // isolated — like the RAW tail, it never throws, so only events/timeline
      // decide the outcome; a terminal run or the Main tab skips it entirely.
      const trajTarget =
        activeTab === "trajectory" && selection !== null && !isTerminalStatus(status) ? selection : null;
      // R6: the events page, the timeline, and the RAW tail ride the SAME
      // round-trip — all in flight. The RAW + trajectory fetches are
      // best-effort and never throw, so only events/timeline decide the outcome.
      const [eventsResponse, timelineResponse, rawTail, trajView] = await Promise.all([
        fetch(eventsUrl),
        fetch(timelineUrl),
        fetchRawTail(),
        trajTarget !== null ? fetchTrajectory(trajTarget) : Promise.resolve(null),
      ]);
      // a 404 on either proxy = the run is gone → stop the live subscription
      if (eventsResponse.status === 404 || timelineResponse.status === 404) {
        return "stopped";
      }
      // any other failure is transient — keep the last snapshot, arm one retry
      if (!eventsResponse.ok || !timelineResponse.ok) {
        return "retry";
      }
      const page = (await eventsResponse.json()) as { events: FeedEvent[]; next_cursor: number };
      const view = (await timelineResponse.json()) as TimelineView;
      if (page.events.length > 0) {
        events = [...events, ...page.events];
      }
      cursor = page.next_cursor; // idempotent at the tail
      // keep the run status + timeline live from run_status events — a
      // TERMINAL transition (success/failed) freezes the timeline at the
      // run_status moment, drops the now-cursor, and stops the stream
      // (polish, T10b — the timeline's live edges derive from these)
      let reachedTerminal = false;
      for (const ev of page.events) {
        if (ev.type === "run_status") {
          const data = (ev.data ?? {}) as { to?: unknown; reason?: unknown };
          const to = data.to;
          if (typeof to === "string" && isTrackedStatus(to)) {
            status = to;
            if (to === "success" || to === "failed") {
              endedAt = ev.ts;
              reachedTerminal = true;
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
        reachedTerminal = true;
      }
      // fold in the best-effort RAW tail before the single re-render
      if (rawTail !== null) raw = rawTail;
      // #88: replace the selected phase's trajectory wholesale (like timeline);
      // a failed fetch (null) keeps the last good view.
      if (trajTarget !== null && trajView !== null) trajectory.set(trajTarget, { view: trajView, error: false });
      await handle.update();
      if (autoScroll && !hoverPaused && feedNode) {
        feedNode.scrollTop = feedNode.scrollHeight;
      }
      return reachedTerminal ? "stopped" : "applied";
    };

    // Setup ALSO runs server-side during SSR (clientEntry components render
    // like any other component) — the live transport is browser-only, so only
    // arm it when window exists AND the run is not already terminal. The
    // adapter owns the SSE subscription, the coalescing + in-flight guard, the
    // one-shot retry, and the terminal/gone freeze; the region hands it the
    // run-scoped change-stream href + the `apply` refetch and tears it down on
    // abort.
    if (typeof window !== "undefined" && !terminalAtSetup) {
      const live = startLiveSnapshot({ href: handle.props.liveHref, apply });
      handle.signal.addEventListener("abort", () => live.stop());
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

      // the live feed + raw transcript ride in the panel's LEFT column (under
      // ENVELOPE) so the running log sits beside the accepted-envelope
      // narrative; the interactive state (autoScroll, hover, the scroll node)
      // still lives here in setup scope and is threaded through the callbacks.
      const feedSlot = (
        <>
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
        </>
      );

      const selectTab = (tab: "main" | "trajectory") => {
        activeTab = tab;
        // #84: opening the Trajectory tab loads the selected phase's trajectory
        // if it is not already cached (the SSR-seeded initial phase already is)
        if (tab === "trajectory" && selection !== null) ensureTrajectory(selection);
        void handle.update();
      };

      // #84: the resolved trajectory state for the selected phase — a view,
      // loading (selection set, nothing resolved yet), or an error message
      const trajEntry = selection !== null ? trajectory.get(selection) : undefined;
      const trajView = trajEntry?.view ?? null;
      const trajError = trajEntry?.error === true ? "couldn't load trajectory" : null;
      const trajLoading = selection !== null && trajView === null && trajError === null;

      return (
        <div mix={regionStyle}>
          <Timeline model={model} runId={runId} selected={selection} onSelect={select} />
          <div role="tablist" aria-label="run view" mix={tabBarStyle}>
            <button
              type="button"
              role="tab"
              data-tab="main"
              aria-selected={activeTab === "main"}
              mix={[tabStyle, on("click", () => selectTab("main"))]}
            >
              Main
            </button>
            <button
              type="button"
              role="tab"
              data-tab="trajectory"
              aria-selected={activeTab === "trajectory"}
              mix={[tabStyle, on("click", () => selectTab("trajectory"))]}
            >
              Trajectory
            </button>
          </div>
          {activeTab === "trajectory" ? (
            <TrajectoryPanel view={trajView} loading={trajLoading} error={trajError} />
          ) : (
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
            feedSlot={feedSlot}
          />
          )}
        </div>
      );
    };
  },
);

const regionStyle = css({
  display: "grid",
  gap: "1.25rem",
});

const tabBarStyle = css({
  display: "flex",
  gap: "0.25rem",
  borderBottom: "1px solid var(--border)",
});

const tabStyle = css({
  appearance: "none",
  font: "inherit",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
  padding: "0.4rem 0.9rem",
  border: "none",
  borderBottom: "2px solid transparent",
  background: "transparent",
  color: "var(--muted-foreground)",
  cursor: "pointer",
  "&[aria-selected='true']": {
    color: "var(--foreground)",
    borderBottomColor: "var(--foreground)",
  },
  "&:hover": {
    color: "var(--foreground)",
  },
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
