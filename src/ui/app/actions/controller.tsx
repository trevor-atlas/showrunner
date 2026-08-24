import { createController } from "remix/router";

import { subscribeAll } from "../../../daemon/live.ts";
import { assetServer } from "../assets.ts";
import { listRuns } from "../lib/daemon.ts";
import { createSseResponse, heartbeatOverrideMs } from "../lib/live.ts";
import { routes } from "../routes.ts";
import { RUN_STATUSES, isRunStatus } from "../ui/status-pill.tsx";
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

      const { runs } = await listRuns();

      return context.render(
        <RunListPage
          runs={runs}
          filter={filter}
          statuses={["all", ...RUN_STATUSES]}
        />,
      );
    },
  },
});
