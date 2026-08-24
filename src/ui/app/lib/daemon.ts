/**
 * The dashboard's server-side daemon access (spec §16.10 `app/lib/daemon.ts`).
 *
 * Since the merged web server (Phase 2) the UI and the daemon share ONE
 * process: the unix socket and the typed client round trip are gone.
 * Every function here calls the corresponding §13 api core function
 * (src/daemon/server.ts) IN-PROCESS against the daemon's state, held by
 * src/daemon/web-state.ts. A "daemon down" state is impossible — there is no
 * socket to miss, so no unreachable-daemon error and no down banner exist.
 *
 * The browser NEVER imports this module and NEVER talks to the daemon: actions
 * fetch daemon data here, server-side, and the browser only receives rendered
 * HTML (§16.4/§16.5 — no CORS, no daemon credentials in the browser).
 */

import {
  apiApprove,
  apiEvents,
  apiFailRun,
  apiListRuns,
  apiOverrideGate,
  apiPause,
  apiPhaseEnvelopes,
  apiPhaseGates,
  apiRaw,
  apiRestartFresh,
  apiResume,
  apiRunDetail,
  apiSpend,
  apiSteerRun,
  apiTimeline,
} from "../../../daemon/server.ts";
import { requireWebState } from "../../../daemon/web-state.ts";
import type {
  ControlResult,
  EventsPage,
  PauseView,
  PhaseEnvelopes,
  PhaseGates,
  RawTail,
  RunDetail,
  RunListItem,
  SpendBreakdown,
  TimelineView,
} from "../../../daemon/client.ts";

/** The run list rows (§13.1) — in-process against the daemon's state. */
export async function listRuns(): Promise<{ runs: RunListItem[] }> {
  return apiListRuns(requireWebState()) as { runs: RunListItem[] };
}

/** The run detail — phases, spend, envelope count, sessions (§13.1). */
export async function getRunDetail(runId: string): Promise<RunDetail> {
  return apiRunDetail(requireWebState(), runId) as unknown as RunDetail;
}

/** GET /runs/:id/phases/:phase/envelopes — a phase's envelope history. */
export async function getPhaseEnvelopes(runId: string, phase: string): Promise<PhaseEnvelopes> {
  return apiPhaseEnvelopes(requireWebState(), runId, phase) as unknown as PhaseEnvelopes;
}

/** GET /runs/:id/phases/:phase/gates — gate results incl. overridden. */
export async function getPhaseGates(runId: string, phase: string): Promise<PhaseGates> {
  return apiPhaseGates(requireWebState(), runId, phase) as unknown as PhaseGates;
}

/** GET /runs/:id/spend — per-phase spend breakdown (+ estimated markers). */
export async function getSpend(runId: string): Promise<SpendBreakdown> {
  return apiSpend(requireWebState(), runId) as unknown as SpendBreakdown;
}

/** GET /runs/:id/timeline (R3) — per-visit segments in blueprint order. */
export async function getTimeline(runId: string): Promise<TimelineView> {
  return apiTimeline(requireWebState(), runId) as unknown as TimelineView;
}

/** GET /runs/:id/raw?lines=N — the raw_output.jsonl tail (drill-in feed). */
export async function getRaw(runId: string, opts: { lines?: number } = {}): Promise<RawTail> {
  const query = new URLSearchParams();
  if (opts.lines !== undefined) query.set("lines", String(Math.max(1, Math.floor(opts.lines))));
  return apiRaw(requireWebState(), runId, query) as unknown as RawTail;
}

/** GET /runs/:id/events — the §4.3 cursor page (drill-in sums §6 #12 spend). */
export async function getRunEvents(runId: string, opts: { cursor?: number; limit?: number } = {}): Promise<EventsPage> {
  const query = new URLSearchParams();
  if (opts.cursor !== undefined) query.set("cursor", String(opts.cursor));
  if (opts.limit !== undefined) query.set("limit", String(opts.limit));
  return apiEvents(requireWebState(), runId, query) as EventsPage;
}

/** GET /runs/:id/pause — the §16.9 pause viewer (kind, phase, actions, queued steers). */
export async function getPause(runId: string): Promise<PauseView> {
  return apiPause(requireWebState(), runId) as unknown as PauseView;
}

// ── §13.2 control verbs (T10b) ───────────────────────────────────────────────
// Every verb calls the §13.2 api core in-process; on success the daemon has
// already written the §6 #11 human_action event and the new run state, so the
// action can re-render/redirect from daemon state. A 409 / 4xx surfaces as a
// server-side ApiError — the actions translate it onto the form.

/** POST /runs/:id/steer — the pause menu's steer (run-keyed; queues on a paused run). */
export async function controlSteer(runId: string, message: string): Promise<ControlResult> {
  return apiSteerRun(requireWebState(), runId, { message }) as unknown as ControlResult;
}

/** POST /runs/:id/resume — continue an interrupted run (§12). */
export async function controlResume(runId: string): Promise<ControlResult> {
  return apiResume(requireWebState(), runId, {}) as unknown as ControlResult;
}

/** POST /runs/:id/fail — fail the run and kill its children (§8.3). */
export async function controlFail(runId: string): Promise<ControlResult> {
  return apiFailRun(requireWebState(), runId, {}) as unknown as ControlResult;
}

/** POST /runs/:id/approve — approve a require_approval pause. */
export async function controlApprove(runId: string): Promise<ControlResult> {
  return apiApprove(requireWebState(), runId, {}) as unknown as ControlResult;
}

/** POST /runs/:id/phases/:phase/override — override a failed gate (audited).
 * The dashboard audits its overrides as "web" (the daemon defaults to "cli"
 * only for CLI callers that send no by) — §16.8 the who is the point. */
export async function controlOverrideGate(
  runId: string,
  phase: string,
  gate: string,
  reason: string,
  by: string = "web",
): Promise<ControlResult> {
  return apiOverrideGate(requireWebState(), runId, phase, { gate, reason, by }) as unknown as ControlResult;
}

/** POST /runs/:id/phases/:phase/restart-fresh — new pi session, same config. */
export async function controlRestartFresh(runId: string, phase: string): Promise<ControlResult> {
  return apiRestartFresh(requireWebState(), runId, phase, {}) as unknown as ControlResult;
}

/**
 * Is the thrown error a §13 ApiError? The control actions translate
 * 409/4xx into an inline form error (from ApiError.status/message) instead of
 * pretending success (§16.9). The server-side ApiError (src/daemon/server.ts)
 * keeps the same `{ name: "ApiError", status, message }` shape as the typed
 * client's, so this single check covers both.
 */
export function isApiError(err: unknown): err is { status: number; message: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "ApiError" &&
    typeof (err as { status?: unknown }).status === "number" &&
    typeof (err as { message?: unknown }).message === "string"
  );
}
