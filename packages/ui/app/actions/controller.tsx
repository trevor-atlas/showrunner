import { createController } from "remix/router";

import { assetServer } from "../assets.ts";
import type { RunListItem } from "../../../daemon/src/client.ts";
import { daemonAddress, DaemonUnreachable, listRuns } from "../lib/daemon.ts";
import { routes } from "../routes.ts";
import { RUN_STATUSES, isRunStatus } from "../ui/status-pill.tsx";
import { RunListPage } from "./run-list-page.tsx";

/**
 * Top-level route actions (spec §16.12). `home` fetches GET /runs
 * SERVER-SIDE through the typed §13 client and renders the run list — the
 * browser never talks to the daemon (no CORS, no daemon credentials in the
 * browser). A down daemon renders the shell with the DaemonDownBanner
 * instead of 500ing; the status filter arrives as a `?status=` GET param.
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

      let runs: RunListItem[] = [];
      let daemonDown = false;
      try {
        const page = await listRuns();
        runs = page.runs;
      } catch (err) {
        if (err instanceof DaemonUnreachable) {
          daemonDown = true;
        } else {
          throw err;
        }
      }

      return context.render(
        <RunListPage
          runs={runs}
          daemonDown={daemonDown}
          daemonAddress={daemonAddress()}
          filter={filter}
          statuses={["all", ...RUN_STATUSES]}
        />,
      );
    },
  },
});
