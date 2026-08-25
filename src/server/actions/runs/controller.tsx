import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { parseSafe } from "remix/data-schema";

import type { EnvelopeRow, GateResultWithOverride } from "../../repository/db.ts";

import {
  MAX_EVENTS_LIMIT,
  controlApprove,
  controlFail,
  controlResume,
  controlSteer,
  getPhaseEnvelopes,
  getPhaseGates,
  getPhaseRecord,
  getPause,
  getRaw,
  getRunDetail,
  getRunEvents,
  getTimeline,
  isApiError,
} from "../../lib/model.ts";
import type {
  PhaseInputsData,
  PhaseOutputsData,
  PhaseSnapshotData,
  PhaseSpendData,
} from "../../lib/phase-data.ts";
import { subscribeRun } from "../../transport/change-bus.ts";
import { createSseResponse, heartbeatOverrideMs } from "../../lib/sse.ts";
import { routes } from "../../routes.ts";
import type { ControlError } from "../../ui/pause-menu.tsx";
import { apiControlError, steerFormSchema, validationError } from "./control-forms.ts";
import { resolveInitialSelection } from "../../ui/public/timeline-model.ts";
import { NotFoundPage, RunDetailPage } from "./run-detail-page.tsx";

/**
 * Run-detail group (T10a + T10b, issues #15/#20): `/runs/:runId`, the
 * events.json cursor proxy, and the control verbs — the pause menu's
 * steer / approve / fail and the resume HEADER action.
 *
 * `show` fetches the detail endpoint SERVER-SIDE with the FULL event
 * history riding it (?full=1 — the SSR sweep lives in the api core, not
 * here) and — when the run is paused — the pause viewer (kind/phase/
 * actions/queued steers + the override target gates). The browser then
 * polls the proxy from the hydrated live region; it NEVER talks to the
 * server.
 *
 * The control actions: each validates its form with data-schema (no
 * zod in the UI), posts to the api core in-process, then REDIRECTS
 * (303) to the fresh run detail page on success — the re-render comes from
 * server state, never from a client-side flip. A validation failure or a
 * server 409/4xx re-renders the page with the error on the form that
 * submitted it (no silent drop).
 *
 * `events` is the proxy: GET /runs/:id/events?cursor=N through the api
 * core in-process, returned as JSON { events, next_cursor }.
 *
 * Missing run → 404 (HTML for the page, JSON for the proxy). A control 409/
 * 4xx re-renders the page with the error on the form that submitted it.
 */
export default createController(routes.runs, {
  actions: {
    async show(context) {
      return renderRunDetail(context, context.params.runId);
    },

    /** steer — POST /runs/:runId/steer → server POST /runs/:id/steer. */
    async steer(context) {
      const runId = context.params.runId;
      const formData = await context.request.formData();
      const parsed = parseSafe(steerFormSchema, formData);
      if (!parsed.success) {
        return renderRunDetail(context, runId, validationError("steer", parsed.issues), 400);
      }
      try {
        await controlSteer(runId, parsed.value.message);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("steer", err), 400);
        }
        throw err;
      }
      // success: the server audited + queued the steer; the poll loop resumes
      // automatically on the re-rendered page (no optimistic mutation)
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** resume — POST /runs/:runId/resume → server POST /runs/:id/resume. */
    async resume(context) {
      const runId = context.params.runId;
      try {
        await controlResume(runId);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("resume", err), 400);
        }
        throw err;
      }
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** fail — POST /runs/:runId/fail → server POST /runs/:id/fail. */
    async fail(context) {
      const runId = context.params.runId;
      try {
        await controlFail(runId);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("fail", err), 400);
        }
        throw err;
      }
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** approve — POST /runs/:runId/approve → server POST /runs/:id/approve. */
    async approve(context) {
      const runId = context.params.runId;
      try {
        await controlApprove(runId);
      } catch (err) {
        if (isApiError(err)) {
          return renderRunDetail(context, runId, apiControlError("approve", err), 400);
        }
        throw err;
      }
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** raw — GET /runs/:runId/raw.json: the run-scoped raw_output.jsonl tail
     * (issue #41). Mirrors `events`/`timeline` (same run-gone 404): the RAW
     * TRANSCRIPT section SSR-seeds from renderRunDetail's getRaw and refetches
     * this on every SSE change wake-up. Default 200 lines (apiRaw's default,
     * capped 5000); the browser never talks to the server directly. */
    async raw(context) {
      const runId = context.params.runId;
      try {
        const tail = await getRaw(runId, { lines: RAW_TAIL_LINES });
        return Response.json(tail);
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }
    },

    async events(context) {
      const runId = context.params.runId;
      const raw = context.url.searchParams.get("cursor");
      const cursor = parseCursor(raw);

      try {
        const page = await getRunEvents(runId, { cursor, limit: MAX_EVENTS_LIMIT });
        return Response.json({ events: page.events, next_cursor: page.next_cursor });
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }
    },

    /** R6: the timeline.json refetch proxy — GET /runs/:id/timeline.json
     * through the api core in-process, returned as the R3 TimelineView
     * JSON. Mirrors `events` (the same run-gone 404): the live region polls
     * this alongside events.json each tick and replaces the chart's timeline
     * snapshot, so the open bubble extends to now and new segments appear
     * without a page reload. */
    async timeline(context) {
      const runId = context.params.runId;

      try {
        const view = await getTimeline(runId);
        return Response.json(view);
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }
    },

    /** live — GET /runs/:runId/events.sse: the run-scoped change stream.
     * A ghost run 404s (JSON) BEFORE the stream opens — the same run-gone
     * contract as `events`/`timeline`, checked via getRunEvents + isApi404
     * so a browser never holds an open SSE against a run that never existed.
     * Wake-ups only; teardown rides the request signal + stream cancel. */
    async live(context) {
      const runId = context.params.runId;

      try {
        await getRunEvents(runId, { limit: 1 });
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }

      return createSseResponse({
        subscribe: (onChange) => subscribeRun(runId, onChange),
        signal: context.request.signal,
        // prod cadence is SSE_HEARTBEAT_MS; the ?heartbeat_ms= override is only
        // honored under NODE_ENV=test (see heartbeatOverrideMs)
        heartbeatMs: heartbeatOverrideMs(context.url.searchParams.get("heartbeat_ms")),
      });
    },
  },
});

