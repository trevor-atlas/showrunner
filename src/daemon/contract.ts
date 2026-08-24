/**
 * The API's one shared wire contract — the shapes server.ts (producer),
 * client.ts (consumer), and the UI all import, so the compiler — not a
 * structural test — enforces conformance.
 *
 * Imports only `./db.ts` row types and `../core/index.ts` (type-only) —
 * never `server.ts`/`client.ts` — so there is no cycle and the server→client
 * import ban is untouched.
 */

import type {
  AgentSessionRow,
  EnvelopeRow,
  GateResultWithOverride,
  PhaseRow,
  RunRow,
} from "./db.ts";
import type { EventRow, PhaseStartCause, PhaseStatus, RunStatus } from "../core/index.ts";

/**
 * Server-side error: carries the HTTP status code the client sees.
 * Keeps the same `{ name: "ApiError", status, message }` shape the wire
 * honors — ONE class, shared by the server core, the typed client, and the
 * UI (the runtime pin in contract.test.ts asserts they re-export the SAME
 * class).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ── response shapes (the wire contract the server honors) ────────────────

export interface RunListItem extends RunRow {
  spend_usd: number;
  /** 1-based spawn-queue position for pool-queued runs; null when not queued */
  queue_position: number | null;
  phase_counts: Record<string, number>;
}

export interface PhaseSummary extends PhaseRow {
  estimated_spend_usd: number;
}

export interface RunDetail {
  run: RunRow;
  spend_usd: number;
  estimated_spend_usd: number;
  envelope_count: number;
  phases: PhaseSummary[];
  sessions: AgentSessionRow[];
  event_count: number;
}

export interface EventsPage {
  events: EventRow[];
  /** the last rowid returned (or the requested cursor when the page is
   * empty) — pass this as `cursor` on the next poll; the query is idempotent */
  next_cursor: number;
}

export interface PhaseEnvelopes {
  run_id: string;
  phase: string;
  phase_id: string;
  /** ALL attempts (valid and rejected), ordered visit → attempt (T03) */
  envelopes: EnvelopeRow[];
}

export interface PhaseGates {
  run_id: string;
  phase: string;
  phase_id: string;
  /** gate results incl. the override badge (who + why + when) */
  gates: GateResultWithOverride[];
}

export interface SpendBreakdown {
  run_id: string;
  spend_usd: number;
  estimated_spend_usd: number;
  phases: { id: string; name: string; status: string; spend_usd: number; estimated_spend_usd: number }[];
}

// ── R3: the timeline view (GET /runs/:id/timeline) ──────────────────────────
// The server derives per-visit segments by folding the run's phase_start /
// phase_end events (spec R3) — the derivation lives server-side, in one
// tested place. The wire shapes below are the contract apiTimeline honors.

/** Core's zod-validated phase_start cause — structurally identical to the
 * pre-contract client.ts union; the wire shape is the core type itself. */
export type SegmentCause = PhaseStartCause;

export interface TimelineSegment {
  visit: number;
  started_at: string;
  ended_at: string | null; // null = visit still open
  outcome: "in_progress" | "success" | "failed" | "skipped" | "interrupted";
  /** correction events in this visit */
  corrections: number;
  /** envelope events in this visit */
  envelope_attempts: number;
  /** the phase_start payload's cause verbatim; null on runs recorded before R2 */
  cause: SegmentCause | null;
}

export interface TimelinePhase {
  phase_id: string;
  name: string;
  agent: string;
  status: PhaseStatus; // current, from the phases row
  visits: number;
  budget: number;
  spend_usd: number;
  estimated_spend_usd: number;
  /** ordered by visit; empty for pending phases */
  segments: TimelineSegment[];
}

export interface TimelineView {
  run_id: string;
  blueprint: string;
  status: RunStatus;
  needs_review: boolean;
  started_at: string; // ISO-8601 UTC, like everything else
  ended_at: string | null;
  /** blueprint order (same order as RunDetail.phases) */
  phases: TimelinePhase[];
}

export interface RawTail {
  run_id: string;
  /** the last N raw_output.jsonl lines, verbatim, newline-joined */
  raw: string;
  /** the FULL line count of the raw file */
  line_count: number;
  /** true when the tail dropped earlier lines (the file exceeds the requested N) */
  truncated: boolean;
}

export interface PauseView {
  run_id: string;
  paused: boolean;
  status: string;
  kind?: string;
  phase?: string;
  reason?: string | null;
  actions?: string[];
  queued_steers?: string[];
  live_session_id?: string | null;
  note?: string;
}

export interface DaemonStatus {
  ok: boolean;
  pid: number;
  data_dir: string;
  uptime_ms: number;
  pool: { slots: number; running: string[]; queued: string[] };
  runs: Record<string, number>;
}

export interface SubmitRunResult {
  run_id: string;
  queue_position: number | null;
  blueprint?: string; // blueprint runs
  phase_id?: string; // fixture runs
  agent_session_id?: string;
  fixture?: string;
}

export interface ControlResult {
  run_id: string;
  ok: boolean;
  status: string;
  needs_review?: number;
  queued_steers?: number;
  message?: string;
  verb?: string;
}

// ── request bodies (the client's promise — the server validates untrusted
// JSON against these shapes before acting) ───────────────────────────────────

export type SubmitRunBody =
  | { blueprint: string; cwd?: string; args?: string[] }
  | { fixture: string; cwd?: string; delayMs?: number; agent?: string; model?: string; phase?: string };

export interface SteerBody {
  message: string;
  by?: string;
}

export interface EventsQuery {
  cursor?: number;
  limit?: number;
}

export interface RawQuery {
  lines?: number;
}
