import { createController } from "remix/router";

import { assetServer } from "../assets.ts";
import { listRuns } from "../lib/daemon.ts";
import { routes } from "../routes.ts";
import { RUN_STATUSES, isRunStatus } from "../ui/status-pill.tsx";
import { RunListPage } from "./run-list-page.tsx";

/**
 * Top-level route actions (spec §16.12). `home` fetches GET /runs
 * SERVER-SIDE through the §13 api core IN-PROCESS and renders the run list —
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