// ── the shared page render (show + control-error re-renders) ────────────────

/**
 * Fetch everything the run detail page needs from the server and render it —
 * the single render path shared by `show` and every control action's error
 * re-render (a failed control POST re-renders the SAME page with the error on
 * the form that submitted it — the page state still comes from the server).
 */
export async function renderRunDetail(
  context: {
    params: { runId: string };
    url: URL;
    render(node: unknown, init?: ResponseInit): Response | Promise<Response>;
  },
  runId: string,
  controlError: ControlError | null = null,
  status = 200,
): Promise<Response> {
  let detail;
  try {
    detail = await getRunDetail(runId);
  } catch (err) {
    if (isApi404(err)) {
      return context.render(<NotFoundPage runId={runId} />, { status: 404 });
    }
    throw err;
  }

  // the ?full=1 detail call carries the full history — the clientEntry's
  // first poll starts from the last rowid and only ever sees what's new
  // (the SSR sweep lives in the api core, not here)
  const history = { events: detail.events ?? [], cursor: detail.next_cursor ?? 0 };

  // R4/R5: the timeline view (per-visit segments, blueprint order — the
  // server derives both). The initial selection comes from the ?phase= deep
  // link (validated; unknown names fall back to auto-select — never crash)
  // and auto-selects the in_progress phase otherwise.
  const timeline = await getTimeline(runId);
  const selection = resolveInitialSelection(timeline, context.url.searchParams.get("phase"));

  // R5 + #41: server-render the INITIAL selection's full card record (one
  // phase only) — envelopes/gates AND the four #35 card surfaces
  // (snapshot/inputs/outputs/spend). The card surfaces come from the shared
  // phase-record view-model (#48/#49: the single phase-record assembler), the
  // same one the phase proxies use; envelopes/gates stay on their server reads.
  // Later selections fetch client-side through the phase proxies.
  let initialEnvelopes: EnvelopeRow[] = [];
  let initialGates: GateResultWithOverride[] = [];
  let initialSnapshot: PhaseSnapshotData | null = null;
  let initialInputs: PhaseInputsData | null = null;
  let initialOutputs: PhaseOutputsData | null = null;
  let initialSpend: PhaseSpendData | null = null;
  if (selection !== null) {
    const [env, gates] = await Promise.all([
      getPhaseEnvelopes(runId, selection),
      getPhaseGates(runId, selection),
    ]);
    initialEnvelopes = env.envelopes;
    initialGates = gates.gates;
    const record = getPhaseRecord(runId, selection);
    if (record !== null) {
      initialSnapshot = record.snapshot;
      initialInputs = record.inputs;
      initialOutputs = record.outputs;
      initialSpend = record.spend;
    }
  }

  // #41: the run-scoped RAW TRANSCRIPT tail (raw_output.jsonl) — SSR seed; the
  // live region refetches raw.json on every SSE change wake-up.
  const initialRaw = await getRaw(runId, { lines: RAW_TAIL_LINES });

  // the pause menu's content comes from the pause viewer; the override
  // select's target gates ride the SAME viewer call (override_targets —
  // the old conditional second phase-gates fetch is gone)
  let pause = null;
  let overrideGates: string[] = [];
  if (detail.run.status === "paused") {
    pause = await getPause(runId);
    overrideGates = pause.override_targets ?? [];
  }

  return context.render(
    <RunDetailPage
      runId={runId}
      detail={detail}
      timeline={timeline}
      initialSelection={selection}
      initialEnvelopes={initialEnvelopes}
      initialGates={initialGates}
      initialSnapshot={initialSnapshot}
      initialInputs={initialInputs}
      initialOutputs={initialOutputs}
      initialSpend={initialSpend}
      initialRaw={initialRaw}
      events={history.events}
      cursor={history.cursor}
      pause={pause}
      overrideGates={overrideGates}
      controlError={controlError}
    />,
    { status },
  );
}

/** The RAW TRANSCRIPT tail size (issue #41) — apiRaw's default is 200; the
 * endpoint caps at 5000. One constant shared by the SSR seed + the proxy. */
const RAW_TAIL_LINES = 200;

/** `cursor` is an integer rowid; anything malformed reads as 0 (the start). */
function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** A client 404 (run missing) — the detail page's "missing run" case. */
function isApi404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ApiError" &&
    (err as { status?: number }).status === 404
  );
}
