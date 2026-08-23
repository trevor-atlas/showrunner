import { createController } from "remix/router";
import { redirect } from "remix/response/redirect";
import { parseSafe } from "remix/data-schema";

import type { EventRow } from "../../../../core/index.ts";

import { readBlueprintSnapshot } from "../../lib/blueprint-snapshot.ts";
import {
  controlApprove,
  controlFail,
  controlResume,
  controlSteer,
  getPhaseGates,
  getPause,
  getRunDetail,
  getRunEvents,
  isApiError,
} from "../../lib/daemon.ts";
import { routes } from "../../routes.ts";
import type { ControlError } from "../../ui/pause-menu.tsx";
import { apiControlError, steerFormSchema, validationError } from "./control-forms.ts";
import type { LivePhase } from "../public/run-live-region.tsx";
import { NotFoundPage, RunDetailPage } from "./run-detail-page.tsx";
import { orderPhases } from "./phase-order.ts";

/**
 * Run-detail group (T10a + T10b, issues #15/#20): `/runs/:runId`, the
 * events.json cursor proxy, and the §16.9 control verbs — the pause menu's
 * steer / approve / fail and the resume HEADER action.
 *
 * `show` fetches the §13 detail endpoint SERVER-SIDE, the FULL event history
 * (the §4.3 cursor query IS the read transport), and — when the run is paused
 * — the §13 pause viewer (kind/phase/actions/queued steers) + the failed gate
 * names for the override select. The browser then polls the proxy from the
 * hydrated live region; it NEVER talks to the daemon.
 *
 * The control actions (§16.9): each validates its form with data-schema (no
 * zod in the UI), posts to the §13.2 api core in-process, then REDIRECTS
 * (303) to the fresh run detail page on success — the re-render comes from
 * daemon state, never from a client-side flip. A validation failure or a
 * daemon 409/4xx re-renders the page with the error on the form that
 * submitted it (no silent drop).
 *
 * `events` is the proxy: GET /runs/:id/events?cursor=N through the §13 api
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

    /** §16.9 steer — POST /runs/:runId/steer → daemon POST /runs/:id/steer. */
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
      // success: the daemon audited + queued the steer; the poll loop resumes
      // automatically on the re-rendered page (§16.9 — no optimistic mutation)
      return redirect(routes.runs.show.href({ runId }), 303);
    },

    /** §16.9 resume — POST /runs/:runId/resume → daemon POST /runs/:id/resume. */
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

    /** §16.9 fail — POST /runs/:runId/fail → daemon POST /runs/:id/fail. */
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

    /** §16.9 approve — POST /runs/:runId/approve → daemon POST /runs/:id/approve. */
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

    async events(context) {
      const runId = context.params.runId;
      const raw = context.url.searchParams.get("cursor");
      const cursor = parseCursor(raw);

      try {
        const page = await getRunEvents(runId, { cursor, limit: EVENTS_PAGE_LIMIT });
        return Response.json({ events: page.events, next_cursor: page.next_cursor });
      } catch (err) {
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }
    },
  },
});

// ── the shared page render (show + control-error re-renders) ────────────────

/**
 * Fetch everything the run detail page needs from the daemon and render it —
 * the single render path shared by `show` and every control action's error
 * re-render (a failed control POST re-renders the SAME page with the error on
 * the form that submitted it — the page state still comes from the daemon).
 */
export async function renderRunDetail(
  context: { params: { runId: string }; render(node: unknown, init?: ResponseInit): Response | Promise<Response> },
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

  // §16.5: the initial load fetches the full history — the clientEntry's
  // first poll starts from the last rowid and only ever sees what's new.
  const history = await collectEvents(runId);

  // §16.7: gantt rows in BLUEPRINT order — the §13.1 phases array is
  // ordered by started_at (SQLite sorts pending NULLs first), so reorder
  // from the §13.3 snapshot (or phase_start events when none exists).
  const snapshot = readBlueprintSnapshot(runId);
  const blueprintOrder = snapshot.doc?.phases.map((p) => p.name) ?? null;
  const livePhases: LivePhase[] = orderPhases(detail.phases, history.events, blueprintOrder).map((p) => ({
    name: p.name,
    agent: p.agent,
    status: p.status,
    corrections: p.corrections,
    visits: p.visits,
    spend_usd: p.spend_usd,
    started_at: p.started_at,
    ended_at: p.ended_at,
  }));

  // §16.9: the pause menu's content comes from the §13 pause viewer; the
  // override select needs the FAILED gate names on the paused phase (fetched
  // only when the menu offers override — one cheap local call).
  let pause = null;
  let overrideGates: string[] = [];
  if (detail.run.status === "paused") {
    pause = await getPause(runId);
    if (pause.paused && (pause.actions ?? []).includes("override") && pause.phase !== undefined && pause.phase !== null) {
      try {
        const gates = await getPhaseGates(runId, pause.phase);
        overrideGates = failedGateNames(gates.gates);
      } catch {
        // a phase that disappeared between the detail fetch and now → the
        // override form simply has no options; the daemon 409s a bad override
        overrideGates = [];
      }
    }
  }

  return context.render(
    <RunDetailPage
      runId={runId}
      detail={detail}
      livePhases={livePhases}
      events={history.events}
      cursor={history.cursor}
      pause={pause}
      overrideGates={overrideGates}
      controlError={controlError}
    />,
    { status },
  );
}

/** The failed gate names on a phase (the override select options), deduped. */
function failedGateNames(gates: readonly { gate: string; pass: number }[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const g of gates) {
    if (g.pass === 0 && !seen.has(g.gate)) {
      seen.add(g.gate);
      names.push(g.gate);
    }
  }
  return names;
}

/** The proxy page size (the daemon caps the cursor query at 500, §4.3). */
const EVENTS_PAGE_LIMIT = 500;

/** Safety cap on the initial full-history sweep (500 × 20 = 10k events). */
const MAX_EVENT_PAGES = 20;

/** Sweep the §4.3 cursor query from 0 to the tail — the full history. */
async function collectEvents(runId: string): Promise<{ events: EventRow[]; cursor: number }> {
  const events: EventRow[] = [];
  let cursor = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = await getRunEvents(runId, { cursor, limit: EVENTS_PAGE_LIMIT });
    events.push(...res.events);
    if (res.events.length < EVENTS_PAGE_LIMIT) {
      cursor = res.next_cursor;
      break;
    }
    cursor = res.next_cursor;
  }
  return { events, cursor };
}

/** `cursor` is an integer rowid; anything malformed reads as 0 (the start). */
function parseCursor(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** A §13 client 404 (run missing) — the detail page's "missing run" case. */
function isApi404(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ApiError" &&
    (err as { status?: number }).status === 404
  );
}
