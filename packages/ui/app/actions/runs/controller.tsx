import { createController } from "remix/router";

import type { EventRow } from "@showrunner/core";

import { readBlueprintSnapshot } from "../../lib/blueprint-snapshot.ts";
import { daemonAddress, DaemonUnreachable, getRunDetail, getRunEvents } from "../../lib/daemon.ts";
import { routes } from "../../routes.ts";
import type { LivePhase } from "../public/run-live-region.tsx";
import { NotFoundPage, RunDetailPage } from "./run-detail-page.tsx";
import { orderPhases } from "./phase-order.ts";

/**
 * Run-detail group (T10a, issue #15): `/runs/:runId` and the events.json
 * cursor proxy `/runs/:runId/events.json` (spec §16.5/§16.7/§16.12).
 *
 * `show` fetches the §13 detail endpoint SERVER-SIDE and the FULL event
 * history (the §4.3 cursor query IS the read transport — a paused/completed
 * run renders its whole history; zero server state) and renders the page.
 * The browser then polls the proxy from the hydrated live region.
 *
 * `events` is the proxy: GET /runs/:id/events?cursor=N through the typed
 * client, returned as JSON { events, next_cursor } — the same sliding-window
 * query the daemon serves, re-exposed same-origin (the browser never talks
 * to the daemon). Read-only: no mutation endpoints here (T10b owns those).
 *
 * Missing run → 404 (HTML for the page, JSON for the proxy). Daemon down →
 * page shell with the DaemonDownBanner; the proxy answers 503 so the poll
 * loop keeps its last snapshot and retries.
 */
export default createController(routes.runs, {
  actions: {
    async show(context) {
      const runId = context.params.runId;

      let detail;
      try {
        detail = await getRunDetail(runId);
      } catch (err) {
        if (err instanceof DaemonUnreachable) {
          return context.render(
            <RunDetailPage
              runId={runId}
              detail={null}
              livePhases={[]}
              events={[]}
              cursor={0}
              daemonDown={true}
              daemonAddress={daemonAddress()}
            />,
          );
        }
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

      return context.render(
        <RunDetailPage
          runId={runId}
          detail={detail}
          livePhases={livePhases}
          events={history.events}
          cursor={history.cursor}
          daemonDown={false}
          daemonAddress={daemonAddress()}
        />,
      );
    },

    async events(context) {
      const runId = context.params.runId;
      const raw = context.url.searchParams.get("cursor");
      const cursor = parseCursor(raw);

      try {
        const page = await getRunEvents(runId, { cursor, limit: EVENTS_PAGE_LIMIT });
        return Response.json({ events: page.events, next_cursor: page.next_cursor });
      } catch (err) {
        if (err instanceof DaemonUnreachable) {
          return Response.json({ error: "daemon unavailable" }, { status: 503 });
        }
        if (isApi404(err)) {
          return Response.json({ error: `run ${runId} not found` }, { status: 404 });
        }
        throw err;
      }
    },
  },
});

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
