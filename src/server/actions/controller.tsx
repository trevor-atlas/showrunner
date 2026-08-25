import { createController } from "remix/router";

import { subscribeAll } from "../transport/change-bus.ts";
import { assetServer } from "../assets.ts";
import { getStats, listRuns } from "../lib/daemon.ts";
import { createSseResponse, heartbeatOverrideMs } from "../lib/live.ts";
import { routes } from "../routes.ts";
import { RUN_STATUSES, isRunStatus } from "../ui/public/status-pill.tsx";
import { RunListPage } from "./run-list-page.tsx";

/**
 * Top-level route actions. `home` fetches GET /runs
 * SERVER-SIDE through the api core IN-PROCESS and renders the run list —
 * the browser never talks to the daemon (no CORS, no daemon credentials in
 * the browser). Since the merged web server the UI and the daemon share one
 * process, so the old "daemon down" shell state is impossible. The status
 * filter arrives as a `?status=` GET param.
 */
export default createController(routes, {
  actions: {
    async assets(context) {
      return (
        (await assetServer.fetch(context.request)) ?? new Response("Not Found", { status: 404 })
      );
    },

    /** live — GET /live.sse: the global change stream (any run). Wake-ups
     * only; the browser refetches from its cursor. Teardown rides the
     * request signal (client disconnect) and the stream cancel. The keepalive
     * cadence is SSE_HEARTBEAT_MS in prod — the ?heartbeat_ms= override is only
     * honored under NODE_ENV=test (see heartbeatOverrideMs), so the prod route
     * is inert to client input. */
    live(context) {
      return createSseResponse({
        subscribe: (onChange) => subscribeAll(onChange),
        signal: context.request.signal,
        heartbeatMs: heartbeatOverrideMs(context.url.searchParams.get("heartbeat_ms")),
      });
    },

    async home(context) {
      const rawFilter = context.url.searchParams.get("status") ?? "all";
      const filter = isRunStatus(rawFilter) ? rawFilter : "all";

      // The initial runs are rendered UNFILTERED into the live clientEntry;
      // the entry applies the ?status= filter at render (so SSR for
      // ?status=failed still shows only failed pills) AND keeps the full set
      // to filter live as the toolbar changes without a round-trip. The
      // landing stats (issue #40) are fetched IN PARALLEL and passed to the
      // RunStatsRegion clientEntry for SSR — the region is all-time and
      // filter-independent, so ?status= never narrows it.
      const [{ runs }, stats] = await Promise.all([listRuns(), getStats()]);

      return context.render(
        <RunListPage
          runs={runs}
          stats={stats}
          filter={filter}
          statuses={["all", ...RUN_STATUSES]}
        />,
      );
    },

    /** homeRuns — GET /runs-list.json: the run-list snapshot proxy the
     * landing clientEntry refetches on every global ledger change. Mirrors
     * the run-scoped events proxy (runs/controller.tsx): listRuns() in-process
     * against daemon state, returned as JSON { runs }. The browser never talks
     * to the daemon — it only refetches this rendered snapshot. */
    async homeRuns() {
      const { runs } = await listRuns();
      return Response.json({ runs });
    },

    /** homeStats — GET /stats.json: the landing stats snapshot proxy the
     * RunStatsRegion clientEntry refetches on every global ledger change.
     * Mirrors homeRuns: getStats() in-process against daemon state, returned
     * as JSON. The browser never talks to the daemon — it only refetches this
     * rendered snapshot. */
    async homeStats() {
      const stats = await getStats();
      return Response.json(stats);
    },
  },
});
