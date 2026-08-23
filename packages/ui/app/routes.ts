import { get, route } from "remix/routes";

/**
 * The typed route map (spec §16.12) — the URL contract shared by server
 * actions and browser modules. Only `/` (the run list) is implemented in
 * T09; the run-detail group keeps its §16.12 shape so later tickets
 * (`/runs/:runId`, the events.json cursor proxy, phase drill-in) slot in
 * without renaming anything.
 *
 *   routes.home.href()                       -> "/"
 *   routes.runs.show.href({ runId })         -> "/runs/:runId"
 *   routes.runs.events.href({ runId })       -> "/runs/:runId/events.json"
 *   routes.runs.phases.show.href({ runId, phase }) -> "/runs/:runId/phases/:phase"
 */
export const routes = route({
  // the colocated asset server (remix/assets) — source modules under app/**/public/**
  assets: get("/assets/*path"),
  // §16.6 — the run list
  home: get("/"),
  // §16.7/§16.5 — run detail, the events.json cursor proxy, phase drill-in
  // (later tickets; the stub controllers in app/actions/runs 404 for now)
  runs: {
    show: get("/runs/:runId"),
    events: get("/runs/:runId/events.json"),
    phases: {
      show: get("/runs/:runId/phases/:phase"),
    },
  },
});
