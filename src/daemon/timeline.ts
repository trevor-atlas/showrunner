// ── R3: the timeline view (GET /runs/:id/timeline) — per-visit segments ─────
// The server derives the segments by folding the run's phase_start/phase_end
// events (the derivation lives in ONE tested place instead of in every
// client). The wire shapes (TimelineView et al.) live in contract.ts — the
// server builds the same shape without importing the client (layering, like
// apiRunDetail).

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  runDirFor,
  type EventRow,
  type PhaseStartCause,
  type PhaseStatus,
  type RunStatus,
} from "../core/index.ts";

import { listEnvelopes, listPhases, listPhaseSpend, sweepRunEvents } from "./db.ts";
import type { PhaseRow, RunRow } from "./db.ts";
import type { TimelineSegment, TimelineView } from "./contract.ts";

/** The event payload slices the fold reads (rows are zod-validated at insert). */
interface PhaseStartPayload {
  phase: string;
  agent: string;
  visit: number;
  budget: number;
  cause?: PhaseStartCause;
}
interface PhaseEndPayload {
  phase: string;
  status: string;
  visits: number;
  corrections: number;
  spend_usd: number;
}
interface CorrectionPayload {
  phase: string;
  visit: number;
}

/**
 * Build the TimelineView for a run — the typed assembler apiTimeline
 * delegates to: collect the events, fold them into per-visit segments with
 * the envelopes-table attempt counts, order the phases (blueprint order via
 * the snapshot, else first phase_start order), and attach the estimated
 * spend. The 404 check stays with the caller (apiTimeline).
 */
export function buildTimelineView(db: Database, dataDir: string, run: RunRow): TimelineView {
  const events = sweepRunEvents(db, run.id);
  // R7 (envelope_attempts): the `envelope` EVENT fires only on ACCEPTANCE
  // — a gate-rejected visit emits none, so event-counting would report 0 for
  // a visit that really attempted. The per-attempt record is the `envelopes`
  // TABLE (one row per attempt, valid or rejected — the same source the phase
  // drill-in's attempt list reads). The fold derives each segment's
  // envelope_attempts from those ROWS per (phase_id, visit).
  const segmentsByPhase = foldPhaseSegments(run, events, countEnvelopeAttempts(db, run.id));
  const ordered = orderTimelinePhases(
    listPhases(db, run.id),
    events,
    readBlueprintPhaseNames(dataDir, run.id),
  );
  const estimatedByPhase = new Map(
    listPhaseSpend(db, run.id).map((r) => [r.id, r.estimated_spend_usd]),
  );

  return {
    run_id: run.id,
    blueprint: run.blueprint,
    // the runs table stores only validated statuses (single-writer daemon) —
    // the narrow cast to the contract's RunStatus/PhaseStatus is honest
    status: run.status as RunStatus,
    needs_review: run.needs_review !== 0,
    started_at: run.started_at,
    ended_at: run.ended_at,
    phases: ordered.map((p) => ({
      phase_id: p.id,
      name: p.name,
      agent: p.agent,
      status: p.status as PhaseStatus,
      visits: p.visits,
      budget: p.budget,
      spend_usd: p.spend_usd,
      estimated_spend_usd: estimatedByPhase.get(p.id) ?? 0,
      segments: segmentsByPhase.get(p.id) ?? [],
    })),
  };
}

/** Per-(phase_id, visit) attempt counts from the `envelopes` table — one row
 * per attempt (valid=1 parsed-and-processed, valid=0 zod-rejected or
 * unreadable), in visit → attempt order (listEnvelopes). The timeline's
 * envelope_attempts counts these ROWS, not `envelope` events (which
 * fire only on acceptance) — a gate-rejected visit still reports its
 * attempts (R7). */
export function countEnvelopeAttempts(db: Database, runId: string): Map<string, Map<number, number>> {
  const counts = new Map<string, Map<number, number>>();
  for (const env of listEnvelopes(db, runId)) {
    let byVisit = counts.get(env.phase_id);
    if (byVisit === undefined) {
      byVisit = new Map<number, number>();
      counts.set(env.phase_id, byVisit);
    }
    byVisit.set(env.visit, (byVisit.get(env.visit) ?? 0) + 1);
  }
  return counts;
}

