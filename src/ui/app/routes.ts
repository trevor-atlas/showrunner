import { get, post, route } from "remix/routes";

/**
 * The typed route map (spec §16.12) — the URL contract shared by server
 * actions and browser modules.
 *
 *   routes.home.href()                                   -> "/"
 *   routes.runs.show.href({ runId })                     -> "/runs/:runId"
 *   routes.runs.events.href({ runId })                   -> "/runs/:runId/events.json"
 *   routes.runs.steer.href({ runId })                    -> "/runs/:runId/steer"   (POST)
 *   routes.runs.resume.href({ runId })                   -> "/runs/:runId/resume"  (POST)
 *   routes.runs.fail.href({ runId })                     -> "/runs/:runId/fail"    (POST)
 *   routes.runs.approve.href({ runId })                  -> "/runs/:runId/approve" (POST)
 *   routes.runs.phases.show.href({ runId, phase })       -> "/runs/:runId/phases/:phase"
 *   routes.runs.phases.override.href({ runId, phase })   -> ".../phases/:phase/override"      (POST)
 *   routes.runs.phases.restart.href({ runId, phase })    -> ".../phases/:phase/restart-fresh" (POST)
 *
 * The POST routes are the remix-server side of the §16.9 control verbs: the
 * browser posts a form here (T10b), the action calls the §13.2 daemon
 * endpoint through the server-side client, then re-renders/redirects from
 * daemon state — the browser never talks to the daemon directly (§16.5).
 * The URLs mirror the daemon's §13.2 surface for readability.
 */
export const routes = route({
  // the colocated asset server (remix/assets) — source modules under app/**/public/**
  assets: get("/assets/*path"),
  // §16.6 — the run list
  home: get("/"),
  // §16.7/§16.5 — run detail, the events.json cursor proxy, the §16.9 control
  // verbs (steer/resume/fail/approve), and the phase drill-in group
  runs: {
    show: get("/runs/:runId"),
    events: get("/runs/:runId/events.json"),
    // §16.9/§13.2 control verbs — one POST route per verb, one form per action
    steer: post("/runs/:runId/steer"),
    resume: post("/runs/:runId/resume"),
    fail: post("/runs/:runId/fail"),
    approve: post("/runs/:runId/approve"),
    phases: {
      show: get("/runs/:runId/phases/:phase"),
      override: post("/runs/:runId/phases/:phase/override"),
      restart: post("/runs/:runId/phases/:phase/restart-fresh"),
    },
  },
});
