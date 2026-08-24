/**
 * The dashboard's server-side daemon access (`app/lib/daemon.ts`).
 *
 * Since the merged web server (Phase 2) the UI and the daemon share ONE
 * process: the unix socket and the typed client round trip are gone.
 * Every function here calls the corresponding api core function
 * (src/daemon/server.ts) IN-PROCESS against the daemon's state, held by
 * src/daemon/web-state.ts. A "daemon down" state is impossible — there is no
 * socket to miss, so no unreachable-daemon error and no down banner exist.
 *
 * The browser NEVER imports this module and NEVER talks to the daemon: actions
 * fetch daemon data here, server-side, and the browser only receives rendered
 * HTML (no CORS, no daemon credentials in the browser).
 */

import {
  MAX_EVENTS_LIMIT,
  apiApprove,
  apiEvents,
  apiFailRun,
  apiListRuns,
  apiOverrideGate,
  apiPause,
  apiPhaseEnvelopes,
  apiPhaseGates,
  apiPhaseOutputs,
  apiRaw,
  apiRestartFresh,
  apiResume,
  apiRunDetail,
  apiSpend,
  apiStats,
  apiSteerRun,
  apiTimeline,
} from "../../../daemon/server.ts";
import { ApiError } from "../../../daemon/contract.ts";
import { requireWebState } from "../../../daemon/web-state.ts";
import type {
  ControlResult,
  EventsPage,
  PauseView,
  PhaseEnvelopes,
  PhaseGates,
  PhaseOutputs,
  RawTail,
  RunDetail,
  RunListItem,
  RunStats,
  SpendBreakdown,
  TimelineView,
} from "../../../daemon/contract.ts";

/** The events-page size and the sweep batch — the one exported constant the
 * UI's events proxy imports (no re-declared 500 in the controller). */
export { MAX_EVENTS_LIMIT };

/** The run list rows — in-process against the daemon's state. */
export async function listRuns(): Promise<{ runs: RunListItem[] }> {
  return apiListRuns(requireWebState());
}

/** The run detail — phases, spend, envelope count, sessions, and the FULL
 * event history (the initial SSR sweep rides the ?full=1 detail call — the
 * controller reads detail.events/detail.next_cursor instead of sweeping). */
export async function getRunDetail(runId: string): Promise<RunDetail> {
  return apiRunDetail(requireWebState(), runId, new URLSearchParams({ full: "1" }));
}

/** GET /runs/:id/phases/:phase/envelopes — a phase's envelope history. */
export async function getPhaseEnvelopes(runId: string, phase: string): Promise<PhaseEnvelopes> {
  return apiPhaseEnvelopes(requireWebState(), runId, phase);
}

/** GET /runs/:id/phases/:phase/gates — gate results incl. overridden. */
export async function getPhaseGates(runId: string, phase: string): Promise<PhaseGates> {
  return apiPhaseGates(requireWebState(), runId, phase);
}

/** GET /runs/:id/phases/:phase/outputs — what the agent wrote in the
 * phase's outputs dir: the file listing + FINDINGS.md content. */
export async function getPhaseOutputs(runId: string, phase: string): Promise<PhaseOutputs> {
  return apiPhaseOutputs(requireWebState(), runId, phase);
}

/** GET /runs/:id/spend — per-phase spend breakdown (+ estimated markers). */
export async function getSpend(runId: string): Promise<SpendBreakdown> {
  return apiSpend(requireWebState(), runId);
}

/** GET /runs/:id/timeline (R3) — per-visit segments in blueprint order. */
export async function getTimeline(runId: string): Promise<TimelineView> {
  return apiTimeline(requireWebState(), runId);
}

/** GET /api/stats — the all-time landing KPI/chart aggregate. */
export async function getStats(): Promise<RunStats> {
  return apiStats(requireWebState());
}

/** GET /runs/:id/raw?lines=N — the raw_output.jsonl tail (drill-in feed). */
export async function getRaw(runId: string, opts: { lines?: number } = {}): Promise<RawTail> {
  const query = new URLSearchParams();
  if (opts.lines !== undefined) query.set("lines", String(Math.max(1, Math.floor(opts.lines))));
  return apiRaw(requireWebState(), runId, query);
}

/** GET /runs/:id/events — the cursor page (drill-in sums spend). */
export async function getRunEvents(runId: string, opts: { cursor?: number; limit?: number } = {}): Promise<EventsPage> {
  const query = new URLSearchParams();
  if (opts.cursor !== undefined) query.set("cursor", String(opts.cursor));
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  return apiEvents(requireWebState(), runId, query);
}

/** GET /runs/:id/pause — the pause viewer (kind, phase, actions, queued steers). */
export async function getPause(runId: string): Promise<PauseView> {
  return apiPause(requireWebState(), runId);
}

// ── control verbs (T10b) ───────────────────────────────────────────────
// Every verb calls the api core in-process; on success the daemon has
// already written the human_action event and the new run state, so the
// action can re-render/redirect from daemon state. A 409 / 4xx surfaces as a
// server-side ApiError — the actions translate it onto the form.

/** POST /runs/:id/steer — the pause menu's steer (run-keyed; queues on a paused run). */
export async function controlSteer(runId: string, message: string): Promise<ControlResult> {
  return apiSteerRun(requireWebState(), runId, { message });
}

/** POST /runs/:id/resume — continue an interrupted run. */
export async function controlResume(runId: string): Promise<ControlResult> {
  return apiResume(requireWebState(), runId, {});
}

/** POST /runs/:id/fail — fail the run and kill its children. */
export async function controlFail(runId: string): Promise<ControlResult> {
  return apiFailRun(requireWebState(), runId, {});
}

/** POST /runs/:id/approve — approve a require_approval pause. */
export async function controlApprove(runId: string): Promise<ControlResult> {
  return apiApprove(requireWebState(), runId, {});
}

/** POST /runs/:id/phases/:phase/override — override a failed gate (audited).
 * The dashboard audits its overrides as "web" (the daemon defaults to "cli"
 * only for CLI callers that send no by) — the who is the point. */
export async function controlOverrideGate(
  runId: string,
  phase: string,
  gate: string,
  reason: string,
  by: string = "web",
): Promise<ControlResult> {
  return apiOverrideGate(requireWebState(), runId, phase, { gate, reason, by });
}

/** POST /runs/:id/phases/:phase/restart-fresh — new pi session, same config. */
export async function controlRestartFresh(runId: string, phase: string): Promise<ControlResult> {
  return apiRestartFresh(requireWebState(), runId, phase, {});
}

/**
 * Is the thrown error an ApiError? The control actions translate
 * 409/4xx into an inline form error (from ApiError.status/message) instead of
 * pretending success. ONE class since the contract: the server core
 * and the typed client re-export the same ApiError (contract.ts), and
 * in-process calls throw the real one — `instanceof` is the whole check.
 */
export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