/**
 * Fold a run's events into per-phase visit segments (R3 derivation rules 1–4):
 *
 * Rule 1 — each phase_start (payload `visit`) pairs with the NEXT phase_end
 * for the same phase_id; the phase_end payload's status is the segment's
 * outcome. Segments are per-phase in rowid order (visits ascend). A redrive
 * from a blocked pause re-enters the visit loop with a NEW visit and emits
 * NO phase_end for the blocked one — the blocked visit stays an open segment
 * (rule 2) exactly as the start/end pairing prescribes.
 *
 * The resume fold: a run resumed from `interrupted` re-visits the
 * RECORDED visit number, so the log can hold TWO phase_start events with the
 * same visit (the crashed visit's start, then the resumed visit's start) and
 * ONE phase_end. A naive "each start pairs with the next end" would render a
 * phantom open segment. When a phase_start arrives for a phase that already
 * has an OPEN segment with the SAME visit, fold it into that segment — keep
 * the ORIGINAL started_at and the FIRST start's cause — instead of opening a
 * duplicate. This preserves rule 1 for the common case and collapses the
 * resume case to one segment per visit.
 *
 * Rules 3/4 — correction EVENTS are attributed to the segment whose VISIT
 * matches (phase_id from the event row, visit from the payload); the
 * segment's envelope_attempts is NOT event-derived — it counts the
 * `envelopes` TABLE rows for that (phase_id, visit) (the envelope
 * event fires only on acceptance, so event-counting would miss rejected
 * visits — R7). `cause` is copied verbatim from the phase_start payload
 * (null when absent — pre-R2 rows are never reconstructed heuristically).
 *
 * Rule 2 is applied AFTER the fold: open segments (no following phase_end)
 * read in_progress while the run is running/paused, interrupted once the run
 * is over (status interrupted, or ended_at set).
 */
export function foldPhaseSegments(
  run: RunRow,
  events: readonly EventRow[],
  envelopeAttempts: Map<string, Map<number, number>>,
): Map<string, TimelineSegment[]> {
  const segments = new Map<string, TimelineSegment[]>();
  for (const ev of events) {
    const phaseId = ev.phase_id;
    if (phaseId === null) continue;
    const segs = segments.get(phaseId);
    const last = segs !== undefined ? segs[segs.length - 1] : undefined;
    switch (ev.type) {
      case "phase_start": {
        const data = ev.data as Partial<PhaseStartPayload>;
        const visit = data.visit ?? 0;
        if (last !== undefined && last.ended_at === null && last.visit === visit) {
          // resume fold — same visit, prior segment still open; keep the
          // original started_at and the FIRST start's cause (rule: no dup)
          break;
        }
        const list = segs ?? [];
        list.push({
          visit,
          started_at: ev.ts,
          ended_at: null,
          outcome: "in_progress",
          corrections: 0,
          envelope_attempts: 0,
          cause: data.cause ?? null,
        });
        segments.set(phaseId, list);
        break;
      }
      case "phase_end": {
        if (last !== undefined && last.ended_at === null) {
          last.ended_at = ev.ts;
          last.outcome = phaseEndOutcome((ev.data as Partial<PhaseEndPayload>).status);
        }
        // a dangling phase_end (no open segment) produces nothing — rule 1
        // pairs starts with ends, never ends alone
        break;
      }
      case "correction": {
        const seg = segmentForVisit(segs, (ev.data as Partial<CorrectionPayload>).visit);
        if (seg !== undefined) seg.corrections += 1;
        break;
      }
    }
  }

  // R7 (envelope_attempts): fold the envelopes-table counts into the segments
  // per (phase_id, visit) — rows exist for EVERY attempt (valid or rejected),
  // where the `envelope` event exists only on acceptance. Corrections
  // stay event-derived above (correction events fire per correction).
  for (const [phaseId, segs] of segments) {
    const byVisit = envelopeAttempts.get(phaseId);
    if (byVisit === undefined) continue;
    for (const seg of segs) {
      seg.envelope_attempts = byVisit.get(seg.visit) ?? 0;
    }
  }

  // Rule 2: open segments read in_progress or interrupted depending on the run
  const runOver = run.status === "interrupted" || run.ended_at !== null;
  for (const segs of segments.values()) {
    for (const seg of segs) {
      if (seg.ended_at === null) seg.outcome = runOver ? "interrupted" : "in_progress";
    }
  }
  return segments;
}

