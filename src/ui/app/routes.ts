import { get, post, route } from "remix/routes";

/**
 * The typed route map — the URL contract shared by server
 * actions and browser modules.
 *
 *   routes.home.href()                                   -> "/"
 *   routes.runs.show.href({ runId })                     -> "/runs/:runId"
 *   routes.runs.events.href({ runId })                   -> "/runs/:runId/events.json"
 *   routes.runs.timeline.href({ runId })                 -> "/runs/:runId/timeline.json" (R6 refetch)
 *   routes.runs.steer.href({ runId })                    -> "/runs/:runId/steer"   (POST)
 *   routes.runs.resume.href({ runId })                   -> "/runs/:runId/resume"  (POST)
 *   routes.runs.fail.href({ runId })                     -> "/runs/:runId/fail"    (POST)
 *   routes.runs.approve.href({ runId })                  -> "/runs/:runId/approve" (POST)
 *   routes.runs.phases.show.href({ runId, phase })       -> "/runs/:runId/phases/:phase"
 *   routes.runs.phases.envelopes.href({ runId, phase })  -> ".../phases/:phase/envelopes.json"
 *   routes.runs.phases.gates.href({ runId, phase })      -> ".../phases/:phase/gates.json"
 *   routes.runs.phases.override.href({ runId, phase })   -> ".../phases/:phase/override"      (POST)
 *   routes.runs.phases.restart.href({ runId, phase })    -> ".../phases/:phase/restart-fresh" (POST)
 *
 * The POST routes are the remix-server side of the control verbs: the
 * browser posts a form here (T10b), the action calls the daemon
 * endpoint through the server-side client, then re-renders/redirects from
 * daemon state — the browser never talks to the daemon directly.
 * The URLs mirror the daemon's surface for readability.
 */
export const routes = route({
  // the colocated asset server (remix/assets) — source modules under app/**/public/**
  assets: get("/assets/*path"),
  // — the global SSE change stream (any run) — wake-ups only, no payload
  live: get("/live.sse"),
  // — the run list
  home: get("/"),
  // — run detail, the events.json cursor proxy, the control
  // verbs (steer/resume/fail/approve), and the phase drill-in group
  runs: {
    show: get("/runs/:runId"),
    events: get("/runs/:runId/events.json"),
    // the run-scoped SSE change stream — wake-ups only, no payload
    live: get("/runs/:runId/events.sse"),
    // R6: the timeline.json refetch proxy — the live region polls this
    // alongside events.json every tick so the chart re-derives from daemon
    // state (new segments, closed visits, status/ended_at) between refreshes
    timeline: get("/runs/:runId/timeline.json"),
    // control verbs — one POST route per verb, one form per action
    steer: post("/runs/:runId/steer"),
    resume: post("/runs/:runId/resume"),
    fail: post("/runs/:runId/fail"),
    approve: post("/runs/:runId/approve"),
    phases: {
      show: get("/runs/:runId/phases/:phase"),
      // R5: the lazy envelopes/gates proxies — the browser fetches a selected
      // phase's data through these remix routes (never the daemon directly),
      // mirroring the events.json cursor proxy pattern
      envelopes: get("/runs/:runId/phases/:phase/envelopes.json"),
      gates: get("/runs/:runId/phases/:phase/gates.json"),
      // the phase-card data proxies (issue #35) — the browser fetches each
      // card's data through these remix routes, never the daemon/fs directly
      snapshot: get("/runs/:runId/phases/:phase/snapshot.json"),
      inputs: get("/runs/:runId/phases/:phase/inputs.json"),
      outputs: get("/runs/:runId/phases/:phase/outputs.json"),
      spend: get("/runs/:runId/phases/:phase/spend.json"),
      override: post("/runs/:runId/phases/:phase/override"),
      restart: post("/runs/:runId/phases/:phase/restart-fresh"),
    },
  },
});
