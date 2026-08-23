/**
 * The Gantt model (spec §16.7/§16.5) — pure, no UI. One row per phase in
 * blueprint order; bar fill = fraction of the phase's elapsed time against
 * the run's timeline; completed phases are fully filled in their status
 * color; the in-flight phase's fill and duration are recomputed from
 * `phase_start`/`phase_end` events in the same poll (§16.5 — the gantt and
 * the feed are always one snapshot); pending phases are empty (dimmed).
 *
 * Timeline: the run's started_at is the left edge. While the run is not yet
 * terminal the right edge is "now"; a terminal run ends at ended_at. The
 * vertical NOW cursor sits at the run-relative time while the run is running
 * — and, for a paused run, at the pause moment (the `run_status → paused`
 * event), which is also where the in-flight fill stops (paused phases show
 * the amber edge, §16.7).
 */

/** The phase fields the model needs (a subset of the daemon's PhaseRow). */
export interface GanttPhaseInput {
  name: string;
  agent: string;
  status: string; // pending | in_progress | success | failed | skipped
  corrections: number;
  visits: number;
  spend_usd: number;
  started_at: string | null;
  ended_at: string | null;
}

/** The run fields the model needs (a subset of the daemon's RunRow). */
export interface GanttRunInput {
  started_at: string;
  ended_at: string | null;
  status: string; // running | paused | success | failed | interrupted | queued
}

/** The event fields the model needs (phase_start/phase_end/run_status). */
export interface GanttEventInput {
  type: string;
  ts: string;
  data: unknown;
}

/** The bar color driver — statuses the Gantt renders distinctly. */
export type BarStatus = "success" | "failed" | "skipped" | "in_progress" | "pending";

export interface PhaseBar {
  name: string;
  agent: string;
  status: string;
  corrections: number;
  visits: number;
  spendUsd: number;
  /** fill start as a fraction [0,1] of the run timeline */
  startF: number;
  /** fill end as a fraction [0,1] of the run timeline */
  endF: number;
  /** whether the bar has a visible fill (not a pending/empty row) */
  filled: boolean;
  /** elapsed duration in ms — live for the in-flight phase; null = pending */
  durationMs: number | null;
  /** true when the run is paused on this in-flight phase (amber edge) */
  paused: boolean;
  /** the bar's status color driver */
  barStatus: BarStatus;
}

export interface GanttModel {
  runStartMs: number;
  /** timeline right edge: run.ended_at when terminal, else now */
  runEndMs: number;
  /** the run-relative "now" — Date.now() for a live run */
  nowMs: number;
  /** the NOW cursor position as a timeline fraction */
  nowF: number;
  /** render the NOW cursor? — only while the run is not yet terminal */
  showCursor: boolean;
  phases: PhaseBar[];
}

/** Build the Gantt model for one render (server load or every poll). */
export function computeGantt(
  phases: readonly GanttPhaseInput[],
  run: GanttRunInput,
  events: readonly GanttEventInput[],
  now = Date.now(),
): GanttModel {
  const runStartMs = Date.parse(run.started_at);
  const terminal = run.ended_at !== null && run.ended_at !== undefined;
  const runEndMs = terminal ? Date.parse(run.ended_at!) : now;
  const span = Math.max(1, runEndMs - runStartMs);
  const frac = (ms: number): number => clamp01((ms - runStartMs) / span);

  // Event facts: phase_start/phase_end timestamps per phase name, and the
  // last run_status → paused moment (the fill edge while the run is paused).
  const startTs = new Map<string, number>();
  const endTs = new Map<string, number>();
  let pauseTs: number | null = null;
  for (const ev of events) {
    const t = Date.parse(ev.ts);
    if (ev.type === "phase_start") {
      const phase = (ev.data as { phase?: unknown }).phase;
      if (typeof phase === "string" && !startTs.has(phase)) startTs.set(phase, t);
    } else if (ev.type === "phase_end") {
      const phase = (ev.data as { phase?: unknown }).phase;
      if (typeof phase === "string") endTs.set(phase, t);
    } else if (ev.type === "run_status") {
      const to = (ev.data as { to?: unknown }).to;
      if (to === "paused") pauseTs = t;
    }
  }

  const runPaused = run.status === "paused";
  const bars: PhaseBar[] = phases.map((p) => {
    const startMs = p.started_at !== null ? Date.parse(p.started_at) : (startTs.get(p.name) ?? null);
    const endMs = p.ended_at !== null ? Date.parse(p.ended_at) : (endTs.get(p.name) ?? null);
    const barStatus = barStatusFor(p.status);
    const pending = p.status === "pending" || startMs === null;

    let fillEndMs: number | null = null;
    let durationMs: number | null = null;
    if (endMs !== null) {
      fillEndMs = endMs;
      durationMs = Math.max(0, endMs - (startMs ?? runStartMs));
    } else if (startMs !== null) {
      // in-flight: fills to now, or to the pause moment while paused (§16.7
      // — a paused phase stops progressing; the amber edge marks it)
      const liveEnd = runPaused && pauseTs !== null ? pauseTs : now;
      fillEndMs = Math.max(startMs, liveEnd);
      durationMs = Math.max(0, fillEndMs - startMs);
    }

    const startF = startMs !== null ? frac(startMs) : 0;
    const endF = fillEndMs !== null ? frac(fillEndMs) : 0;

    return {
      name: p.name,
      agent: p.agent,
      status: p.status,
      corrections: p.corrections,
      visits: p.visits,
      spendUsd: p.spend_usd,
      startF,
      endF,
      filled: !pending && fillEndMs !== null,
      durationMs,
      paused: runPaused && p.status === "in_progress",
      barStatus,
    };
  });

  // The NOW cursor: for a paused run it marks the pause moment (same point
  // the in-flight fill stops at); for a running run, now == the timeline end.
  const cursorMs = runPaused && pauseTs !== null ? pauseTs : now;
  const nowF = frac(cursorMs);
  const showCursor = run.status === "running" || run.status === "paused";

  return { runStartMs, runEndMs, nowMs: now, nowF, showCursor, phases: bars };
}

/** Map a phase row status to the bar's color driver. */
export function barStatusFor(status: string): BarStatus {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "in_progress") return "in_progress";
  return "pending";
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}