/** The last segment of a phase whose visit matches (visits ascend per phase). */
function segmentForVisit(
  segs: readonly TimelineSegment[] | undefined,
  visit: number | undefined,
): TimelineSegment | undefined {
  if (segs === undefined || visit === undefined) return undefined;
  for (let i = segs.length - 1; i >= 0; i--) {
    if (segs[i]!.visit === visit) return segs[i]!;
  }
  return undefined;
}

/** The segment outcome from a phase_end payload status (the runner writes
 * "success" | "failed"; anything unexpected reads as failed — a terminal
 * status that is not a pass). */
function phaseEndOutcome(status: string | undefined): TimelineSegment["outcome"] {
  if (status === "success" || status === "failed" || status === "skipped" || status === "interrupted") {
    return status;
  }
  return "failed";
}

/**
 * Blueprint-order the phase rows (R3: the endpoint returns blueprint order
 * itself, like the UI's orderPhases but without importing UI code).
 *
 * Preference order, mirroring orderPhases:
 *  1. the blueprint snapshot's phases (exact blueprint order); unknown
 *     detail phases append defensively in phases-row order;
 *  2. fallback (no snapshot — fixture/observation runs): phases that started,
 *     in FIRST phase_start event order, then the row's started_at, then the
 *     phases-row array order.
 *
 * Note the deliberate divergence from the UI helper's fallback: the UI sorts
 * by the LAST phase_start ts (a Map overwrite), which mis-orders a backward
 * on_fail jump (implement re-runs after review failed ⇒ review's last start
 * precedes implement's). First-start is the correct "when this phase entered
 * the run" order and agrees with the UI whenever it matters (sequential runs).
 */
function orderTimelinePhases(
  phases: readonly PhaseRow[],
  events: readonly EventRow[],
  blueprintOrder: readonly string[] | null,
): PhaseRow[] {
  if (blueprintOrder !== null && blueprintOrder.length > 0) {
    const byName = new Map<string, PhaseRow>();
    for (const phase of phases) byName.set(phase.name, phase);
    const ordered: PhaseRow[] = [];
    for (const name of blueprintOrder) {
      const phase = byName.get(name);
      if (phase !== undefined) {
        ordered.push(phase);
        byName.delete(name);
      }
    }
    // any detail phase the snapshot does not mention keeps its row order at
    // the end (the snapshot and the rows should agree)
    for (const phase of phases) {
      if (byName.has(phase.name)) ordered.push(phase);
    }
    return ordered;
  }

  const firstStart = new Map<string, number>();
  for (const ev of events) {
    if (ev.type !== "phase_start") continue;
    const name =
      typeof ev.data === "object" && ev.data !== null ? (ev.data as { phase?: unknown }).phase : undefined;
    if (typeof name !== "string") continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || firstStart.has(name)) continue;
    firstStart.set(name, t);
  }

  return [...phases]
    .map((phase, index) => ({ phase, index }))
    .sort((a, b) => {
      const aStart = firstStart.get(a.phase.name) ?? rowStartTs(a.phase);
      const bStart = firstStart.get(b.phase.name) ?? rowStartTs(b.phase);
      if (aStart !== bStart) return aStart < bStart ? -1 : 1;
      return a.index - b.index;
    })
    .map(({ phase }) => phase);
}

function rowStartTs(phase: PhaseRow): number {
  if (phase.started_at === null) return Infinity;
  const t = Date.parse(phase.started_at);
  return Number.isFinite(t) ? t : Infinity;
}

/** The snapshot's phase names, in blueprint order, or null when the run
 * has no readable snapshot (fixture/observation runs, missing/corrupt file). */
function readBlueprintPhaseNames(dataDir: string, runId: string): string[] | null {
  let text: string;
  try {
    text = readFileSync(join(runDirFor(dataDir, runId), "blueprint.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const phases = (parsed as { phases?: unknown }).phases;
    if (!Array.isArray(phases)) return null;
    const names: string[] = [];
    for (const phase of phases) {
      if (typeof phase === "object" && phase !== null && typeof (phase as { name?: unknown }).name === "string") {
        names.push((phase as { name: string }).name);
      }
    }
    return names;
  } catch {
    return null;
  }
}
